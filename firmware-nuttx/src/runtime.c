#ifdef __NuttX__
#  include <nuttx/config.h>
#  include <malloc.h>
#  include <sys/boardctl.h>
#  ifdef CONFIG_ESP32S3_EFUSE
#    include <nuttx/efuse/efuse.h>
#    include <sys/ioctl.h>
#  endif
#endif
#include "pixelbox.h"
#include "pixelbox_watchdog.h"
#include "pixelbox_mic.h"
#include "pixelbox_audio.h"
#ifdef PX_MULTINET7
#  include "pixelbox_wakeword.h"
#endif
#include "pixelbox_service.h"
#include "pixelbox_system_keys.h"
#include "pixelbox_builtin_apps.h"
#ifdef __NuttX__
#  include "pixelbox_board.h"
#endif
#include "quickjs.h"
#include "prelude_core.h"
#include "prelude_nuttx.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>
#ifdef __NuttX__
#  include <syslog.h>
#endif

#ifndef PATH_MAX
#  define PATH_MAX 512
#endif
#ifndef CONFIG_INTERPRETERS_PIXELBOX_STACKSIZE
#  define CONFIG_INTERPRETERS_PIXELBOX_STACKSIZE (64 * 1024)
#endif

/* 硬限制阻止脚本用文件或定时器绕开 QuickJS 堆上限。 */
#define PX_MAX_FILE (8 * 1024 * 1024)
#define PX_MAX_TIMERS 128
#define PX_MAX_TIMER_ARGS 16
#define PX_MAX_REJECTIONS 32

/* 屏幕、音频等外设为设备全局资源，NSH诊断与托管应用不能并行创建两个VM。 */
static pthread_mutex_t vm_lock = PTHREAD_MUTEX_INITIALIZER;

struct px_timer {
  int id;
  double at;
  double interval;
  JSValue callback;
  int argc;
  JSValue args[PX_MAX_TIMER_ARGS];
};

struct px_runtime {
  JSRuntime *rt;
  JSContext *ctx;
  const struct px_options *options;
  struct px_timer timers[PX_MAX_TIMERS];
  int next_timer;
  int stopped;
  int failed;
  uint32_t watchdog_handle;
  struct px_service_vm *service_vm;
  bool exiting;
  double turn_deadline;
  double runtime_deadline;
  JSValue rejections[PX_MAX_REJECTIONS];
  JSValue rejected_promises[PX_MAX_REJECTIONS];
};

void px_install_canvas(JSContext *ctx, JSValue native);
void px_install_projection(JSContext *ctx, JSValue native);
void px_install_framebuffer(JSContext *ctx, JSValue native);
void px_install_text(JSContext *ctx, JSValue native);
void px_install_wifi(JSContext *ctx, JSValue native);
#ifdef PX_SERVICE_PORTAL
void px_install_portal(JSContext *ctx, JSValue native);
#endif
void px_install_net(JSContext *ctx, JSValue native);
void px_install_mdns(JSContext *ctx, JSValue native);
void px_install_ble(JSContext *ctx, JSValue native);
void px_install_ws(JSContext *ctx, JSValue native);
void px_install_mic(JSContext *ctx, JSValue native);
#ifdef PX_MULTINET7
void px_install_wakeword(JSContext *ctx, JSValue native);
#endif
void px_install_system_net(JSContext *ctx, JSValue native);
void px_install_power(JSContext *ctx, JSValue native);
void px_install_audio(JSContext *ctx, JSValue native);
#ifdef PX_TIMED_SLEEP
void px_install_sleep(JSContext *ctx, JSValue native);
#endif
void px_install_image(JSContext *ctx, JSValue native);
void px_close_framebuffer(void);
void px_sha256(const uint8_t *data, size_t len, uint8_t out[32]);

static double monotonic_ms(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}

/* NuttX 没有通用 malloc_usable_size；自有头部保证堆统计和内存上限真实生效。 */
union allocation_header { size_t size; long double alignment; void *pointer; };
static void *px_malloc(void *opaque, size_t size)
{
  (void)opaque;
  if (size > SIZE_MAX - sizeof(union allocation_header)) return NULL;
  union allocation_header *header = malloc(sizeof(*header) + size);
  if (!header) return NULL;
  header->size = size;
  return header + 1;
}
static void px_free(void *opaque, void *ptr)
{
  (void)opaque;
  if (ptr) free((union allocation_header *)ptr - 1);
}
static void *px_calloc(void *opaque, size_t count, size_t size)
{
  if (size && count > SIZE_MAX / size) return NULL;
  void *ptr = px_malloc(opaque, count * size);
  if (ptr) memset(ptr, 0, count * size);
  return ptr;
}
static void *px_realloc(void *opaque, void *ptr, size_t size)
{
  if (!ptr) return px_malloc(opaque, size);
  if (!size) { px_free(opaque, ptr); return NULL; }
  if (size > SIZE_MAX - sizeof(union allocation_header)) return NULL;
  union allocation_header *header = realloc((union allocation_header *)ptr - 1,
                                            sizeof(*header) + size);
  if (!header) return NULL;
  header->size = size;
  return header + 1;
}
static size_t px_usable(const void *ptr)
{
  return ptr ? ((const union allocation_header *)ptr - 1)->size : 0;
}

static struct px_runtime *state(JSContext *ctx) { return JS_GetContextOpaque(ctx); }

static void report_runtime_log(struct px_runtime *runtime, const char *level,
                               const char *tag, const char *message)
{
  fprintf(stderr, "%s\n", message);
  px_service_vm_log(runtime ? runtime->service_vm : px_service_vm_current(), level, tag, message);
}

static void report_runtime_error(struct px_runtime *runtime, const char *message)
{
  char line[320];
  snprintf(line, sizeof(line), "[pixelbox] %s", message);
  report_runtime_log(runtime, "error", "runtime", line);
}

static JSValue error_errno(JSContext *ctx, const char *operation)
{
  return JS_ThrowInternalError(ctx, "%s: %s", operation, strerror(errno));
}

static void dump_error(JSContext *ctx)
{
  JSValue error = JS_GetException(ctx);
  const char *message = JS_ToCString(ctx, error);
  fprintf(stderr, "[pixelbox] %s\n", message ? message : "JavaScript exception");
  px_service_vm_log(state(ctx)->service_vm, "error", "javascript", message ? message : "JavaScript exception");
  JS_FreeCString(ctx, message);
  JSValue stack = JS_GetPropertyStr(ctx, error, "stack");
  if (!JS_IsUndefined(stack)) {
    const char *text = JS_ToCString(ctx, stack);
    if (text) {
      fprintf(stderr, "%s\n", text);
      px_service_vm_log(state(ctx)->service_vm, "error", "javascript", text);
    }
    JS_FreeCString(ctx, text);
  }
  JS_FreeValue(ctx, stack);
  JS_FreeValue(ctx, error);
}

