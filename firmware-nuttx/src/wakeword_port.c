/* MN7 独占一个固定 PSRAM 子堆；分配失败在同一 C worker 中退出并统一回收。 */
#include "pixelbox_mn7_memory.h"
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <nuttx/mm/mm.h>
#ifdef __NuttX__
#include <nuttx/config.h>
#include <malloc.h>
#include <arch/arch.h>
#include <syslog.h>
#if !defined(CONFIG_ARCH_SETJMP_H)
#error "MultiNet7 OOM recovery requires CONFIG_ARCH_SETJMP_H=y"
#endif
#if !defined(CONFIG_ESP32S3_SPIRAM) || !defined(CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP)
#error "MultiNet7 requires ESP32S3 PSRAM and the separate internal memory heap"
#endif

/*
 * NuttX 的普通用户堆可能同时包含内部 DRAM 和 PSRAM，不能用 memalign()
 * 取得满足模型要求的连续 PSRAM。把 MN7 工作区固定放进 linker 明确映射
 * 到 PSRAM 的 .ext_ram.bss，避免启动后与通用 PSRAM heap 交叉管理。
 */
extern uint8_t _ext_ram_bss_start[];
extern uint8_t _ext_ram_bss_end[];
__attribute__((section(".ext_ram.bss"), aligned(16), used))
static uint8_t mn7_backing[PX_MN7_WORKSPACE_BYTES];
#endif
#ifdef PX_MULTINET7
#include "wakeword/library_state.h"
#else
/* 主机测试只替代 Xtensa 归档的六个状态字，分配器仍编译真实 NuttX 源码。 */
void px_mn7_library_state_reset(void);
#endif
#ifdef PX_MN7_MEMORY_TEST
#include "wakeword_memory_backend.h"
#endif

enum {
  CAP_8BIT = 1u << 2, CAP_DMA = 1u << 3, CAP_SPIRAM = 1u << 10,
  CAP_INTERNAL = 1u << 11, CAP_DEFAULT = 1u << 12, CAP_SIMD = 1u << 20
};
struct allocation {
  struct allocation *previous, *next;
  void *base, *user;
  size_t size, charged;
  uint32_t magic;
  bool internal;
};
struct model_mutex {
  pthread_mutex_t native;
  struct model_mutex *next;
  bool held;
};
static pthread_mutex_t session_lock = PTHREAD_MUTEX_INITIALIZER;
/* setjmp 后变化的状态保存在静态对象，避免读取 longjmp 后不确定的自动变量。 */
static struct {
  pthread_t owner;
  bool active, guarded;
  jmp_buf recovery;
  void *backing;
  struct mm_heap_s *heap;
  struct allocation *allocations;
  struct model_mutex *mutexes;
  struct px_mn7_memory_stats stats;
} memory;

static bool owns_session(void)
{
  return memory.active && pthread_equal(memory.owner, pthread_self());
}
static void *failure(int error, size_t size, uint32_t caps)
{
  errno = error;
  if (owns_session() && memory.guarded) {
    memory.stats.error = -error;
    memory.stats.failed_size = size;
    memory.stats.failed_caps = caps;
    longjmp(memory.recovery, 1);
  }
  return NULL;
}
static bool psram_region(const void *base, size_t size)
{
  uintptr_t start;
#ifdef PX_MN7_MEMORY_TEST
  start = px_mn7_test_psram_address(base);
#else
  start = (uintptr_t)base;
  uintptr_t region_start = (uintptr_t)_ext_ram_bss_start;
  uintptr_t region_end = (uintptr_t)_ext_ram_bss_end;
  return region_end >= region_start && start >= region_start &&
         start <= region_end && size <= region_end - start;
#endif
  return start >= 0x3c000000u && start < 0x3e000000u && size <= 0x3e000000u - start;
}
static void *backing_allocate(void)
{
#ifdef PX_MN7_MEMORY_TEST
  return px_mn7_test_backing_allocate(PX_MN7_WORKSPACE_BYTES);
#else
  return mn7_backing;
#endif
}
static void backing_free(void *p)
{
#ifdef PX_MN7_MEMORY_TEST
  px_mn7_test_backing_free(p);
#else
  /* 静态 .ext_ram.bss backing 随镜像生命周期存在，不能交给通用堆释放。 */
  (void)p;
#endif
}
static void *internal_allocate(size_t alignment, size_t size)
{
#ifdef PX_MN7_MEMORY_TEST
  return px_mn7_test_internal_allocate(alignment, size);
#else
  return xtensa_imm_memalign(alignment, size);
#endif
}
static void internal_free(void *p)
{
#ifdef PX_MN7_MEMORY_TEST
  px_mn7_test_internal_free(p);
#else
  xtensa_imm_free(p);
#endif
}
static bool internal_member(void *p)
{
#ifdef PX_MN7_MEMORY_TEST
  return px_mn7_test_internal_member(p);
#else
  return xtensa_imm_heapmember(p);
#endif
}

