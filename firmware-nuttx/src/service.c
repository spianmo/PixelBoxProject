/* 常驻监督者拥有devd动作；托管VM在独立任务中协作退出，不跨线程访问任何JSValue。 */
#ifdef __NuttX__
#include <nuttx/config.h>
#include <sched.h>
#include <semaphore.h>
#include <sys/wait.h>
#endif
#include "pixelbox_service.h"
#include "pixelbox_builtin_apps.h"
#include "pixelbox_system_keys.h"
#include "pixelbox_sleep.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifdef __NuttX__
#include <nuttx/atomic.h>
#else
#include <stdatomic.h>
#endif

#define SERVICE_ROOT_BYTES 512u
#define SERVICE_ENTRY_BYTES 256u
#define SERVICE_CONTROL_POLL_MS 25u

/* 显式编译开关避免默认 host/旧固件引入门户链接依赖；运行时还需 enable_portal。 */
#ifndef PX_SERVICE_PORTAL
#define px_portal_init(config) ((void)(config), -ENOTSUP)
#define px_portal_request_start() (-ENOTSUP)
#define px_portal_take_request(request) ((void)(request), -ENOTSUP)
#define px_portal_begin() (-ENOTSUP)
#define px_portal_stop() (-ENOTSUP)
#define px_portal_get_status(status) ((void)(status), -ENOTSUP)
#define px_portal_reap() (-ENOTSUP)
#define px_portal_shutdown() (-ENOTSUP)
#endif

struct px_service_vm {
  struct px_service *service;
  struct px_options options;
  char root[SERVICE_ROOT_BYTES], entry[SERVICE_ENTRY_BYTES];
  pthread_t owner;
#ifdef __NuttX__
  pid_t task;
#else
  pthread_t thread;
#endif
#ifdef __NuttX__
  /* Xtensa使用NuttX的32位原子API，避免C11宏冲突和未提供的字节原子符号。 */
  atomic_t stop;
#else
  atomic_bool stop;
#endif
  bool active, finished, settings;
  int result;
  struct px_service_eval queue[PX_SERVICE_EVAL_CAPACITY];
  unsigned queue_head, queue_count;
  uint64_t inflight;
};
struct px_service {
  pthread_mutex_t lock;
#ifdef __NuttX__
  sem_t wake;
#else
  int wake[2];
#endif
  struct px_devd *devd;
  struct px_options options;
  char fallback_root[SERVICE_ROOT_BYTES], fallback_entry[SERVICE_ENTRY_BYTES];
  char data_root[SERVICE_ROOT_BYTES];
  int (*run_app)(const struct px_options *options);
  int (*network_status)(void *opaque, struct px_service_network *out);
  void *network_opaque;
  uint64_t next_network_ms;
  bool start_on_boot, started, running, shutting_down;
  int priority, last_result;
  int last_key_queue_error;
  uint64_t generation;
  struct px_service_vm *app;
  uint64_t push_token;
  bool push_paused,push_resume,push_launch,push_settings;
  bool enable_portal, portal_initialized, portal_pending;
  struct px_portal_config portal_config;
  char credentials_path[SERVICE_ROOT_BYTES];
  struct px_portal_status portal_status;
  int (*prepare_sleep)(void *opaque, uint32_t duration_ms);
  void *sleep_opaque;
  uint32_t sleep_duration_ms;
  uint64_t sleep_deadline_ms;
  bool sleep_ready;
  int sleep_error;
};
/* 不依赖CONFIG_TLS_NELEM。只有wrapper登记的app线程能取得当前句柄，NSH调用返回NULL。 */
static pthread_mutex_t registry_lock = PTHREAD_MUTEX_INITIALIZER;
static struct px_service *registered_service;
static struct px_service_vm *registered_vm;

