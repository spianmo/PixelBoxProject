/* 真实devd+QuickJS应用线程：模拟runtime接线，验证监督者不跨线程执行JS与安全重启。 */
#include "pixelbox_service.h"
#include "pixelbox_builtin_apps.h"
#include "pixelbox_system_keys.h"
#include "quickjs.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop_requested;
static atomic_uint applications, generation;
static _Atomic(struct px_service_vm *) published_vm;
static struct px_service *running_service;
static int supervisor_result;
static unsigned network_reads;
static uint64_t last_network_read;
static pthread_mutex_t key_lock = PTHREAD_MUTEX_INITIALIZER;
static struct px_system_key_request pending_key;
static int key_queue_error;
static unsigned key_queue_polls;
static bool in_settings, provisioning_enabled, in_provisioning;
#ifdef PX_SERVICE_PORTAL_FIXTURE
static void service_portal_check_vm_start(void);
static void service_portal_install(JSContext *ctx, JSValue global);
#endif
void px_system_keys_set_settings(bool value)
{
  pthread_mutex_lock(&key_lock); in_settings = value; pthread_mutex_unlock(&key_lock);
}
void px_system_keys_set_provisioning_enabled(bool value)
{ pthread_mutex_lock(&key_lock); provisioning_enabled = value; if (!value) in_provisioning = false; pthread_mutex_unlock(&key_lock); }
void px_system_keys_set_provisioning_active(bool value)
{ pthread_mutex_lock(&key_lock); in_provisioning = value && provisioning_enabled; pthread_mutex_unlock(&key_lock); }
int px_system_keys_next_action(struct px_system_key_request *request)
{
  pthread_mutex_lock(&key_lock);
  ++key_queue_polls;
  if (key_queue_error) {
    int result = key_queue_error;
    pthread_mutex_unlock(&key_lock); return result;
  }
  *request = pending_key; int taken = pending_key.action != PX_SYSTEM_KEY_NONE;
  memset(&pending_key, 0, sizeof(pending_key));
  pthread_mutex_unlock(&key_lock); return taken;
}
const struct px_builtin_app *px_builtin_app_get(enum px_builtin_app_id id)
{
  static const char source[] = "globalThis.version='settings';log('settings loaded');";
  static const struct px_builtin_app settings = {source, sizeof(source) - 1, "<fixture:settings>", ""};
  return id == PX_BUILTIN_SETTINGS ? &settings : NULL;
}
static JSValue system_action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  int32_t action = PX_SYSTEM_KEY_OPEN_SETTINGS;
  if (argc && JS_ToInt32(ctx, &action, argv[0])) return JS_EXCEPTION;
  pthread_mutex_lock(&key_lock);
  if (pending_key.action) {
    pthread_mutex_unlock(&key_lock); return JS_ThrowInternalError(ctx, "test key slot busy");
  }
  pending_key.action = action;
  pending_key.result = action == PX_SYSTEM_KEY_DEEP_SLEEP ||
    (action == PX_SYSTEM_KEY_OPEN_PROVISIONING && !provisioning_enabled) ? -ENOTSUP : 0;
  pthread_mutex_unlock(&key_lock);
  return JS_UNDEFINED;
}
static JSValue settings_mode(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  pthread_mutex_lock(&key_lock); bool value = in_settings; pthread_mutex_unlock(&key_lock);
  return JS_NewBool(ctx, value);
}
static JSValue system_queue(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc) {
    pthread_mutex_lock(&key_lock); unsigned polls = key_queue_polls; pthread_mutex_unlock(&key_lock);
    return JS_NewUint32(ctx, polls);
  }
  const char *state = JS_ToCString(ctx, argv[0]);
  if (!state) return JS_EXCEPTION;
  int error;
  if (!strcmp(state, "ok")) error = 0;
  else if (!strcmp(state, "again")) error = -EAGAIN;
  else if (!strcmp(state, "io")) error = -EIO;
  else if (!strcmp(state, "absent")) error = -ENODEV;
  else if (!strcmp(state, "unsupported")) error = -ENOTSUP;
  else { JS_FreeCString(ctx, state); return JS_ThrowRangeError(ctx, "unknown key queue state"); }
  JS_FreeCString(ctx, state);
  pthread_mutex_lock(&key_lock); key_queue_error = error; key_queue_polls = 0; pthread_mutex_unlock(&key_lock);
  return JS_NewInt32(ctx, error);
}
static void stop_signal(int value) { (void)value; stop_requested = 1; }
static void pause_ms(unsigned ms)
{
  struct timespec duration = {ms / 1000, (long)(ms % 1000) * 1000000};
  while (nanosleep(&duration, &duration) && errno == EINTR) {}
}
static int interrupt(JSRuntime *runtime, void *opaque)
{
  (void)runtime; return px_service_vm_should_stop(opaque);
}
static JSValue log_value(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  const char *text = argc ? JS_ToCString(ctx, argv[0]) : NULL;
  px_service_vm_log(JS_GetContextOpaque(ctx), "info", "app", text ? text : "");
  JS_FreeCString(ctx, text); return JS_UNDEFINED;
}
static JSValue hold_value(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; int32_t duration = 100;
  if (argc && JS_ToInt32(ctx, &duration, argv[0])) return JS_EXCEPTION;
  if (duration < 0 || duration > 500) return JS_ThrowRangeError(ctx, "invalid test hold");
  pause_ms((unsigned)duration); return JS_UNDEFINED;
}
static JSValue active_count(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv; return JS_NewUint32(ctx, atomic_load(&applications));
}
static int run_app(const struct px_options *options)
{
#ifdef PX_SERVICE_PORTAL_FIXTURE
  service_portal_check_vm_start();
#endif
  struct px_service_vm *vm = px_service_vm_current(); assert(vm);
  atomic_store(&published_vm, vm);
  assert(atomic_fetch_add(&applications, 1) == 0);
  unsigned instance = atomic_fetch_add(&generation, 1) + 1;
  char path[1024]; char *source; long size;
  if (options->eval_source) {
    strcpy(path, "<fixture:settings>"); source = strdup(options->eval_source); assert(source);
    size = (long)strlen(source);
  } else {
    assert(snprintf(path, sizeof(path), "%s/%s", options->app_root, options->entry) < (int)sizeof(path));
    FILE *file = fopen(path, "rb"); assert(file && !fseek(file, 0, SEEK_END));
    size = ftell(file); assert(size >= 0 && size < 1000000 && !fseek(file, 0, SEEK_SET));
    source = malloc((size_t)size + 1); assert(source && fread(source, 1, (size_t)size, file) == (size_t)size);
    fclose(file); source[size] = 0;
  }
  JSRuntime *runtime = JS_NewRuntime(); assert(runtime); JS_SetMaxStackSize(runtime, 512 * 1024);
  JS_SetInterruptHandler(runtime, interrupt, vm);
  JSContext *ctx = JS_NewContext(runtime); assert(ctx); JS_SetContextOpaque(ctx, vm);
  JSValue global = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, global, "generation", JS_NewUint32(ctx, instance));
  JS_SetPropertyStr(ctx, global, "log", JS_NewCFunction(ctx, log_value, "log", 1));
  JS_SetPropertyStr(ctx, global, "hold", JS_NewCFunction(ctx, hold_value, "hold", 1));
  JS_SetPropertyStr(ctx, global, "activeCount", JS_NewCFunction(ctx, active_count, "activeCount", 0));
  JS_SetPropertyStr(ctx, global, "systemAction", JS_NewCFunction(ctx, system_action, "systemAction", 1));
  JS_SetPropertyStr(ctx, global, "settingsMode", JS_NewCFunction(ctx, settings_mode, "settingsMode", 0));
  JS_SetPropertyStr(ctx, global, "systemQueue", JS_NewCFunction(ctx, system_queue, "systemQueue", 1));