void *heap_caps_aligned_alloc(size_t alignment, size_t size, uint32_t caps)
{
  if (!owns_session()) return failure(EPERM, size, caps);
  if (!alignment || (alignment & (alignment - 1)) ||
      (caps & ~(uint32_t)(CAP_8BIT | CAP_DMA | CAP_SPIRAM | CAP_INTERNAL | CAP_DEFAULT | CAP_SIMD)) ||
      ((caps & CAP_SPIRAM) && (caps & (CAP_INTERNAL | CAP_DMA)))) return failure(EINVAL, size, caps);
  if (alignment < 16) alignment = 16;
  if (alignment > SIZE_MAX - sizeof(struct allocation)) return failure(EOVERFLOW, size, caps);
  size_t prefix = (sizeof(struct allocation) + alignment - 1) & ~(alignment - 1);
  if (size > SIZE_MAX - prefix) return failure(EOVERFLOW, size, caps);
  if (!size) size = 1;
  size_t total = prefix + size;
  bool internal = (caps & (CAP_INTERNAL | CAP_DMA)) != 0;
#ifdef PX_MN7_MEMORY_TEST
  if (px_mn7_test_allocation_fail()) return failure(ENOMEM, size, caps);
#endif
  /* 只有明确 INTERNAL/DMA 能力走独立内部堆，其余小块也必须来自 PSRAM 子堆。 */
  void *base = internal ? internal_allocate(alignment, total) : mm_memalign(memory.heap, alignment, total);
  if (!base) return failure(ENOMEM, size, caps);
  void *user = (char *)base + prefix;
  struct allocation *node = (struct allocation *)((char *)user - sizeof(*node));
  *node = (struct allocation){.next = memory.allocations, .base = base, .user = user,
                             .size = size, .charged = internal ? total : mm_malloc_size(memory.heap, base),
                             .internal = internal, .magic = 0x4d4e3741u};
  if (node->next) node->next->previous = node;
  memory.allocations = node;
  size_t *live = internal ? &memory.stats.internal_live : &memory.stats.psram_live;
  size_t *peak = internal ? &memory.stats.internal_peak : &memory.stats.psram_peak;
  *live += size; if (*live > *peak) *peak = *live;
  memory.stats.overhead_live += node->charged - size;
  if (memory.stats.overhead_live > memory.stats.overhead_peak) memory.stats.overhead_peak = memory.stats.overhead_live;
  ++memory.stats.allocations; ++memory.stats.live_blocks;
  return user;
}
void *heap_caps_malloc(size_t size, uint32_t caps) { return heap_caps_aligned_alloc(16, size, caps); }
void *heap_caps_calloc(size_t count, size_t size, uint32_t caps)
{
  if (count && size > SIZE_MAX / count) return failure(EOVERFLOW, size, caps);
  void *p = heap_caps_malloc(count * size, caps);
  if (p) memset(p, 0, count * size);
  return p;
}
static struct allocation *find_allocation(void *p)
{
  if (!owns_session() || !p) return NULL;
  uintptr_t address = (uintptr_t)p, start = (uintptr_t)memory.backing;
  if (address >= start && address - start >= sizeof(struct allocation) && address - start < PX_MN7_WORKSPACE_BYTES && !(address % 16)) {
    struct allocation *node = (struct allocation *)((char *)p - sizeof(*node));
    return node->magic == 0x4d4e3741u && node->user == p ? node : NULL;
  }
  /* 内部块数量少；不读取不属于本会话的内部堆块前缀。 */
  for (struct allocation *node = memory.allocations; node; node = node->next)
    if (node->user == p) return node;
  return NULL;
}
static void release(struct allocation *node)
{
  if (node->previous) node->previous->next = node->next; else memory.allocations = node->next;
  if (node->next) node->next->previous = node->previous;
  if (node->internal) memory.stats.internal_live -= node->size; else memory.stats.psram_live -= node->size;
  memory.stats.overhead_live -= node->charged - node->size; --memory.stats.live_blocks;
  void *base = node->base; bool internal = node->internal;
  node->magic = 0; node->user = NULL;
  if (internal) internal_free(base); else mm_free(memory.heap, base);
}
void heap_caps_free(void *p)
{
  if (!p) return;
  struct allocation *node = find_allocation(p);
  if (node) { release(node); return; }
  if (owns_session() && (uintptr_t)p >= (uintptr_t)memory.backing &&
      (uintptr_t)p - (uintptr_t)memory.backing < PX_MN7_WORKSPACE_BYTES) {
    failure(EINVAL, 0, CAP_SPIRAM); return;
  }
  /* 原库释放入口仍兼容不属于本会话的普通块和内部块，不能交错两个堆。 */
  if (internal_member(p)) internal_free(p); else free(p);
}
void px_mn7_free(void *p) { heap_caps_free(p); }
void *px_mn7_malloc(size_t size) { return heap_caps_malloc(size, CAP_DEFAULT); }
void *px_mn7_calloc(size_t count, size_t size) { return heap_caps_calloc(count, size, CAP_DEFAULT); }
void *px_mn7_realloc(void *p, size_t size)
{
  if (!p) return px_mn7_malloc(size);
  if (!size) { px_mn7_free(p); return NULL; }
  struct allocation *node = find_allocation(p);
  if (!node) return failure(EINVAL, size, CAP_DEFAULT);
  void *next = heap_caps_malloc(size, node->internal ? CAP_INTERNAL : CAP_DEFAULT);
  if (next) { memcpy(next, p, node->size < size ? node->size : size); px_mn7_free(p); }
  return next;
}
char *px_mn7_strdup(const char *text)
{
  if (!text) return failure(EINVAL, 0, CAP_DEFAULT);
  size_t size = strlen(text) + 1;
  char *copy = px_mn7_malloc(size); if (copy) memcpy(copy, text, size); return copy;
}
FILE *px_mn7_fopen(const char *path, const char *mode)
{
  (void)path; (void)mode;
  /* 本移植只接受只读 Flash 归档；禁止未登记的 FILE 进入可跳出的调用链。 */
  return failure(ENOTSUP, 0, 0);
}