static int interrupt(JSRuntime *rt, void *opaque)
{
  (void)rt;
  struct px_runtime *runtime = opaque;
  double now = monotonic_ms();
  return runtime->stopped || (!runtime->exiting && px_service_vm_should_stop(runtime->service_vm)) ||
         now > runtime->turn_deadline ||
         (runtime->runtime_deadline && now > runtime->runtime_deadline);
}

int px_runtime_poll_interrupt(JSContext *ctx)
{
  if (!interrupt(JS_GetRuntime(ctx), state(ctx))) return 0;
  /* 与 QuickJS 字节码中断一致：脚本不能 catch 后继续占用已过期的轮次。 */
  JS_ThrowInternalError(ctx, "interrupted");
  JSValue error = JS_GetException(ctx);
  JS_SetUncatchableError(ctx, error);
  JS_Throw(ctx, error);
  return -1;
}

/* 拒绝可在同一轮微任务中被 catch；等微任务排空后再判定未处理的 Promise。 */
static void rejection_tracker(JSContext *ctx, JSValueConst promise,
                              JSValueConst reason, bool handled, void *opaque)
{
  struct px_runtime *runtime = opaque;
  for (int i = 0; i < PX_MAX_REJECTIONS; ++i) {
    if (handled) {
      if (!JS_IsUndefined(runtime->rejected_promises[i]) &&
          JS_VALUE_GET_PTR(runtime->rejected_promises[i]) == JS_VALUE_GET_PTR(promise)) {
        JS_FreeValue(ctx, runtime->rejections[i]);
        JS_FreeValue(ctx, runtime->rejected_promises[i]);
        runtime->rejections[i] = runtime->rejected_promises[i] = JS_UNDEFINED;
        return;
      }
    } else if (JS_IsUndefined(runtime->rejected_promises[i])) {
      runtime->rejections[i] = JS_DupValue(ctx, reason);
      runtime->rejected_promises[i] = JS_DupValue(ctx, promise);
      return;
    }
  }
  if (!handled) runtime->failed = 1;
}

static void begin_turn(struct px_runtime *runtime)
{
  runtime->turn_deadline = monotonic_ms() + runtime->options->turn_timeout_ms;
}

static void report_progress(struct px_runtime *runtime)
{
  if (runtime->watchdog_handle) (void)px_watchdog_beat(runtime->watchdog_handle);
}

static double cleanup_progress(struct px_runtime *runtime, const char *phase, double began)
{
  double now = monotonic_ms();
  /* 只在上一阶段真正返回后确认进展；单个析构函数卡住仍触发原有健康期限。 */
  report_progress(runtime);
#ifdef __NuttX__
  char message[128];
  int length = snprintf(message, sizeof(message),
                        "[pixelbox] cleanup handle=%lu %s done=%lums\n",
                        (unsigned long)runtime->watchdog_handle, phase,
                        (unsigned long)(now - began));
  if (length > 0) {
    /* 串口 O_NONBLOCK 仍可能等待 xmit.lock；这里只写内存日志环，避免诊断卡住退出。 */
    px_service_vm_log(runtime->service_vm, "info", "cleanup", message);
  }
#else
  (void)phase;
  (void)began;
#endif
  return now;
}

static void finish_watchdog(struct px_runtime *runtime)
{
  if (!runtime->watchdog_handle) return;
  (void)px_watchdog_end(runtime->watchdog_handle);
  (void)px_watchdog_unregister(runtime->watchdog_handle);
  runtime->watchdog_handle = 0;
}

static int evaluate(struct px_runtime *runtime, const char *source, size_t len, const char *name)
{
  double start = monotonic_ms();
  begin_turn(runtime);
  /* 编译属于装载阶段；单轮JS预算从实际执行开始，整段仍受硬件健康期限保护。 */
  JSValue result = JS_Eval(runtime->ctx, source, len, name,
                           JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
  double compiled = monotonic_ms();
  if (!JS_IsException(result)) {
    report_progress(runtime);
    begin_turn(runtime);
    result = JS_EvalFunction(runtime->ctx, result);
  }
  int failed = JS_IsException(result);
  if (failed) {
    char line[320];
    snprintf(line, sizeof(line), "[pixelbox] %s failed: compile=%.0fms execute=%.0fms",
             name, compiled - start, monotonic_ms() - compiled);
    report_runtime_log(runtime, "error", "runtime", line);
    dump_error(runtime->ctx);
  }
  JS_FreeValue(runtime->ctx, result);
  report_progress(runtime);
  return failed ? -1 : 0;
}

static JSValue js_console(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic)
{
  (void)self;
  FILE *stream = magic >= 2 ? stderr : stdout;
  char log[1024];
  size_t used = 0;
  log[0] = 0;
  for (int i = 0; i < argc; ++i) {
    const char *text = JS_ToCString(ctx, argv[i]);
    if (!text) return JS_EXCEPTION;
    fprintf(stream, "%s%s", i ? " " : "", text);
    if (used < sizeof(log) - 1) {
      int n = snprintf(log + used, sizeof(log) - used, "%s%s", i ? " " : "", text);
      if (n > 0) used += (size_t)n < sizeof(log) - used ? (size_t)n : sizeof(log) - used - 1;
    }
    JS_FreeCString(ctx, text);
  }
  fputc('\n', stream);
  fflush(stream);
  const char *level = magic == 2 ? "warn" : magic == 3 ? "error" : magic == 4 ? "debug" : "info";
  px_service_vm_log(state(ctx)->service_vm, level, "console", log);
#ifdef __NuttX__
  int priority = magic == 2 ? LOG_WARNING : magic == 3 ? LOG_ERR : magic == 4 ? LOG_DEBUG : LOG_INFO;
  syslog(priority, "[pixelbox][js][console][%s] %s", level, log);
#endif
  return JS_UNDEFINED;
}

static void free_timer(JSContext *ctx, struct px_timer *timer)
{
  JS_FreeValue(ctx, timer->callback);
  for (int i = 0; i < timer->argc; ++i) JS_FreeValue(ctx, timer->args[i]);
  memset(timer, 0, sizeof(*timer));
}

static JSValue js_timer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic)
{
  (void)self;
  struct px_runtime *runtime = state(ctx);
  if (!argc || !JS_IsFunction(ctx, argv[0])) return JS_ThrowTypeError(ctx, "timer handler must be a function");
  if (argc - 2 > PX_MAX_TIMER_ARGS) return JS_ThrowRangeError(ctx, "too many timer arguments");
  double delay = 0;
  if (argc > 1 && JS_ToFloat64(ctx, &delay, argv[1])) return JS_EXCEPTION;
  if (!isfinite(delay) || delay < 0) delay = 0;
  if (delay > INT_MAX) delay = INT_MAX;
  for (int i = 0; i < PX_MAX_TIMERS; ++i) {
    struct px_timer *timer = &runtime->timers[i];
    if (timer->id) continue;
    /* ID 不重用仍存活的 timer；JavaScript 可安全取消回调内创建的其他 timer。 */
    if (runtime->next_timer == INT_MAX) return JS_ThrowRangeError(ctx, "timer id exhausted");
    timer->id = ++runtime->next_timer;
    timer->at = monotonic_ms() + delay;
    timer->interval = magic ? fmax(1, delay) : 0;
    timer->callback = JS_DupValue(ctx, argv[0]);
    timer->argc = argc > 2 ? argc - 2 : 0;
    for (int j = 0; j < timer->argc; ++j) timer->args[j] = JS_DupValue(ctx, argv[j + 2]);
    return JS_NewInt32(ctx, timer->id);
  }
  return JS_ThrowRangeError(ctx, "timer limit exceeded (128)");
}

