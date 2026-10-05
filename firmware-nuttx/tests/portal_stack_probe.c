/* 宿主写入高水位：上下PROT_NONE保护页，join之后才读取sentinel和释放映射。
 * 此结果包含宿主pthread/QuickJS调用栈，不等于Xtensa线程栈或无线闭源驱动峰值。 */
#include "portal_stack_probe.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#if !defined(__APPLE__) && !defined(__linux__)
#error "stack probe requires mmap/pthread stack support on macOS or Linux"
#endif
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS MAP_ANON
#endif
struct probe {
  void *mapping;
  uint8_t *stack;
  size_t bytes, requested, total;
  pthread_t thread;
  bool active;
};
static struct probe probes[4];
static pthread_mutex_t probe_lock = PTHREAD_MUTEX_INITIALIZER;

/* 本测试的sentinel扫描针对向低地址增长的栈，显式核对，避免其它ABI静默算反。 */
__attribute__((noinline)) static bool grows_down(const volatile uint8_t *outer)
{
  volatile uint8_t inner = 0;
  return (uintptr_t)&inner < (uintptr_t)outer;
}
int px_stack_probe_create(pthread_t *thread, const pthread_attr_t *attributes,
                          void *(*entry)(void *), void *argument, size_t requested)
{
  volatile uint8_t marker = 0;
  assert(grows_down(&marker));
  int detach; assert(!pthread_attr_getdetachstate(attributes, &detach));
  assert(detach == PTHREAD_CREATE_JOINABLE);
  long page_value = sysconf(_SC_PAGESIZE), minimum = sysconf(_SC_THREAD_STACK_MIN);
  assert(page_value > 0 && minimum > 0);
  size_t page = (size_t)page_value, bytes = requested;
  if (bytes < (size_t)minimum) bytes = (size_t)minimum;
  bytes = (bytes + page - 1) / page * page;
  size_t total = bytes + 2 * page;
  void *mapping = mmap(NULL, total, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(mapping != MAP_FAILED);
  uint8_t *stack = (uint8_t *)mapping + page;
  assert(!mprotect(mapping, page, PROT_NONE));
  assert(!mprotect(stack + bytes, page, PROT_NONE));
  memset(stack, 0xa5, bytes);
  pthread_attr_t measured; assert(!pthread_attr_init(&measured));
  assert(!pthread_attr_setstack(&measured, stack, bytes));
  int result = pthread_create(thread, &measured, entry, argument);
  assert(!pthread_attr_destroy(&measured));
  if (result) { assert(!munmap(mapping, total)); return result; }
  pthread_mutex_lock(&probe_lock);
  unsigned slot = 0; while (slot < 4 && probes[slot].active) ++slot;
  assert(slot < 4);
  probes[slot] = (struct probe){mapping, stack, bytes, requested, total, *thread, true};
  pthread_mutex_unlock(&probe_lock);
  return 0;
}
int px_stack_probe_join(pthread_t thread, void **value)
{
  int result = pthread_join(thread, value);
  if (result) return result;
  pthread_mutex_lock(&probe_lock);
  unsigned slot = 0;
  while (slot < 4 && (!probes[slot].active || !pthread_equal(probes[slot].thread, thread))) ++slot;
  assert(slot < 4);
  struct probe *probe = &probes[slot];
  size_t untouched = 0;
  while (untouched < probe->bytes && probe->stack[untouched] == 0xa5) ++untouched;
  const char *path = getenv("PX_PORTAL_STACK_LOG"); assert(path && *path);
  FILE *file = fopen(path, "a"); assert(file);
  assert(fprintf(file, "{\"requested_bytes\":%zu,\"stack_bytes\":%zu,\"used_bytes\":%zu,\"free_bytes\":%zu}\n",
                 probe->requested, probe->bytes, probe->bytes - untouched, untouched) > 0);
  assert(!fclose(file));
  assert(!munmap(probe->mapping, probe->total)); probe->active = false;
  pthread_mutex_unlock(&probe_lock);
  return 0;
}