static int create_wake(struct px_service *service)
{
#ifdef __NuttX__
  return sem_init(&service->wake, 0, 0) ? -errno : 0;
#else
  if (pipe(service->wake)) return -errno;
  int flags = fcntl(service->wake[1], F_GETFL, 0);
  if (flags >= 0 && !fcntl(service->wake[1], F_SETFL, flags | O_NONBLOCK)) return 0;
  int result = -errno; close(service->wake[0]); close(service->wake[1]); return result;
#endif
}
static void destroy_wake(struct px_service *service)
{
#ifdef __NuttX__
  sem_destroy(&service->wake);
#else
  close(service->wake[0]); close(service->wake[1]);
#endif
}
static uint64_t monotonic_ms(void)
{
  struct timespec time; clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000 + (uint64_t)time.tv_nsec / 1000000;
}
static int wait_for_wake(struct px_service *service, unsigned timeout_ms)
{
#ifdef __NuttX__
  struct timespec deadline;
  if (clock_gettime(CLOCK_MONOTONIC, &deadline)) return -errno;
  deadline.tv_nsec += (long)(timeout_ms % 1000) * 1000000;
  deadline.tv_sec += timeout_ms / 1000 + deadline.tv_nsec / 1000000000;
  deadline.tv_nsec %= 1000000000;
  int result;
  do { result = sem_clockwait(&service->wake, CLOCK_MONOTONIC, &deadline); } while (result && errno == EINTR);
  return result && errno != ETIMEDOUT ? -errno : 0;
#else
  uint64_t deadline = monotonic_ms() + timeout_ms;
  struct pollfd descriptor = {.fd = service->wake[0], .events = POLLIN};
  for (;;) {
    uint64_t now = monotonic_ms(); int remaining = now < deadline ? (int)(deadline - now) : 0;
    int polled = poll(&descriptor, 1, remaining);
    if (!polled) return 0;
    if (polled < 0) { if (errno == EINTR) continue; return -errno; }
    if (!(descriptor.revents & POLLIN)) return -EIO;
    break;
  }
  char notifications[64]; ssize_t result;
  do { result = read(service->wake[0], notifications, sizeof(notifications)); } while (result < 0 && errno == EINTR);
  return result > 0 ? 0 : result < 0 ? -errno : -EIO;
#endif
}
static void refresh_network(struct px_service *service)
{
  uint64_t now = monotonic_ms();
  if (!service->network_status || now < service->next_network_ms) return;
  service->next_network_ms = now + 1000;
  struct px_service_network network = {0};
  /* 回调由main注入且只读缓存，不持service锁，不把Wi-Fi实现耦合进监督器。 */
  if (!service->network_status(service->network_opaque, &network) &&
      memchr(network.ip, 0, sizeof(network.ip)) && memchr(network.mac, 0, sizeof(network.mac)))
    px_devd_network(service->devd, network.ip, network.mac, network.heap_free);
}