static JSValue js_clear_timer(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  int32_t id;
  if (!argc) return JS_UNDEFINED;
  if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
  for (int i = 0; i < PX_MAX_TIMERS; ++i)
    if (state(ctx)->timers[i].id == id) free_timer(ctx, &state(ctx)->timers[i]);
  return JS_UNDEFINED;
}

static JSValue run_microtask(JSContext *ctx, int argc, JSValueConst *argv)
{
  (void)argc;
  return JS_Call(ctx, argv[0], JS_UNDEFINED, 0, NULL);
}

static JSValue js_microtask(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc || !JS_IsFunction(ctx, argv[0])) return JS_ThrowTypeError(ctx, "queueMicrotask needs a function");
  if (JS_EnqueueJob(ctx, run_microtask, 1, argv) < 0) return JS_EXCEPTION;
  return JS_UNDEFINED;
}

static JSValue js_now(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic)
{
  (void)self; (void)argc; (void)argv;
  if (magic) return JS_NewFloat64(ctx, monotonic_ms());
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return JS_NewFloat64(ctx, (double)tv.tv_sec * 1000 + tv.tv_usec / 1000.0);
}

static JSValue js_imu_available(JSContext *ctx, JSValueConst self,
                                int argc, JSValueConst *argv)
{
  (void)self;
  (void)argc;
  (void)argv;
#ifdef __NuttX__
  return JS_NewBool(ctx, pixelbox_board_imu_available());
#else
  return JS_NewBool(ctx, false);
#endif
}

static JSValue js_imu_read(JSContext *ctx, JSValueConst self,
                           int argc, JSValueConst *argv)
{
  (void)ctx;
  (void)self;
  (void)argc;
  (void)argv;
#ifdef __NuttX__
  struct pixelbox_imu_sample sample;
  if (pixelbox_board_imu_read(&sample) < 0)
    {
      return JS_NULL;
    }

  JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "ax", JS_NewFloat64(ctx, sample.ax));
  JS_SetPropertyStr(ctx, value, "ay", JS_NewFloat64(ctx, sample.ay));
  JS_SetPropertyStr(ctx, value, "az", JS_NewFloat64(ctx, sample.az));
  JS_SetPropertyStr(ctx, value, "gx", JS_NewFloat64(ctx, sample.gx));
  JS_SetPropertyStr(ctx, value, "gy", JS_NewFloat64(ctx, sample.gy));
  JS_SetPropertyStr(ctx, value, "gz", JS_NewFloat64(ctx, sample.gz));
  return value;
#else
  return JS_NULL;
#endif
}

static JSValue js_touch_available(JSContext *ctx, JSValueConst self,
                                  int argc, JSValueConst *argv)
{
  (void)self;
  (void)argc;
  (void)argv;
#ifdef __NuttX__
  return JS_NewBool(ctx, pixelbox_board_touch_available());
#else
  return JS_NewBool(ctx, false);
#endif
}

static JSValue js_touch_read(JSContext *ctx, JSValueConst self,
                             int argc, JSValueConst *argv)
{
  (void)ctx;
  (void)self;
  (void)argc;
  (void)argv;
#ifdef __NuttX__
  struct pixelbox_touch_event event;
  if (pixelbox_board_touch_read(&event) < 0)
    {
      return JS_NULL;
    }

  JSValue value = JS_NewObject(ctx);
  const char *type = event.type == PIXELBOX_TOUCH_DOWN ? "down" :
                     event.type == PIXELBOX_TOUCH_MOVE ? "move" : "up";
  JS_SetPropertyStr(ctx, value, "type", JS_NewString(ctx, type));
  JS_SetPropertyStr(ctx, value, "x", JS_NewInt32(ctx, event.x));
  JS_SetPropertyStr(ctx, value, "y", JS_NewInt32(ctx, event.y));
  return value;
#else
  return JS_NULL;
#endif
}

static JSValue js_timezone(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "setTimezone needs a POSIX TZ string");
#if defined(__NuttX__) && !defined(CONFIG_LIBC_LOCALTIME)
  /* 裁剪 localtime 的 NuttX 不导出 tzset，显式报不支持，不能伪造时区已生效。 */
  JSValue error = JS_NewError(ctx);
  JS_SetPropertyStr(ctx, error, "message", JS_NewString(ctx, "ENOTSUP"));
  return JS_Throw(ctx, error);
#else
  const char *text = JS_ToCString(ctx, argv[0]);
  if (!text) return JS_EXCEPTION;
  int result = setenv("TZ", text, 1);
  JS_FreeCString(ctx, text);
  if (result) return error_errno(ctx, "setTimezone");
  tzset();
  return JS_UNDEFINED;
#endif
}

static JSValue js_memory(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  JSMemoryUsage usage;
  JS_ComputeMemoryUsage(state(ctx)->rt, &usage);
  JSValue value = JS_NewObject(ctx);
  size_t heap_free = 0;
#ifdef __NuttX__
  struct mallinfo info = mallinfo();
  heap_free = info.fordblks;
#endif
  JS_SetPropertyStr(ctx, value, "heapFree", JS_NewFloat64(ctx, (double)heap_free));
  JS_SetPropertyStr(ctx, value, "psramFree", JS_NewInt32(ctx, 0));
  JS_SetPropertyStr(ctx, value, "jsHeapUsed", JS_NewFloat64(ctx, (double)usage.malloc_size));
  return value;
}

static JSValue js_exit(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  state(ctx)->stopped = 1;
  return JS_UNDEFINED;
}

static JSValue js_restart(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
#if defined(__NuttX__) && defined(CONFIG_BOARDCTL_RESET)
  if (boardctl(BOARDIOC_RESET, 0) < 0) return error_errno(ctx, "restart");
  return JS_UNDEFINED;
#else
  JSValue error = JS_NewError(ctx);
  JS_SetPropertyStr(ctx, error, "message", JS_NewString(ctx, "ENOTSUP"));
  return JS_Throw(ctx, error);
#endif
}

/* BinaryLike 只接受 ArrayBuffer 和 Uint8Array，偏移必须按视图而非 backing buffer 计算。 */
static int binary(JSContext *ctx, JSValueConst value, const uint8_t **ptr, size_t *size)
{
  if (JS_GetTypedArrayType(value) == JS_TYPED_ARRAY_UINT8) {
    size_t offset, element, capacity;
    JSValue owner = JS_GetTypedArrayBuffer(ctx, value, &offset, size, &element);
    if (JS_IsException(owner)) return -1;
    uint8_t *base = JS_GetArrayBuffer(ctx, &capacity, owner);
    int invalid = JS_HasException(ctx) || offset > capacity || *size > capacity - offset;
    *ptr = base ? base + offset : NULL;
    JS_FreeValue(ctx, owner);
    return invalid ? -1 : 0;
  }
  *ptr = JS_GetArrayBuffer(ctx, size, value);
  return JS_HasException(ctx) ? -1 : 0;
}