void *xQueueCreateMutex(unsigned char type)
{
  if (type != 1) return failure(EINVAL, 0, 0);
  struct model_mutex *lock = px_mn7_calloc(1, sizeof(*lock));
  if (!lock) return NULL;
  int error = pthread_mutex_init(&lock->native, NULL);
  if (error) { px_mn7_free(lock); return failure(error, sizeof(*lock), CAP_DEFAULT); }
  lock->next = memory.mutexes; memory.mutexes = lock;
  return lock;
}
int xQueueSemaphoreTake(void *queue, uint32_t ticks)
{
  struct model_mutex *lock = queue;
  if (!lock || !owns_session()) return 0;
  int error;
  if (ticks == UINT32_MAX) error = pthread_mutex_lock(&lock->native);
  else if (!ticks) error = pthread_mutex_trylock(&lock->native);
  else {
    struct timespec until; clock_gettime(CLOCK_REALTIME, &until);
#ifdef CONFIG_USEC_PER_TICK
    uint64_t ns = (uint64_t)ticks * CONFIG_USEC_PER_TICK * 1000;
#else
    uint64_t ns = (uint64_t)ticks * 1000000;
#endif
    ns += (uint64_t)until.tv_nsec;
    until.tv_sec += (time_t)(ns / 1000000000); until.tv_nsec = (long)(ns % 1000000000);
#ifdef __APPLE__
    do {
      error = pthread_mutex_trylock(&lock->native);
      if (error != EBUSY) break;
      struct timespec now; clock_gettime(CLOCK_REALTIME, &now);
      if (now.tv_sec > until.tv_sec || (now.tv_sec == until.tv_sec && now.tv_nsec >= until.tv_nsec)) break;
      struct timespec delay = {0, 1000000}; nanosleep(&delay, NULL);
    } while (1);
#else
    error = pthread_mutex_timedlock(&lock->native, &until);
#endif
  }
  if (!error) lock->held = true;
  return error == 0;
}
int xQueueGenericSend(void *queue, const void *item, uint32_t ticks, int position)
{
  (void)ticks; struct model_mutex *lock = queue;
  if (!lock || item || position != 0 || !owns_session()) return 0;
  int error = pthread_mutex_unlock(&lock->native);
  if (!error) lock->held = false;
  return error == 0;
}
void vQueueDelete(void *queue)
{
  if (!queue || !owns_session()) return;
  struct model_mutex **link = &memory.mutexes;
  while (*link && *link != queue) link = &(*link)->next;
  if (!*link) return;
  struct model_mutex *lock = *link;
  int error = lock->held ? pthread_mutex_unlock(&lock->native) : 0;
  if (!error) {
    lock->held = false;
#ifdef PX_MN7_MEMORY_TEST
    error = px_test_mutex_destroy_fail ? EBUSY : pthread_mutex_destroy(&lock->native);
#else
    error = pthread_mutex_destroy(&lock->native);
#endif
  }
  if (error) { memory.stats.cleanup_error = -error; return; }
  *link = lock->next; px_mn7_free(lock);
}