static int copy_option(char *buffer, size_t capacity, const char *source, const char **target)
{
  if (!source) { *target = NULL; return 0; }
  size_t length = strlen(source);
  if (length >= capacity) return -ENAMETOOLONG;
  memcpy(buffer, source, length + 1); *target = buffer; return 0;
}
static void notify_service(void *opaque)
{
  struct px_service *service = opaque;
#ifdef __NuttX__
  (void)sem_post(&service->wake);
#else
  /* 非阻塞pipe在macOS/NuttX均可用；缓冲已满表示已有唤醒，不取锁或访问JS。 */
  const char byte = 1;
  ssize_t written; do { written = write(service->wake[1], &byte, 1); } while (written < 0 && errno == EINTR);
#endif
}
struct px_service_vm *px_service_vm_current(void)
{
  pthread_mutex_lock(&registry_lock);
  struct px_service_vm *vm = registered_vm;
  if (vm && !pthread_equal(vm->owner, pthread_self())) vm = NULL;
  pthread_mutex_unlock(&registry_lock); return vm;
}
static bool owns_vm(struct px_service_vm *vm) { return vm && px_service_vm_current() == vm; }
bool px_service_vm_should_stop(const struct px_service_vm *vm)
{
  /* QuickJS interrupt回调只能走这条只读路径；不喂watchdog、不取锁、不取邮箱。 */
#ifdef __NuttX__
  return vm && atomic_read_acquire(&vm->stop);
#else
  return vm && atomic_load_explicit(&vm->stop, memory_order_acquire);
#endif
}
void px_service_eval_free(struct px_service_eval *request)
{
  if (request) { free(request->code); request->code = NULL; request->token = 0; }
}
static void fail_eval(struct px_service *service, uint64_t token, const char *message)
{
  if (!token) return;
  int result = px_devd_complete_eval(service->devd, token, false, message);
  if (result) px_devd_log(service->devd, "warn", "service", "eval completion queue unavailable");
}
/* 调用者持有service锁。已take的code仍属于VM，只取消token；绝不跨线程释放在执行的code。 */
static void cancel_evals_locked(struct px_service_vm *vm, const char *message)
{
  while (vm->queue_count) {
    struct px_service_eval *request = &vm->queue[vm->queue_head];
    fail_eval(vm->service, request->token, message); px_service_eval_free(request);
    vm->queue_head = (vm->queue_head + 1) % PX_SERVICE_EVAL_CAPACITY; --vm->queue_count;
  }
  if (vm->inflight) { fail_eval(vm->service, vm->inflight, message); vm->inflight = 0; }
}
static void stop_app_locked(struct px_service *service)
{
  if (!service->app) return;
#ifdef __NuttX__
  atomic_set_release(&service->app->stop, 1);
#else
  atomic_store_explicit(&service->app->stop, true, memory_order_release);
#endif
  cancel_evals_locked(service->app, "application stopping");
}
int px_service_vm_enter(struct px_service_vm *vm)
{
  if (!vm) return 0;
  if (!owns_vm(vm)) return -EPERM;
  struct px_service *service = vm->service;
  pthread_mutex_lock(&service->lock);
  int result = vm->active ? -EALREADY : px_service_vm_should_stop(vm) ? -ECANCELED : 0;
  if (!result) {
    vm->active = true;
    px_system_keys_set_settings(vm->settings);
    px_devd_state(service->devd, "running", NULL);
  }
  pthread_mutex_unlock(&service->lock); return result;
}
int px_service_vm_request_sleep(struct px_service_vm *vm, uint32_t duration_ms)
{
  if (!duration_ms || duration_ms > PX_SLEEP_MAX_MS) return -EINVAL;
  if (!vm) return -ENODEV;
  if (!owns_vm(vm)) return -EPERM;
  struct px_service *service = vm->service;
  pthread_mutex_lock(&service->lock);
  int result = !service->prepare_sleep ? -ENOTSUP : service->sleep_duration_ms || service->push_token ? -EBUSY :
    service->shutting_down || !vm->active || px_service_vm_should_stop(vm) ? -ECANCELED : 0;
  if (!result) {
    service->sleep_duration_ms = duration_ms;
    service->sleep_deadline_ms = monotonic_ms() + PX_SLEEP_CLEANUP_MS;
    service->sleep_error = 0;
    stop_app_locked(service);
  }
  pthread_mutex_unlock(&service->lock);
  if (!result) notify_service(service);
  return result;
}
void px_service_vm_leave(struct px_service_vm *vm)
{
  if (!owns_vm(vm)) return;
  pthread_mutex_lock(&vm->service->lock);
  vm->active = false; px_system_keys_set_settings(false);
  cancel_evals_locked(vm, "application stopped");
  pthread_mutex_unlock(&vm->service->lock);
}
int px_service_vm_take_eval(struct px_service_vm *vm, struct px_service_eval *out)
{
  if (!out) return -EINVAL;
  memset(out, 0, sizeof(*out));
  if (!vm) return 0;
  if (!owns_vm(vm)) return -EPERM;
  pthread_mutex_lock(&vm->service->lock);
  int result = 0;
  if (vm->inflight) result = -EBUSY;
  else if (vm->active && !px_service_vm_should_stop(vm) && vm->queue_count) {
    *out = vm->queue[vm->queue_head]; memset(&vm->queue[vm->queue_head], 0, sizeof(*out));
    vm->queue_head = (vm->queue_head + 1) % PX_SERVICE_EVAL_CAPACITY; --vm->queue_count;
    vm->inflight = out->token; result = 1;
  }
  pthread_mutex_unlock(&vm->service->lock); return result;
}
int px_service_vm_complete_eval(struct px_service_vm *vm, uint64_t token, bool success, const char *text)
{
  if (!vm || !token || !text) return -EINVAL;
  if (!owns_vm(vm)) return -EPERM;
  pthread_mutex_lock(&vm->service->lock);
  int result = vm->inflight != token ? -ECANCELED :
               px_devd_complete_eval(vm->service->devd, token, success, text);
  /* EFBIG/ENOMEM时保留token，让runtime可以用简短错误文本重试一次。 */
  if (!result) vm->inflight = 0;
  pthread_mutex_unlock(&vm->service->lock); return result;
}
void px_service_vm_abandon_eval(struct px_service_vm *vm, uint64_t token)
{
  if (!token || !owns_vm(vm)) return;
  pthread_mutex_lock(&vm->service->lock);
  if (vm->inflight == token) {
    fail_eval(vm->service, token, "eval completion unavailable");
    vm->inflight = 0; /* 即使devd极端OOM无法复制错误文本，也不能永久阻塞之后的EVAL。 */
  }
  pthread_mutex_unlock(&vm->service->lock);
}
void px_service_vm_log(struct px_service_vm *vm, const char *level, const char *tag, const char *message)
{
  if (owns_vm(vm)) px_devd_log(vm->service->devd, level, tag, message);
}
static int execute_app(struct px_service_vm *vm)
{
  vm->owner = pthread_self();
  pthread_mutex_lock(&registry_lock); registered_vm = vm; pthread_mutex_unlock(&registry_lock);
  int result = px_service_vm_should_stop(vm) ? 0 : vm->service->run_app(&vm->options);
  px_service_vm_leave(vm);
  pthread_mutex_lock(&registry_lock); registered_vm = NULL; pthread_mutex_unlock(&registry_lock);
  pthread_mutex_lock(&vm->service->lock); vm->result = result; vm->finished = true;
  pthread_mutex_unlock(&vm->service->lock);
  notify_service(vm->service); return result;
}
#ifdef __NuttX__
static int app_task(int argc, char *argv[])
{
  if (argc != 2 || !argv[1]) return 2;
  char *end; errno = 0; unsigned long long value = strtoull(argv[1], &end, 16);
  if (errno || *end || !value || value > UINTPTR_MAX) return 2;
  return execute_app((struct px_service_vm *)(uintptr_t)value);
}
#else
static void *app_thread(void *argument) { (void)execute_app(argument); return NULL; }
#endif
static int launch_app(struct px_service *service, bool settings)
{
  struct px_service_vm *vm = calloc(1, sizeof(*vm));
  if (!vm) return -ENOMEM;
  vm->service = service; vm->options = service->options; vm->settings = settings;
#ifdef __NuttX__
  atomic_set(&vm->stop, 0);
#else
  atomic_init(&vm->stop, false);
#endif
  int result = px_devd_current_app(service->devd, vm->root, sizeof(vm->root), vm->entry, sizeof(vm->entry));
  if (result == -ENOENT && service->options.app_root) {
    memcpy(vm->root, service->options.app_root, strlen(service->options.app_root) + 1);
    /* 回退未指定entry时保留NULL，让runtime在main.js不存在时保留welcome/自动联网。 */
    if (service->options.entry)
      memcpy(vm->entry, service->options.entry, strlen(service->options.entry) + 1);
    result = 0;
  }
  if (settings) {
    const struct px_builtin_app *builtin = px_builtin_app_get(PX_BUILTIN_SETTINGS);
    if (!builtin || !builtin->source || !builtin->length) { free(vm); return -ENOENT; }
    /* 设置运行在自己的VM；只借用当前应用的资源根，不改current/prev或已安装manifest。 */
    if (result == -ENOENT) {
      const char *root = service->options.app_root ? service->options.app_root : "/data/app";
      memcpy(vm->root, root, strlen(root) + 1); result = 0;
    }
    vm->options.eval_source = builtin->source;
    vm->entry[0] = 0;
  }
  if (result) { free(vm); return result; }
  vm->options.app_root = vm->root;
  vm->options.entry = vm->entry[0] ? vm->entry : NULL;
  pthread_mutex_lock(&service->lock);
  if (service->app || service->shutting_down) { pthread_mutex_unlock(&service->lock); free(vm); return -ECANCELED; }
  service->app = vm; ++service->generation; px_devd_state(service->devd, "updating", NULL);
  pthread_mutex_unlock(&service->lock);
#ifdef __NuttX__
  char pointer[2 + sizeof(uintptr_t) * 2 + 1]; snprintf(pointer, sizeof(pointer), "%p", (void *)vm);
  char *arguments[] = {pointer, NULL};
  vm->task = task_create("pixelbox-app", service->priority, PX_SERVICE_APP_STACK_BYTES, app_task, arguments);
  result = vm->task < 0 ? -errno : 0;
#else
  pthread_attr_t attributes; result = pthread_attr_init(&attributes);
  if (!result) {
    result = pthread_attr_setstacksize(&attributes, PX_SERVICE_HOST_STACK_BYTES);
    if (!result) result = pthread_create(&vm->thread, &attributes, app_thread, vm);
    pthread_attr_destroy(&attributes);
  }
  result = -result;
#endif
  if (result) {
    pthread_mutex_lock(&service->lock); service->app = NULL; pthread_mutex_unlock(&service->lock);
    free(vm);
  }
  return result;
}
/* 只有监督线程join/waitpid；finished必须先成立，正常路径不会等待仍在执行JS的线程。 */
static void reap_finished(struct px_service *service)
{
  pthread_mutex_lock(&service->lock);
  struct px_service_vm *vm = service->app;
  bool finished = vm && vm->finished;
  pthread_mutex_unlock(&service->lock);
  if (!finished) return;
#ifdef __NuttX__
  int status;
  while (waitpid(vm->task, &status, 0) < 0 && errno == EINTR) {}
#else
  (void)pthread_join(vm->thread, NULL);
#endif
  pthread_mutex_lock(&service->lock);
  service->last_result = vm->result; service->app = NULL;
  if (vm->result && !px_service_vm_should_stop(vm)) {
    char message[64]; snprintf(message, sizeof(message), "application exited (%d)", vm->result);
    px_devd_state(service->devd, "crashed", message);
  } else px_devd_state(service->devd, "stopped", NULL);
  pthread_mutex_unlock(&service->lock); free(vm);
}
static void dispatch_action(struct px_service *service, struct px_devd_action *action,
                            bool *restart, bool *settings)
{
  pthread_mutex_lock(&service->lock);
  if (action->type == PX_DEVD_PUSH_PREPARE) {
    int error = service->shutting_down || service->sleep_duration_ms ? -ECANCELED :
      service->push_token ? -EBUSY : 0;
    if (error) (void)px_devd_complete_push_pause(service->devd, action->token, error);
    else {
      service->push_token = action->token; service->push_paused = false;
      service->push_resume = *restart ||
        (service->app && !px_service_vm_should_stop(service->app));
      service->push_launch = true;
      service->push_settings = *settings; *restart = false;
      if (service->portal_initialized) {
        (void)px_portal_stop(); service->portal_pending = false;
      }
      stop_app_locked(service);
      px_devd_state(service->devd, "updating", NULL);
    }
  } else if (action->type == PX_DEVD_PUSH_COMMIT || action->type == PX_DEVD_PUSH_ABORT) {
    if (service->push_token == action->token) {
      bool committed = action->type == PX_DEVD_PUSH_COMMIT;
      *restart = !service->shutting_down && !service->sleep_duration_ms &&
        (committed ? service->push_launch : service->push_resume);
      *settings = committed ? false : service->push_settings;
      service->push_token = 0; service->push_paused = false;
    }
    px_devd_release_push(service->devd, action->token);
  } else if (action->type == PX_DEVD_SETTINGS) {
    /* 通过监督线程切换到内置设置 VM；旧 VM 必须先退出并完成 join。 */
    if (!service->shutting_down && !service->sleep_duration_ms && !service->push_token) {
      if (service->portal_initialized) {
        (void)px_portal_stop(); service->portal_pending = false;
      }
      *settings = true; *restart = true;
      stop_app_locked(service);
      px_devd_state(service->devd, "updating", NULL);
    }
  } else if (action->type == PX_DEVD_EVAL) {
    struct px_service_vm *vm = service->app;
    const char *error = service->shutting_down ? "service shutting down" :
      !vm || !vm->active || vm->finished ? "application stopped" :
      px_service_vm_should_stop(vm) ? "application stopping" :
      vm->queue_count + (vm->inflight ? 1u : 0u) >= PX_SERVICE_EVAL_CAPACITY ? "application eval queue full" : NULL;
    if (error) fail_eval(service, action->token, error);
    else {
      unsigned slot = (vm->queue_head + vm->queue_count) % PX_SERVICE_EVAL_CAPACITY;
      vm->queue[slot] = (struct px_service_eval){action->token, action->code}; ++vm->queue_count;
      action->code = NULL; /* 移交C字符串，action_free不能再释放。 */
    }
  } else if (action->type == PX_DEVD_RESTART || action->type == PX_DEVD_STOP) {
    if (service->portal_initialized) {
      /* 撤销未 begin 的授权及正在运行的会话；新 VM 仍需等待 ownership 释放。 */
      (void)px_portal_stop(); service->portal_pending = false;
    }
    *restart = action->type == PX_DEVD_RESTART && !service->shutting_down && !service->sleep_duration_ms;
    if (service->push_token) {
      /* 上传期间仍服从最后一次 STOP/RESTART，提交不能撤销用户的停止意图。 */
      service->push_resume = service->push_launch = *restart;
      if (*restart) service->push_settings = false;
    }
    if (*restart) *settings = false; /* 远程restart/push恢复已提交应用，不能被设置模式截留。 */
    stop_app_locked(service);
    /* SDK只有四种状态；旧VM尚未退出时用updating，不能提前声称已stopped。 */
    px_devd_state(service->devd, *restart || service->app ? "updating" : "stopped", NULL);
  }
  pthread_mutex_unlock(&service->lock); px_devd_action_free(action);
}
static void dispatch_system_keys(struct px_service *service, bool *restart, bool *settings)
{
  for (unsigned i = 0; i < PX_SYSTEM_KEYS_ACTION_CAPACITY; ++i) {
    struct px_system_key_request request;
    int taken = px_system_keys_next_action(&request);
    /* 队列故障是状态，不是每25ms生成的新事件；成功取值或空队列后重新允许
     * 报告同一故障。字段仅由监督线程访问，应用重启不能重置去重状态。 */
    int queue_error = taken < 0 ? taken : 0;
    bool error_changed = queue_error != service->last_key_queue_error;
    service->last_key_queue_error = queue_error;
    if (taken <= 0) {
      if (error_changed && taken && taken != -ENODEV && taken != -ENOTSUP) {
        char message[80]; snprintf(message, sizeof(message), "system key queue failed (%d)", taken);
        px_devd_log(service->devd, "warn", "keys", message);
      }
      break;
    }
    if (request.result < 0 ||
        (request.action != PX_SYSTEM_KEY_OPEN_SETTINGS && request.action != PX_SYSTEM_KEY_RETURN_APP &&
         request.action != PX_SYSTEM_KEY_OPEN_PROVISIONING)) {
      char message[96];
      snprintf(message, sizeof(message), "system key action %d unavailable (%d)",
               request.action, request.result < 0 ? request.result : -ENOTSUP);
      px_devd_log(service->devd, "warn", "keys", message);
      continue;
    }
    if (request.action == PX_SYSTEM_KEY_OPEN_PROVISIONING) {
      int result = service->portal_initialized ? px_portal_request_start() : -ENOTSUP;
      if (result) {
        char message[96]; snprintf(message, sizeof(message), "system key action %d unavailable (%d)", request.action, result);
        px_devd_log(service->devd, "warn", "keys", message);
      }
      continue;
    }
    pthread_mutex_lock(&service->lock);
    if (!service->shutting_down && !service->sleep_duration_ms && !service->push_token) {
      if (service->portal_initialized) {
        (void)px_portal_stop(); service->portal_pending = false;
      }
      *settings = request.action == PX_SYSTEM_KEY_OPEN_SETTINGS;
      *restart = true;
      stop_app_locked(service);
      px_devd_state(service->devd, "updating", NULL);
    }
    pthread_mutex_unlock(&service->lock);
  }
}
static void take_portal_request(struct px_service *service, bool *restart)
{
  if (!service->portal_initialized) return;
  enum px_portal_request request;
  if (px_portal_take_request(&request) != 1 || request != PX_PORTAL_REQUEST_START) return;
  pthread_mutex_lock(&service->lock);
  if (!service->shutting_down && !service->sleep_duration_ms && !service->push_token) {
    service->portal_pending = true;
    /* 暂停时记住用户应用/设置页的恢复意图；空闲进入则退出后仍空闲。 */
    *restart = *restart || service->app != NULL;
    stop_app_locked(service);
    px_devd_state(service->devd, "updating", NULL);
  } else (void)px_portal_stop();
  pthread_mutex_unlock(&service->lock);
}
static bool refresh_portal(struct px_service *service, bool present)
{
  if (!service->portal_initialized) return false;
  pthread_mutex_lock(&service->lock);
  bool begin = service->portal_pending && !present && !service->shutting_down &&
    !service->sleep_duration_ms && !service->push_token;
  if (begin) service->portal_pending = false;
  pthread_mutex_unlock(&service->lock);
  if (begin) {
    /* reap_finished 已 join/waitpid；旧 VM 的 Wi-Fi Promise/退出清理已结束。 */
    int result = px_portal_begin();
    if (result && result != -ECANCELED) {
      char message[80]; snprintf(message, sizeof(message), "portal start failed (%d)", result);
      px_devd_log(service->devd, "warn", "portal", message);
    }
  }
  /* 只有所有清理已完成才 join；先回收门户栈，再允许下一代 VM 分配内部栈。 */
  (void)px_portal_reap();
  struct px_portal_status status = {0};
  int result = px_portal_get_status(&status);
  pthread_mutex_lock(&service->lock);
  bool was_owned = service->portal_status.wifi_owned;
  if (!result) service->portal_status = status;
  else service->portal_status.error = result;
  /* 状态读取失败时不能证明 Wi-Fi 已释放，继续禁止启动 VM。 */
  bool owned = result || service->portal_status.wifi_owned || service->portal_pending;
  pthread_mutex_unlock(&service->lock);
  px_system_keys_set_provisioning_active(owned);
  /* 空闲进入后退出也要结束 updating；只在交接边界发事件，避免每轮刷屏。 */
  if (!present && (begin || was_owned != owned))
    px_devd_state(service->devd, owned ? "updating" : "stopped", NULL);
  return owned;
}
int px_service_create(const struct px_service_config *config, struct px_service **out)
{
  if (!config || !out || !config->run_app || config->app.eval_source ||
      config->app_priority < 0 || config->app_priority > 255) return -EINVAL;
  *out = NULL;
#ifndef PX_SERVICE_PORTAL
  if (config->enable_portal) return -ENOTSUP;
#endif
  struct px_service *service = calloc(1, sizeof(*service));
  if (!service) return -ENOMEM;
  service->options = config->app; service->run_app = config->run_app;
  service->network_status = config->network_status; service->network_opaque = config->network_opaque;
  service->enable_portal = config->enable_portal; service->portal_config = config->portal;
  service->prepare_sleep = config->prepare_sleep; service->sleep_opaque = config->sleep_opaque;
  service->start_on_boot = config->start_on_boot; service->priority = config->app_priority ? config->app_priority : 100;
  int result = copy_option(service->fallback_root, sizeof(service->fallback_root), config->app.app_root, &service->options.app_root);
  if (!result) result = copy_option(service->fallback_entry, sizeof(service->fallback_entry), config->app.entry, &service->options.entry);
  if (!result) result = copy_option(service->data_root, sizeof(service->data_root), config->app.data_root, &service->options.data_root);
  if (!result && config->enable_portal) result = copy_option(service->credentials_path, sizeof(service->credentials_path),
    config->portal.credentials_path, &service->portal_config.credentials_path);
  if (result) { free(service); return result; }
  result = pthread_mutex_init(&service->lock, NULL);
  if (result) { free(service); return -result; }
  result = create_wake(service);
  if (result) { pthread_mutex_destroy(&service->lock); free(service); return result; }
  pthread_mutex_lock(&registry_lock);
  if (registered_service) result = -EBUSY; else registered_service = service;
  pthread_mutex_unlock(&registry_lock);
  if (!result) {
    struct px_devd_config devd = config->devd; devd.notify_action = notify_service; devd.opaque = service;
    result = px_devd_start(&devd, &service->devd);
  }
  if (result) {
    pthread_mutex_lock(&registry_lock); if (registered_service == service) registered_service = NULL;
    pthread_mutex_unlock(&registry_lock);
    destroy_wake(service); pthread_mutex_destroy(&service->lock); free(service); return result;
  }
  *out = service; return 0;
}
int px_service_run(struct px_service *service)
{
  if (!service) return -EINVAL;
  pthread_mutex_lock(&service->lock);
  if (service->started) { pthread_mutex_unlock(&service->lock); return -EBUSY; }
  service->started = service->running = true;
  pthread_mutex_unlock(&service->lock);
  bool restart = service->start_on_boot, settings = false, portal_stop_requested = false; int result = 0;
  if (service->enable_portal) {
    int initialized = px_portal_init(&service->portal_config);
    pthread_mutex_lock(&service->lock);
    service->portal_initialized = initialized == 0; service->portal_status.error = initialized;
    pthread_mutex_unlock(&service->lock);
    px_system_keys_set_provisioning_enabled(initialized == 0);
    if (initialized) {
      char message[80]; snprintf(message, sizeof(message), "portal unavailable (%d)", initialized);
      px_devd_log(service->devd, "warn", "portal", message);
      /* 初始化失败不得冒认其他 singleton 的 ownership 或启动竞争 Wi-Fi 的 VM。 */
      result = initialized; restart = false; px_service_request_shutdown(service);
    }
  }
  for (;;) {
    refresh_network(service);
    reap_finished(service);
    dispatch_system_keys(service, &restart, &settings);
    take_portal_request(service, &restart);
    /* 每轮最多8个动作，连续网络流量也不能饿死已退出应用的回收。 */
    for (unsigned i = 0; i < 8; ++i) {
      struct px_devd_action action;
      int taken = px_devd_take_action(service->devd, &action);
      if (taken <= 0) break;
      dispatch_action(service, &action, &restart, &settings);
    }
    pthread_mutex_lock(&service->lock);
    bool exiting = service->shutting_down;
    uint32_t sleeping = service->sleep_duration_ms;
    if (exiting || sleeping) { restart = false; stop_app_locked(service); }
    bool present = service->app != NULL;
    bool push_owned = service->push_token != 0;
    pthread_mutex_unlock(&service->lock);
    if ((exiting || sleeping) && service->portal_initialized && !portal_stop_requested) {
      px_system_keys_set_provisioning_enabled(false);
      (void)px_portal_stop(); portal_stop_requested = true;
      pthread_mutex_lock(&service->lock); service->portal_pending = false; pthread_mutex_unlock(&service->lock);
    }
    bool portal_owned = refresh_portal(service, present);
    pthread_mutex_lock(&service->lock);
    if (push_owned && !service->push_paused && ((!present && !portal_owned) || exiting)) {
      /* reap_finished 已 waitpid/join，门户也已释放 Wi-Fi；Flash 写入不与旧 VM/
       * 门户凭据保存竞争。只提交纯 C 确认，不在监督线程访问 LittleFS。
       */
      (void)px_devd_complete_push_pause(service->devd, service->push_token,
                                        exiting ? -ECANCELED : 0);
      service->push_paused = true;
    }
    pthread_mutex_unlock(&service->lock);
    if (sleeping && !exiting) {
      bool timed_out = monotonic_ms() >= service->sleep_deadline_ms;
      if (timed_out || (!present && !portal_owned)) {
        int prepared = timed_out ? -ETIMEDOUT : service->last_result ? -ECANCELED :
          service->prepare_sleep(service->sleep_opaque, sleeping);
        pthread_mutex_lock(&service->lock);
        /* 外部 shutdown 若已撤销请求，不能让迟到的准备结果重新授权睡眠。 */
        if (service->sleep_duration_ms == sleeping && !service->shutting_down) {
          if (prepared) {
            service->sleep_duration_ms = 0; service->sleep_error = prepared;
          } else {
            service->sleep_ready = true; service->shutting_down = exiting = true;
          }
        }
        pthread_mutex_unlock(&service->lock);
        if (prepared) {
          char message[96]; snprintf(message, sizeof(message), "timed sleep rejected (%d); application remains stopped", prepared);
          px_devd_log(service->devd, "warn", "sleep", message);
          px_system_keys_set_provisioning_enabled(service->portal_initialized);
          portal_stop_requested = false;
        }
      }
    }
    if (exiting && !present && !portal_owned) {
      if (service->portal_initialized) {
        int stopped = px_portal_shutdown();
        if (stopped) {
          pthread_mutex_lock(&service->lock); service->portal_status.error = stopped;
          bool rejected_sleep = service->sleep_ready;
          if (rejected_sleep) {
            service->sleep_duration_ms = 0; service->sleep_ready = false;
            service->sleep_error = stopped; service->shutting_down = false;
          }
          pthread_mutex_unlock(&service->lock);
          if (rejected_sleep) {
            px_devd_log(service->devd, "warn", "sleep", "timed sleep rejected: portal shutdown incomplete");
            px_system_keys_set_provisioning_enabled(true);
            portal_stop_requested = false;
          }
        } else {
          pthread_mutex_lock(&service->lock); service->portal_initialized = false; pthread_mutex_unlock(&service->lock);
          break;
        }
      } else break;
    }
    if (restart && !present && !portal_owned && !push_owned) {
      restart = false; int launched = launch_app(service, settings);
      if (launched) {
        if (launched == -ENOENT || launched == -ECANCELED) px_devd_state(service->devd, "stopped", NULL);
        else { char message[64]; snprintf(message, sizeof(message), "application start failed (%d)", launched);
          px_devd_state(service->devd, "crashed", message); }
      }
    }
    uint64_t now = monotonic_ms();
    unsigned wait_ms = service->network_status && service->next_network_ms <= now ? 0 :
      service->network_status && service->next_network_ms - now < 1000 ?
      (unsigned)(service->next_network_ms - now) : 1000;
    if (wait_ms > SERVICE_CONTROL_POLL_MS) wait_ms = SERVICE_CONTROL_POLL_MS;
    int waited = wait_for_wake(service, wait_ms);
    if (waited) { result = waited; px_service_request_shutdown(service); }
  }
  pthread_mutex_lock(&service->lock); service->running = false;
  pthread_mutex_unlock(&service->lock); return result;
}
void px_service_request_shutdown(struct px_service *service)
{
  if (!service) return;
  pthread_mutex_lock(&service->lock); service->shutting_down = true;
  service->sleep_duration_ms = 0; service->sleep_ready = false;
  stop_app_locked(service);
  pthread_mutex_unlock(&service->lock); notify_service(service);
}
int px_service_destroy(struct px_service *service)
{
  if (!service) return 0;
  pthread_mutex_lock(&service->lock);
  bool busy = service->running || service->app;
  pthread_mutex_unlock(&service->lock);
  if (busy) return -EBUSY;
  /* 先停devd生产者并join，才关闭它仍可能通知的pipe并销毁service内存。 */
  px_devd_stop(service->devd);
  pthread_mutex_lock(&registry_lock); if (registered_service == service) registered_service = NULL;
  pthread_mutex_unlock(&registry_lock);
  destroy_wake(service); pthread_mutex_destroy(&service->lock); free(service); return 0;
}
unsigned px_service_port(struct px_service *service) { return service ? px_devd_port(service->devd) : 0; }
int px_service_take_sleep(struct px_service *service, uint32_t *duration_ms)
{
  if (!service || !duration_ms) return -EINVAL;
  *duration_ms = 0;
  pthread_mutex_lock(&service->lock);
  int result = service->running ? -EBUSY : service->sleep_ready && service->sleep_duration_ms ? 1 : 0;
  if (result == 1) {
    *duration_ms = service->sleep_duration_ms;
    service->sleep_ready = false;
    service->sleep_duration_ms = 0;
  }
  pthread_mutex_unlock(&service->lock);
  return result;
}
int px_service_get_status(struct px_service *service, struct px_service_status *out)
{
  if (!service || !out) return -EINVAL;
  pthread_mutex_lock(&service->lock);
  *out = (struct px_service_status){.supervising = service->running, .shutting_down = service->shutting_down,
    .app_present = service->app != NULL, .vm_active = service->app && service->app->active,
    .app_stopping = service->app && px_service_vm_should_stop(service->app),
    .generation = service->generation, .last_app_result = service->last_result,
    .portal_enabled = service->portal_initialized, .portal_pending = service->portal_pending,
    .portal_owned = service->portal_status.wifi_owned, .portal_phase = service->portal_status.phase,
    .portal_error = service->portal_status.error, .sleep_duration_ms = service->sleep_duration_ms,
    .sleep_ready = service->sleep_ready, .sleep_error = service->sleep_error};
  pthread_mutex_unlock(&service->lock); return 0;
}