static JSValue js_random(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  int32_t size;
  if (!argc || JS_ToInt32(ctx, &size, argv[0])) return JS_ThrowTypeError(ctx, "randomBytes needs a length");
  if (size < 0 || size > 1048576) return JS_ThrowRangeError(ctx, "randomBytes length must be 0..1048576");
  uint8_t *bytes = js_malloc(ctx, size ? (size_t)size : 1);
  if (!bytes) return JS_EXCEPTION;
  int fd = size ? open("/dev/urandom", O_RDONLY) : -1;
  if (size && fd < 0) { js_free(ctx, bytes); return error_errno(ctx, "randomBytes /dev/urandom"); }
  size_t read_bytes = 0;
  while (read_bytes < (size_t)size) {
    ssize_t got = read(fd, bytes + read_bytes, (size_t)size - read_bytes);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) { close(fd); js_free(ctx, bytes); return error_errno(ctx, "randomBytes"); }
    read_bytes += (size_t)got;
  }
  if (fd >= 0) close(fd);
  JSValue result = JS_NewArrayBufferCopy(ctx, bytes, size);
  js_free(ctx, bytes);
  return result;
}

static JSValue js_hash(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic)
{
  (void)self;
  const uint8_t *data;
  const char *text = NULL;
  size_t size;
  if (!argc) return JS_ThrowTypeError(ctx, "hash needs input");
  if (magic && JS_IsString(argv[0])) {
    text = JS_ToCStringLen(ctx, &size, argv[0]);
    if (!text) return JS_EXCEPTION;
    data = (const uint8_t *)text;
  } else if (binary(ctx, argv[0], &data, &size)) return JS_EXCEPTION;
  JSValue result;
  if (magic) {
    uint8_t digest[32];
    px_sha256(data, size, digest);
    result = JS_NewArrayBufferCopy(ctx, digest, sizeof(digest));
  } else {
    uint32_t crc = UINT32_MAX;
    for (size_t i = 0; i < size; ++i) {
      crc ^= data[i];
      for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320U & -(crc & 1U));
    }
    result = JS_NewUint32(ctx, crc ^ UINT32_MAX);
  }
  JS_FreeCString(ctx, text);
  return result;
}

/* /app 只读，/data 可写；逐级拒绝 ..、NUL 和符号链接，防止路径逃逸。 */
static int resolve_path(JSContext *ctx, JSValueConst value, int writing, char output[PATH_MAX])
{
  if (!JS_IsString(value)) { JS_ThrowTypeError(ctx, "path must be a string"); return -1; }
  size_t length;
  const char *path = JS_ToCStringLen(ctx, &length, value);
  if (!path) return -1;
  const char *root = NULL, *relative = NULL;
  if (length != strlen(path)) goto invalid;
  if (!strncmp(path, "/data", 5) && (!path[5] || path[5] == '/')) {
    root = state(ctx)->options->data_root; relative = path + 5;
  } else if (!writing && !strncmp(path, "/app", 4) && (!path[4] || path[4] == '/')) {
    root = state(ctx)->options->app_root; relative = path + 4;
  } else goto invalid;
  if (snprintf(output, PATH_MAX, "%s", root) >= PATH_MAX) goto invalid;
  size_t used = strlen(output);
  while (used > 1 && output[used - 1] == '/') output[--used] = 0;
  while (*relative) {
    while (*relative == '/') ++relative;
    if (!*relative) break;
    const char *end = strchr(relative, '/');
    size_t part = end ? (size_t)(end - relative) : strlen(relative);
    if ((part == 1 && relative[0] == '.') || (part == 2 && !strncmp(relative, "..", 2)) ||
        used + part + 1 >= PATH_MAX) goto invalid;
    output[used++] = '/';
    memcpy(output + used, relative, part);
    output[used += part] = 0;
    struct stat st;
    if (!lstat(output, &st) && S_ISLNK(st.st_mode)) goto invalid;
    relative += part;
  }
  JS_FreeCString(ctx, path);
  return 0;
invalid:
  JS_FreeCString(ctx, path);
  JS_ThrowTypeError(ctx, "path must stay in /app (read-only) or /data without symlinks or dot segments");
  return -1;
}