int px_mn7_memory_run(int (*callback)(void *), void *argument, struct px_mn7_memory_stats *stats)
{
  if (!callback || !stats) return -EINVAL;
  memset(stats, 0, sizeof(*stats));
  if (pthread_mutex_trylock(&session_lock)) return -EBUSY;
  memset(&memory, 0, sizeof(memory)); memory.owner = pthread_self(); memory.stats.budget = PX_MN7_WORKSPACE_BYTES;
  memory.stats.failed_size = PX_MN7_WORKSPACE_BYTES; memory.stats.failed_caps = CAP_SPIRAM;
  memory.backing = backing_allocate();
  if (!memory.backing) { memory.stats.error = -ENOMEM; goto finished; }
  if (!psram_region(memory.backing, PX_MN7_WORKSPACE_BYTES)) { memory.stats.error = -EFAULT; goto finished; }
  memory.heap = mm_initialize("mn7", memory.backing, PX_MN7_WORKSPACE_BYTES);
  if (!memory.heap) { memory.stats.error = -ENOMEM; goto finished; }
  memory.stats.heap_initial = mm_mallinfo(memory.heap).uordblks;
  memory.stats.failed_size = 0; memory.stats.failed_caps = 0;
  memory.active = true;
  px_mn7_library_state_reset();
  if (setjmp(memory.recovery) == 0) {
    memory.guarded = true;
    memory.stats.error = callback(argument);
  }
  memory.guarded = false;
  /* 回收先清空所有可变库指针，不遍历半初始化图，也不调用半成品 destroy。 */
  px_mn7_library_state_reset(); px_mn7_commands_forget(); px_mn7_model_forget();
  while (memory.mutexes) {
    struct model_mutex *lock = memory.mutexes;
    vQueueDelete(lock);
    if (memory.mutexes == lock) break;
  }
  struct mallinfo info = mm_mallinfo(memory.heap);
  memory.stats.heap_peak = info.usmblks;
  memory.stats.heap_free = info.fordblks; memory.stats.heap_largest = info.mxordblk;
  /* 不隐瞒无法销毁的锁；保留其堆和busy门，禁止释放仍被使用的存储。 */
  if (memory.stats.cleanup_error) {
    memory.stats.error = memory.stats.cleanup_error; *stats = memory.stats;
    return memory.stats.error;
  }
  while (memory.allocations) { ++memory.stats.reclaimed; release(memory.allocations); }
  memory.active = false; mm_uninitialize(memory.heap); memory.heap = NULL;
finished:
  if (memory.backing) { backing_free(memory.backing); memory.backing = NULL; }
  *stats = memory.stats; pthread_mutex_unlock(&session_lock);
  return stats->error;
}

void esp_log(uint32_t config, const char *tag, const char *format, ...)
{
  (void)config; (void)tag;
  if (!format) return;
  va_list ap;
  va_start(ap, format);
  vprintf(format, ap);
  va_end(ap);
  fflush(stdout);
#ifdef __NuttX__
  char message[1024];
  va_start(ap, format);
  (void)vsnprintf(message, sizeof(message), format, ap);
  va_end(ap);
  char line[sizeof(message) + 96];
  (void)snprintf(line, sizeof(line), "[pixelbox][mn7]%s%s%s%s",
                 tag && *tag ? "[" : "", tag && *tag ? tag : "",
                 tag && *tag ? "] " : "", message);
  syslog(LOG_INFO, "%s", line);
#endif
}