#ifdef PX_SERVICE_PORTAL_FIXTURE
  service_portal_install(ctx, global);
#endif
  JS_FreeValue(ctx, global);
  JSValue boot = JS_Eval(ctx, source, (size_t)size, path, JS_EVAL_TYPE_GLOBAL);
  free(source); int result = JS_IsException(boot) ? 1 : 0;
  if (result) { JSValue error = JS_GetException(ctx); JS_FreeValue(ctx, error); }
  JS_FreeValue(ctx, boot);
  if (!result) result = px_service_vm_enter(vm);
  if (!result) {
    char text[64]; snprintf(text, sizeof(text), "app-start %u", instance); px_service_vm_log(vm, "info", "fixture", text);
    while (!px_service_vm_should_stop(vm)) {
      struct px_service_eval request;
      int taken = px_service_vm_take_eval(vm, &request); assert(taken >= 0);
      if (taken) {
        JSValue value = JS_Eval(ctx, request.code, strlen(request.code), "devd:eval", JS_EVAL_TYPE_GLOBAL);
        bool success = !JS_IsException(value);
        if (!success) value = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, value);
        int completed = px_service_vm_complete_eval(vm, request.token, success, text ? text : "");
        if (completed == -EFBIG) completed = px_service_vm_complete_eval(vm, request.token, false, "eval result too large");
        assert(completed == 0 || completed == -ECANCELED);
        JS_FreeCString(ctx, text); JS_FreeValue(ctx, value); px_service_eval_free(&request);
      }
      JSContext *job_ctx;
      while (JS_IsJobPending(runtime)) {
        if (JS_ExecutePendingJob(runtime, &job_ctx) < 0) { JSValue error = JS_GetException(job_ctx); JS_FreeValue(job_ctx, error); break; }
      }
      pause_ms(1);
    }
  }
  /* 清理包含刻意的20ms延迟；监督者必须等清理完成，不能仅看到stop标记就启动下一代。 */
  pause_ms(20); JS_FreeContext(ctx); JS_FreeRuntime(runtime);
  char text[64]; snprintf(text, sizeof(text), "app-end %u", instance); px_service_vm_log(vm, "info", "fixture", text);
  px_service_vm_leave(vm);
  atomic_store(&published_vm, NULL);
  assert(atomic_fetch_sub(&applications, 1) == 1);
  return result;
}
static void *supervisor(void *opaque)
{
  supervisor_result = px_service_run(opaque); return NULL;
}
static int read_network(void *opaque, struct px_service_network *out)
{
  assert(opaque == &network_reads);
  struct timespec now; assert(!clock_gettime(CLOCK_MONOTONIC, &now));
  uint64_t milliseconds = (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
  if (network_reads) assert(milliseconds - last_network_read >= 1000);
  last_network_read = milliseconds; ++network_reads;
  strcpy(out->ip, network_reads == 1 ? "0.0.0.0" : "192.0.2.16");
  strcpy(out->mac, "00:11:22:33:44:55"); out->heap_free = 32123;
  return 0;
}
static unsigned fd_count(void)
{
  unsigned count = 0;
  for (int fd = 0; fd < 1024; ++fd) if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) ++count;
  return count;
}
int main(int argc, char **argv)
{
  if (argc != 2) return 2;
  unsigned baseline = fd_count(); signal(SIGTERM, stop_signal); signal(SIGINT, stop_signal);
  struct px_service_config config = {
    .devd = {.storage_root = argv[1], .name = "service-fixture", .model = "host", .firmware = "1.0.0", .ip = "127.0.0.1"},
    .app = {.heap_limit = 8 * 1024 * 1024, .turn_timeout_ms = 1000},
    .run_app = run_app, .start_on_boot = true,
    .network_status = read_network, .network_opaque = &network_reads
  };
#ifndef PX_SERVICE_PORTAL
  config.enable_portal = true;
  assert(px_service_create(&config, &running_service) == -ENOTSUP && !running_service);
  config.enable_portal = false;
#endif
  assert(!px_service_create(&config, &running_service));
  struct px_service *duplicate = NULL; assert(px_service_create(&config, &duplicate) == -EBUSY && !duplicate);
  pthread_t thread; assert(!pthread_create(&thread, NULL, supervisor, running_service));
  struct px_service_status status;
  do { pause_ms(1); assert(!px_service_get_status(running_service, &status)); } while (!status.supervising);
  assert(px_service_destroy(running_service) == -EBUSY);
  printf("%u\n", px_service_port(running_service)); fflush(stdout);
  while (!stop_requested) {
    /* 主线程代表非托管诊断VM：既得不到managed句柄，也不会消费任何远端EVAL。 */
    assert(!px_service_vm_current()); assert(!px_service_vm_should_stop(NULL));
    assert(!px_service_vm_enter(NULL)); struct px_service_eval ignored;
    assert(!px_service_vm_take_eval(NULL, &ignored));
    struct px_service_vm *foreign = atomic_load(&published_vm);
    if (foreign) {
      assert(px_service_vm_enter(foreign) == -EPERM);
      assert(px_service_vm_take_eval(foreign, &ignored) == -EPERM);
      assert(px_service_vm_complete_eval(foreign, 1, true, "foreign") == -EPERM);
      px_service_vm_log(foreign, "info", "forbidden", "foreign caller");
    }
    pause_ms(2);
  }
  px_service_request_shutdown(running_service); assert(!pthread_join(thread, NULL));
  assert(!supervisor_result && atomic_load(&applications) == 0);
  assert(!px_service_get_status(running_service, &status) && !status.supervising && !status.app_present);
  assert(px_service_run(running_service) == -EBUSY);
  assert(!px_service_destroy(running_service)); running_service = NULL;
  /* 退出后可重建监督者；create但未run也能直接销毁，不残留网络/pipe fd。 */
  config.start_on_boot = false;
  config.network_status = NULL;
  for (unsigned i = 0; i < 3; ++i) {
    assert(!px_service_create(&config, &running_service));
    if (i == 1) { px_service_request_shutdown(running_service); assert(!px_service_run(running_service)); }
    assert(!px_service_destroy(running_service));
  }
  assert(fd_count() == baseline);
  fprintf(stderr, "service fixture通过：单VM、非托管隔离、协作退出、重复启动/销毁与fd回收\n");
  return 0;
}