static uint8_t *read_file(const char *path, size_t *size)
{
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  struct stat st;
  if (fstat(fileno(file), &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || st.st_size > PX_MAX_FILE) {
    fclose(file); errno = EFBIG; return NULL;
  }
  *size = (size_t)st.st_size;
  uint8_t *data = malloc(*size + 1);
  if (!data) { fclose(file); errno = ENOMEM; return NULL; }
  if (*size && fread(data, 1, *size, file) != *size) { free(data); fclose(file); errno = EIO; return NULL; }
  data[*size] = 0;
  fclose(file);
  return data;
}

static JSValue file_stat(JSContext *ctx, const char *path, const char *name)
{
  struct stat st;
  if (lstat(path, &st)) {
    if (errno == ENOENT) return JS_NULL;
    return error_errno(ctx, "stat");
  }
  if (S_ISLNK(st.st_mode)) return JS_ThrowTypeError(ctx, "symbolic links are not accessible");
  JSValue result = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, result, "name", JS_NewString(ctx, name));
  JS_SetPropertyStr(ctx, result, "size", JS_NewFloat64(ctx, (double)st.st_size));
  JS_SetPropertyStr(ctx, result, "isDir", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
  JS_SetPropertyStr(ctx, result, "mtime", JS_NewFloat64(ctx, (double)st.st_mtime * 1000));
  return result;
}

enum { FS_READ_TEXT, FS_READ_BYTES, FS_WRITE_TEXT, FS_WRITE_BYTES, FS_APPEND,
       FS_EXISTS, FS_REMOVE, FS_MKDIR, FS_READ_DIR, FS_STAT };

static JSValue js_fs(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic)
{
  (void)self;
  if (!argc) return JS_ThrowTypeError(ctx, "filesystem operation needs a path");
  char path[PATH_MAX];
  int writing = magic >= FS_WRITE_TEXT && magic <= FS_MKDIR && magic != FS_EXISTS;
  if (resolve_path(ctx, argv[0], writing, path)) return JS_EXCEPTION;
  if (magic == FS_READ_TEXT || magic == FS_READ_BYTES) {
    size_t size;
    uint8_t *data = read_file(path, &size);
    if (!data) return error_errno(ctx, "read");
    JSValue result = magic == FS_READ_TEXT ? JS_NewStringLen(ctx, (const char *)data, size) :
                                          JS_NewArrayBufferCopy(ctx, data, size);
    free(data);
    return result;
  }
  if (magic == FS_EXISTS) {
    struct stat st;
    int result = stat(path, &st);
    if (result && errno != ENOENT && errno != ENOTDIR) return error_errno(ctx, "exists");
    return JS_NewBool(ctx, !result);
  }
  if (magic == FS_STAT) {
    const char *name = strrchr(path, '/');
    return file_stat(ctx, path, name ? name + 1 : path);
  }
  if (magic == FS_MKDIR) {
    if (mkdir(path, 0755)) return error_errno(ctx, "mkdir");
    return JS_UNDEFINED;
  }
  if (magic == FS_REMOVE) {
    const char *root = state(ctx)->options->data_root;
    size_t root_size = strlen(root);
    while (root_size > 1 && root[root_size - 1] == '/') --root_size;
    if (strlen(path) == root_size && !strncmp(path, root, root_size))
      return JS_ThrowTypeError(ctx, "cannot remove /data root");
    struct stat st;
    if (lstat(path, &st)) return error_errno(ctx, "remove");
    int result = S_ISDIR(st.st_mode) ? rmdir(path) : unlink(path);
    if (result) return error_errno(ctx, "remove");
    return JS_UNDEFINED;
  }
  if (magic == FS_READ_DIR) {
    DIR *dir = opendir(path);
    if (!dir) return error_errno(ctx, "readDir");
    JSValue result = JS_NewArray(ctx);
    struct dirent *entry;
    uint32_t index = 0;
    while ((entry = readdir(dir))) {
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
      char child[PATH_MAX];
      if (snprintf(child, sizeof(child), "%s/%s", path, entry->d_name) >= PATH_MAX) {
        closedir(dir); JS_FreeValue(ctx, result); return JS_ThrowRangeError(ctx, "path too long");
      }
      JSValue item = file_stat(ctx, child, entry->d_name);
      if (JS_IsException(item) || JS_SetPropertyUint32(ctx, result, index++, item) < 0) {
        closedir(dir); JS_FreeValue(ctx, result); return JS_EXCEPTION;
      }
    }
    closedir(dir);
    return result;
  }
  if (argc < 2) return JS_ThrowTypeError(ctx, "write needs data");
  const uint8_t *bytes;
  size_t size;
  const char *text = NULL;
  if (magic == FS_WRITE_TEXT || (magic == FS_APPEND && JS_IsString(argv[1]))) {
    text = JS_ToCStringLen(ctx, &size, argv[1]);
    if (!text) return JS_EXCEPTION;
    bytes = (const uint8_t *)text;
  } else if (binary(ctx, argv[1], &bytes, &size)) return JS_EXCEPTION;
  if (size > PX_MAX_FILE) { JS_FreeCString(ctx, text); return JS_ThrowRangeError(ctx, "file limit exceeded"); }
  struct stat old;
  if (magic == FS_APPEND && !stat(path, &old) && (uint64_t)old.st_size + size > PX_MAX_FILE) {
    JS_FreeCString(ctx, text); return JS_ThrowRangeError(ctx, "file limit exceeded");
  }
  FILE *file = fopen(path, magic == FS_APPEND ? "ab" : "wb");
  if (!file) { JS_FreeCString(ctx, text); return error_errno(ctx, "write"); }
  int failed = fwrite(bytes, 1, size, file) != size;
  if (fclose(file)) failed = 1;
  JS_FreeCString(ctx, text);
  return failed ? error_errno(ctx, "write") : JS_UNDEFINED;
}

static JSValue js_atomic_write(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (argc < 2 || !JS_IsString(argv[1])) return JS_ThrowTypeError(ctx, "atomic write needs a path and text");
  char path[PATH_MAX], temporary[PATH_MAX];
  if (resolve_path(ctx, argv[0], 1, path)) return JS_EXCEPTION;
  if (snprintf(temporary, sizeof(temporary), "%s.tmp", path) >= PATH_MAX)
    return JS_ThrowRangeError(ctx, "path too long");
  struct stat st;
  if (!lstat(temporary, &st) && S_ISLNK(st.st_mode)) return JS_ThrowTypeError(ctx, "symbolic links are not accessible");
  size_t size;
  const char *text = JS_ToCStringLen(ctx, &size, argv[1]);
  if (!text) return JS_EXCEPTION;
  if (size > PX_MAX_FILE) { JS_FreeCString(ctx, text); return JS_ThrowRangeError(ctx, "KV file limit exceeded"); }
  int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) { JS_FreeCString(ctx, text); return error_errno(ctx, "KV write"); }
  size_t offset = 0;
  int failed = 0;
  while (offset < size) {
    ssize_t written = write(fd, text + offset, size - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) { failed = 1; break; }
    offset += (size_t)written;
  }
  /* 先同步临时文件再原子替换，掉电不会把原 KV 文件截断成半份 JSON。 */
  if (!failed && fsync(fd)) failed = 1;
  int saved_errno = errno;
  if (close(fd) && !failed) { failed = 1; saved_errno = errno; }
  JS_FreeCString(ctx, text);
  if (!failed && rename(temporary, path)) { failed = 1; saved_errno = errno; }
  if (failed) { unlink(temporary); errno = saved_errno; return error_errno(ctx, "KV commit"); }
  return JS_UNDEFINED;
}

static void method(JSContext *ctx, JSValue object, const char *name, JSCFunction *fn, int argc)
{
  JS_SetPropertyStr(ctx, object, name, JS_NewCFunction(ctx, fn, name, argc));
}

static void install_device_identity(JSContext *ctx, JSValue native, const char *hostname)
{
  char device_id[300];
  char mac_string[18] = "00:00:00:00:00:00";
  snprintf(device_id, sizeof(device_id), "pxb-%s", hostname);
#if defined(__NuttX__) && defined(CONFIG_ESP32S3_EFUSE)
  /* ESP32-S3 的官方 NuttX 12.9.0 efuse 表使用此顺序存储 factory MAC。
   * 只通过通用只读 ioctl 读取，不导入 ESP-IDF 私有 API，更不写入 eFuse。 */
  static const efuse_desc_t descriptors[6] = {{296,8},{288,8},{280,8},{272,8},{264,8},{256,8}};
  const efuse_desc_t *fields[7] = {&descriptors[0],&descriptors[1],&descriptors[2],
                                  &descriptors[3],&descriptors[4],&descriptors[5],NULL};
  uint8_t mac[6] = {0};
  struct efuse_param_s params = {fields, 48, mac};
  int fd = open("/dev/efuse", O_RDONLY);
  if (fd >= 0) {
    if (ioctl(fd, EFUSEIOC_READ_FIELD, (unsigned long)&params) >= 0) {
      snprintf(device_id, sizeof(device_id), "pxb-%02x%02x%02x%02x%02x%02x",
               mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
      snprintf(mac_string, sizeof(mac_string), "%02x:%02x:%02x:%02x:%02x:%02x",
               mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    }
    else {
      char line[160];
      snprintf(line, sizeof(line), "[pixelbox] eFuse MAC unavailable: %s", strerror(errno));
      report_runtime_log(state(ctx), "warn", "runtime", line);
    }
    close(fd);
  } else {
    char line[160];
    snprintf(line, sizeof(line), "[pixelbox] /dev/efuse unavailable: %s", strerror(errno));
    report_runtime_log(state(ctx), "warn", "runtime", line);
  }
#endif
  JS_SetPropertyStr(ctx, native, "deviceId", JS_NewString(ctx, device_id));
  JS_SetPropertyStr(ctx, native, "mac", JS_NewString(ctx, mac_string));
}

static int install(struct px_runtime *runtime)
{
  JSContext *ctx = runtime->ctx;
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue native = JS_NewObject(ctx);
  JSValue console = JS_NewObject(ctx);
  const char *levels[] = {"log", "info", "warn", "error", "debug"};
  for (int i = 0; i < 5; ++i)
    JS_SetPropertyStr(ctx, console, levels[i], JS_NewCFunctionMagic(ctx, js_console, levels[i], 1, JS_CFUNC_generic_magic, i));
  JS_SetPropertyStr(ctx, global, "console", console);
  JS_SetPropertyStr(ctx, global, "setTimeout", JS_NewCFunctionMagic(ctx, js_timer, "setTimeout", 2, JS_CFUNC_generic_magic, 0));
  JS_SetPropertyStr(ctx, global, "setInterval", JS_NewCFunctionMagic(ctx, js_timer, "setInterval", 2, JS_CFUNC_generic_magic, 1));
  method(ctx, global, "clearTimeout", js_clear_timer, 1);
  method(ctx, global, "clearInterval", js_clear_timer, 1);
  method(ctx, global, "queueMicrotask", js_microtask, 1);
  JS_SetPropertyStr(ctx, global, "__pxPerfNowMs", JS_NewCFunctionMagic(ctx, js_now, "now", 0, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(ctx, native, "now", JS_NewCFunctionMagic(ctx, js_now, "now", 0, JS_CFUNC_generic_magic, 0));
  method(ctx, native, "imuAvailable", js_imu_available, 0);
  method(ctx, native, "imuRead", js_imu_read, 0);
  method(ctx, native, "touchAvailable", js_touch_available, 0);
  method(ctx, native, "touchRead", js_touch_read, 0);
  method(ctx, native, "memory", js_memory, 0);
  method(ctx, native, "setTimezone", js_timezone, 1);
  method(ctx, native, "exit", js_exit, 0);
  method(ctx, native, "restart", js_restart, 0);
  method(ctx, native, "atomicWrite", js_atomic_write, 2);
  method(ctx, native, "randomBytes", js_random, 1);
  JS_SetPropertyStr(ctx, native, "crc32", JS_NewCFunctionMagic(ctx, js_hash, "crc32", 1, JS_CFUNC_generic_magic, 0));
  JS_SetPropertyStr(ctx, native, "sha256", JS_NewCFunctionMagic(ctx, js_hash, "sha256", 1, JS_CFUNC_generic_magic, 1));
  JSValue fs = JS_NewObject(ctx);
  const char *names[] = {"readText", "readBytes", "writeText", "writeBytes", "append", "exists", "remove", "mkdir", "readDir", "stat"};
  for (int i = 0; i < 10; ++i)
    JS_SetPropertyStr(ctx, fs, names[i], JS_NewCFunctionMagic(ctx, js_fs, names[i], 2, JS_CFUNC_generic_magic, i));
  JS_SetPropertyStr(ctx, native, "fs", fs);
  struct utsname platform;
  memset(&platform, 0, sizeof(platform));
  uname(&platform);
  JS_SetPropertyStr(ctx, native, "hostname", JS_NewString(ctx, platform.nodename[0] ? platform.nodename : "pixelbox"));
  install_device_identity(ctx, native, platform.nodename[0] ? platform.nodename : "pixelbox");
#ifdef __NuttX__
  JS_SetPropertyStr(ctx, native, "chip", JS_NewString(ctx, "esp32s3"));
  JS_SetPropertyStr(ctx, native, "model", JS_NewString(ctx, "pixelbox-nuttx-esp32s3"));
#else
  JS_SetPropertyStr(ctx, native, "chip", JS_NewString(ctx, platform.machine));
  JS_SetPropertyStr(ctx, native, "model", JS_NewString(ctx, "pixelbox-nuttx-host"));
#endif
  px_install_canvas(ctx, native);
  px_install_projection(ctx, native);
  px_install_framebuffer(ctx, native);
  px_install_text(ctx, native);
  px_install_wifi(ctx, native);
#ifdef PX_SERVICE_PORTAL
  px_install_portal(ctx, native);
#endif
  px_install_net(ctx, native);
  px_install_mdns(ctx, native);
  px_install_ble(ctx, native);
  px_install_ws(ctx, native);
  px_install_mic(ctx, native);
#ifdef PX_MULTINET7
  px_install_wakeword(ctx, native);
#endif
  px_install_system_net(ctx, native);
  px_install_power(ctx, native);
  px_install_audio(ctx, native);
#ifdef PX_TIMED_SLEEP
  px_install_sleep(ctx, native);
#endif
  px_install_image(ctx, native);
  JS_SetPropertyStr(ctx, global, "__pxNative", native);
  JS_FreeValue(ctx, global);
  /* 先构建全域 FFI，再注入共享 util/color/text prelude，避免复制唯一事实源。 */
  if (evaluate(runtime, px_nuttx_prelude, sizeof(px_nuttx_prelude) - 1, "nuttx:prelude")) return -1;
  return evaluate(runtime, px_core_prelude, sizeof(px_core_prelude) - 1, "pixelbox:prelude_core");
}

static int drain_jobs(struct px_runtime *runtime)
{
  JSContext *job_ctx;
  /* 每批 Promise 微任务共享一个截止时间，递归微任务不能饿死事件循环。 */
  begin_turn(runtime);
  while (JS_IsJobPending(runtime->rt) && !runtime->stopped &&
         !px_service_vm_should_stop(runtime->service_vm)) {
    if (monotonic_ms() > runtime->turn_deadline) {
      report_runtime_error(runtime, "microtask turn timeout"); return -1;
    }
    if (JS_ExecutePendingJob(runtime->rt, &job_ctx) < 0) { dump_error(job_ctx); return -1; }
  }
  if (runtime->failed) { report_runtime_error(runtime, "too many pending promise rejections"); return -1; }
  for (int i = 0; i < PX_MAX_REJECTIONS; ++i) {
    if (!JS_IsUndefined(runtime->rejected_promises[i])) {
      JS_Throw(runtime->ctx, JS_DupValue(runtime->ctx, runtime->rejections[i]));
      dump_error(runtime->ctx);
      return -1;
    }
  }
  report_progress(runtime);
  return 0;
}

static void service_eval(struct px_runtime *runtime)
{
  struct px_service_eval request;
  if (px_service_vm_take_eval(runtime->service_vm, &request) <= 0) return;
  /* 邮箱只传C字符串；编译、执行、结果转换都由本VM线程负责并受单轮截止时间约束。 */
  begin_turn(runtime);
  JSValue value = JS_Eval(runtime->ctx, request.code, strlen(request.code), "devd:eval",
                          JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
  if (!JS_IsException(value)) {
    report_progress(runtime);
    begin_turn(runtime);
    value = JS_EvalFunction(runtime->ctx, value);
  }
  bool success = !JS_IsException(value);
  if (!success) value = JS_GetException(runtime->ctx);
  const char *text = JS_ToCString(runtime->ctx, value);
  if (!text) {
    JSValue conversion_error = JS_GetException(runtime->ctx);
    JS_FreeValue(runtime->ctx, conversion_error);
    success = false;
  }
  int completed = px_service_vm_complete_eval(runtime->service_vm, request.token, success,
                                              text ? text : "eval result conversion failed");
  if (completed && completed != -ECANCELED) {
    completed = px_service_vm_complete_eval(runtime->service_vm, request.token, false, "eval result unavailable");
    if (completed && completed != -ECANCELED)
      (void)px_service_vm_abandon_eval(runtime->service_vm, request.token);
  }
  JS_FreeCString(runtime->ctx, text);
  JS_FreeValue(runtime->ctx, value);
  px_service_eval_free(&request);
  report_progress(runtime);
}

static int event_loop(struct px_runtime *runtime)
{
  while (!runtime->stopped && !px_service_vm_should_stop(runtime->service_vm)) {
    /* 显示句柄归当前VM任务组；后台按键任务只投递请求，不跨组操作fd。 */
    struct px_system_key_request display_request;
    if (px_system_keys_next_display(&display_request) > 0 &&
        display_request.action == PX_SYSTEM_KEY_TOGGLE_SCREEN) {
      extern int px_toggle_framebuffer_power(void);
      int toggled = display_request.result ? display_request.result : px_toggle_framebuffer_power();
      if (toggled) {
        char line[96];
        snprintf(line, sizeof(line), "[pixelbox] screen toggle failed: %d", toggled);
        report_runtime_log(runtime, "warn", "runtime", line);
      }
    }
    service_eval(runtime);
    if (px_service_vm_should_stop(runtime->service_vm)) break;
    if (drain_jobs(runtime)) return -1;
    double now = monotonic_ms();
    if (runtime->runtime_deadline && now > runtime->runtime_deadline) {
      report_runtime_error(runtime, "runtime timeout"); return -1;
    }
    double next = now + 50;
    int due = -1;
    int active = 0;
    for (int i = 0; i < PX_MAX_TIMERS; ++i) {
      struct px_timer *timer = &runtime->timers[i];
      if (!timer->id) continue;
      active = 1;
      if (timer->at < next) next = timer->at;
      if (timer->at <= now &&
          (due < 0 || timer->at < runtime->timers[due].at)) due = i;
    }
    if (due >= 0) {
      struct px_timer *timer = &runtime->timers[due];
      /* 同步绘制后按到期时间处理积压输入；复制引用后允许回调取消或重排 timer。 */
      JSValue callback = JS_DupValue(runtime->ctx, timer->callback);
      JSValue args[PX_MAX_TIMER_ARGS];
      int argc = timer->argc;
      for (int j = 0; j < argc; ++j) args[j] = JS_DupValue(runtime->ctx, timer->args[j]);
      if (timer->interval) timer->at = now + timer->interval;
      else free_timer(runtime->ctx, timer);
      begin_turn(runtime);
      JSValue result = JS_Call(runtime->ctx, callback, JS_UNDEFINED, argc, args);
      JS_FreeValue(runtime->ctx, callback);
      for (int j = 0; j < argc; ++j) JS_FreeValue(runtime->ctx, args[j]);
      int failed = JS_IsException(result);
      if (failed) dump_error(runtime->ctx);
      JS_FreeValue(runtime->ctx, result);
      if (failed || drain_jobs(runtime)) return -1;
    }
    report_progress(runtime);
    if (!runtime->service_vm && !active && !JS_IsJobPending(runtime->rt)) break;
    double delay = next - monotonic_ms();
    if (due < 0 && delay > 0 && !runtime->stopped) {
      struct timespec sleep_time = {0, (long)(fmin(delay, 50) * 1000000)};
      nanosleep(&sleep_time, NULL);
    }
  }
  return 0;
}

static int run_locked(const struct px_options *options)
{
  double startup_began = monotonic_ms();
  struct px_runtime *runtime = calloc(1, sizeof(*runtime));
  if (!runtime) {
    report_runtime_log(NULL, "error", "runtime", "[pixelbox] cannot allocate runtime state");
    return 1;
  }
  runtime->options = options;
  runtime->service_vm = px_service_vm_current();
#ifdef __NuttX__
  /* 注册覆盖初始化、执行和析构；失败时回到NSH，不启动未受保护的应用。 */
  int protection = px_watchdog_register(&runtime->watchdog_handle);
  if (!protection) protection = px_watchdog_begin(runtime->watchdog_handle);
  if (protection) {
    if (runtime->watchdog_handle) (void)px_watchdog_unregister(runtime->watchdog_handle);
    char line[112];
    snprintf(line, sizeof(line), "[pixelbox] VM watchdog registration failed: %d", protection);
    report_runtime_log(runtime, "error", "runtime", line);
    free(runtime);
    return 1;
  }
#endif
  for (int i = 0; i < PX_MAX_REJECTIONS; ++i)
    runtime->rejections[i] = runtime->rejected_promises[i] = JS_UNDEFINED;
  JSMallocFunctions alloc = {px_calloc, px_malloc, px_free, px_realloc, px_usable};
  runtime->rt = JS_NewRuntime2(&alloc, NULL);
  if (!runtime->rt) {
    report_runtime_error(runtime, "cannot allocate runtime");
    finish_watchdog(runtime); free(runtime); return 1;
  }
  JS_SetMemoryLimit(runtime->rt, options->heap_limit);
#ifdef __NuttX__
  JS_SetMaxStackSize(runtime->rt, CONFIG_INTERPRETERS_PIXELBOX_STACKSIZE / 2);
#else
  JS_SetMaxStackSize(runtime->rt, 512 * 1024);
#endif
  runtime->ctx = JS_NewContext(runtime->rt);
  if (!runtime->ctx) { JS_FreeRuntime(runtime->rt); finish_watchdog(runtime); free(runtime); return 1; }
  report_progress(runtime);
  JS_SetContextOpaque(runtime->ctx, runtime);
  JS_SetInterruptHandler(runtime->rt, interrupt, runtime);
  JS_SetHostPromiseRejectionTracker(runtime->rt, rejection_tracker, runtime);
  runtime->runtime_deadline = options->runtime_timeout_ms ? monotonic_ms() + options->runtime_timeout_ms : 0;
  int result = install(runtime);
  double installed_at = monotonic_ms();
  if (!result && px_service_vm_enter(runtime->service_vm)) result = -1;
  char default_entry[PATH_MAX];
  const char *entry = options->entry;
  if (!entry || (runtime->service_vm && entry[0] != '/')) {
    /* devd manifest的entry相对已提交应用目录；不能按NSH当前目录打开。 */
    int length = snprintf(default_entry, sizeof(default_entry), "%s/%s", options->app_root,
                           entry ? entry : "main.js");
    if (length < 0 || (size_t)length >= sizeof(default_entry)) {
      report_runtime_error(runtime, "application entry path too long");
      result = -1;
    }
    entry = default_entry;
  }
  if (!result) {
    size_t size = 0;
    uint8_t *source = options->eval_source ? NULL : read_file(entry, &size);
    double source_at = monotonic_ms();
    if (options->eval_source) {
      result = evaluate(runtime, options->eval_source, strlen(options->eval_source), "nuttx:eval");
    }
    else if (!source && !options->entry && errno == ENOENT) {
      /* 默认欢迎页逐字复用原ESP-IDF资源，应用缺失也保留远程服务与动画。 */
      const struct px_builtin_app *welcome = px_builtin_app_get(PX_BUILTIN_WELCOME);
      result = evaluate(runtime, "console.log('PixelBox NuttX ready; builtin welcome starting.');",
                         strlen("console.log('PixelBox NuttX ready; builtin welcome starting.');"), "nuttx:welcome-start");
      if (!result && welcome) result = evaluate(runtime, welcome->source, welcome->length, welcome->filename);
      else if (!welcome) result = -1;
    }
    else if (!source) {
      char line[PATH_MAX + 96];
      snprintf(line, sizeof(line), "[pixelbox] %s: %s", entry, strerror(errno));
      report_runtime_log(runtime, "error", "runtime", line);
      result = -1;
    }
    else {
      result = evaluate(runtime, (const char *)source, size, entry);
      free(source);
    }
    double evaluated_at = monotonic_ms();
    if (runtime->service_vm) {
      char line[256];
      snprintf(line, sizeof(line),
               "[pixelbox] VM startup: install=%.0f ms source=%.0f ms eval=%.0f ms total=%.0f ms entry=%s",
               installed_at - startup_began, source_at - installed_at,
               evaluated_at - source_at, evaluated_at - startup_began,
               options->eval_source ? "builtin" : "app");
      report_runtime_log(runtime, "info", "runtime", line);
    }
    if (!result) result = event_loop(runtime);
  }
  double cleanup_began = cleanup_progress(runtime, "app-return", monotonic_ms());
  /* 生命周期退出钩子仍在同一个 VM/线程执行，并具有独立超时上限。 */
  runtime->stopped = 0;
  runtime->exiting = true;
  runtime->runtime_deadline = 0;
  const char *exit_script = "if (globalThis.__pxRunExit) __pxRunExit();";
  if (evaluate(runtime, exit_script, strlen(exit_script), "nuttx:exit")) result = -1;
  cleanup_began = cleanup_progress(runtime, "onExit", cleanup_began);
  for (int i = 0; i < PX_MAX_TIMERS; ++i)
    if (runtime->timers[i].id) free_timer(runtime->ctx, &runtime->timers[i]);
  for (int i = 0; i < PX_MAX_REJECTIONS; ++i) {
    JS_FreeValue(runtime->ctx, runtime->rejections[i]);
    JS_FreeValue(runtime->ctx, runtime->rejected_promises[i]);
  }
  cleanup_began = cleanup_progress(runtime, "timer-rejection-refs", cleanup_began);
  px_system_keys_vm_detach();
  cleanup_began = cleanup_progress(runtime, "keys-detach", cleanup_began);
  px_close_framebuffer();
  cleanup_began = cleanup_progress(runtime, "framebuffer-close", cleanup_began);
#ifdef PX_MULTINET7
  /* 模型由独立 kernel task 拥有；旧 VM 退出必须停止它，超时保留 worker 监督。 */
  px_wakeword_stop(0);
#endif
  px_mic_stop();
  px_audio_shutdown();
  cleanup_began = cleanup_progress(runtime, "peripheral-stop", cleanup_began);

  /*
   * 三个外设 worker 是并行停止的，等待也必须共享同一个总预算。
   * 之前分别传 2000ms，任一 worker 卡住都会把切页延迟叠加到约 6 秒，
   * 用户看到的就是“按键没有反应”。按统一截止时间计算剩余时间，
   * 既保留 worker 未退出时的错误状态，也把一次 VM 切换的最长等待限制在 2 秒。
   */
  const double quiesce_deadline = monotonic_ms() + 2000.0;
  double remaining = 0;
  int mic_idle = 0;
  int audio_idle = 0;
#ifdef PX_MULTINET7
  int wakeword_idle = 0;
  remaining = quiesce_deadline - monotonic_ms();
  wakeword_idle = px_wakeword_quiesce(remaining > 0 ? (unsigned)remaining : 0);
  if (wakeword_idle) {
    char line[112];
    snprintf(line, sizeof(line), "[pixelbox] wakeword cleanup incomplete: %d", wakeword_idle);
    report_runtime_log(runtime, "warn", "cleanup", line);
    result = -1;
  }
  cleanup_began = cleanup_progress(runtime, "wakeword-quiesce", cleanup_began);
#endif
  /* 清理超时不伪装成功；仍占用DMA的worker继续接受自己的硬件看门狗监督。 */
  remaining = quiesce_deadline - monotonic_ms();
  mic_idle = px_mic_quiesce(remaining > 0 ? (unsigned)remaining : 0);
  cleanup_began = cleanup_progress(runtime, "mic-quiesce", cleanup_began);
  remaining = quiesce_deadline - monotonic_ms();
  audio_idle = px_audio_quiesce(remaining > 0 ? (unsigned)remaining : 0);
  cleanup_began = cleanup_progress(runtime, "audio-quiesce", cleanup_began);
  if (mic_idle || audio_idle) {
    char line[128];
    snprintf(line, sizeof(line), "[pixelbox] peripheral cleanup incomplete: mic=%d audio=%d", mic_idle, audio_idle);
    report_runtime_log(runtime, "warn", "cleanup", line);
    result = -1;
  }
  JS_FreeContext(runtime->ctx);
  cleanup_began = cleanup_progress(runtime, "JS_FreeContext", cleanup_began);
  JS_FreeRuntime(runtime->rt);
  (void)cleanup_progress(runtime, "JS_FreeRuntime", cleanup_began);
  px_service_vm_leave(runtime->service_vm);
  finish_watchdog(runtime);
  free(runtime);
  return result ? 1 : 0;
}

int px_run(const struct px_options *options)
{
  if (pthread_mutex_trylock(&vm_lock)) {
    report_runtime_log(NULL, "warn", "runtime",
                       "[pixelbox] EBUSY: another application VM owns the hardware; stop it through devd first");
    return 1;
  }
  int result = run_locked(options);
  pthread_mutex_unlock(&vm_lock);
  return result;
}

int px_runtime_lock_for_sleep(void)
{
  int result = pthread_mutex_trylock(&vm_lock);
  return result ? -result : 0;
}

void px_runtime_unlock_after_sleep_failure(void)
{
  pthread_mutex_unlock(&vm_lock);
}
