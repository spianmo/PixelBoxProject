/* 使用真实 service 线程与 VM 回收，替身仅覆盖 devd 邮箱及门户设备边界。 */
#include "pixelbox_service.h"
#include "pixelbox_sleep.h"
#include "pixelbox_builtin_apps.h"
#include "pixelbox_system_keys.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static struct px_service *service;
static atomic_bool release_vm, vm_exited, portal_owned, portal_stop, request_done;
static atomic_uint prepare_calls, runs;
static atomic_int queued_action;
static int prepare_result, app_result, run_result;
static atomic_int portal_shutdown_error;
static bool simulate_portal;
static uint32_t requested_duration;

struct px_devd { int unused; };
int px_devd_start(const struct px_devd_config *config, struct px_devd **out)
{ (void)config; *out = calloc(1, sizeof(**out)); return *out ? 0 : -ENOMEM; }
void px_devd_stop(struct px_devd *devd) { free(devd); }
unsigned px_devd_port(struct px_devd *devd) { (void)devd; return 12345; }
int px_devd_take_action(struct px_devd *devd, struct px_devd_action *out)
{
  (void)devd; memset(out, 0, sizeof(*out));
  out->type = atomic_exchange(&queued_action, 0); return out->type != 0;
}
void px_devd_action_free(struct px_devd_action *action) { free(action->code); }
int px_devd_complete_push_pause(struct px_devd *devd, uint64_t token, int error)
{ (void)devd; (void)token; (void)error; return 0; }
void px_devd_release_push(struct px_devd *devd, uint64_t token) { (void)devd; (void)token; }
int px_devd_complete_eval(struct px_devd *d, uint64_t t, bool s, const char *v)
{ (void)d; (void)t; (void)s; (void)v; return 0; }
int px_devd_current_app(struct px_devd *d, char *r, size_t n, char *e, size_t c)
{ (void)d; (void)r; (void)n; (void)e; (void)c; return -ENOENT; }
void px_devd_log(struct px_devd *d, const char *l, const char *t, const char *m)
{ (void)d; (void)l; (void)t; (void)m; }
void px_devd_state(struct px_devd *d, const char *s, const char *e)
{ (void)d; (void)s; (void)e; }
void px_devd_network(struct px_devd *d, const char *i, const char *m, size_t h)
{ (void)d; (void)i; (void)m; (void)h; }
void px_system_keys_set_settings(bool b) { (void)b; }
void px_system_keys_set_provisioning_enabled(bool b) { (void)b; }
void px_system_keys_set_provisioning_active(bool b) { (void)b; }
int px_system_keys_next_action(struct px_system_key_request *r) { (void)r; return 0; }
const struct px_builtin_app *px_builtin_app_get(enum px_builtin_app_id id)
{ (void)id; return NULL; }
int px_portal_init(const struct px_portal_config *config) { (void)config; return 0; }
int px_portal_request_start(void) { return -ENOTSUP; }
int px_portal_take_request(enum px_portal_request *r) { (void)r; return 0; }
int px_portal_begin(void) { abort(); }
int px_portal_stop(void) { atomic_store(&portal_stop, true); return 0; }
int px_portal_reap(void) { return 0; }
int px_portal_get_status(struct px_portal_status *s)
{ memset(s, 0, sizeof(*s)); s->wifi_owned = atomic_load(&portal_owned); return 0; }
int px_portal_shutdown(void) { assert(!atomic_load(&portal_owned)); return atomic_load(&portal_shutdown_error); }

static void delay(void) { struct timespec t = {.tv_nsec = 1000000}; nanosleep(&t, NULL); }
static void wait_flag(atomic_bool *flag)
{ for (unsigned i = 0; !atomic_load(flag) && i < 1000; ++i) delay(); assert(atomic_load(flag)); }
static struct px_service_status status(void)
{ struct px_service_status s; assert(!px_service_get_status(service, &s)); return s; }
static int app(const struct px_options *options)
{
  (void)options; struct px_service_vm *vm = px_service_vm_current(); assert(vm);
  assert(!px_service_vm_enter(vm)); unsigned count = atomic_fetch_add(&runs, 1);
  if (!count) {
    assert(px_service_vm_request_sleep(vm, 0) == -EINVAL);
    assert(!px_service_vm_request_sleep(vm, requested_duration));
    assert(px_service_vm_request_sleep(vm, requested_duration) == -EBUSY);
    assert(px_service_vm_should_stop(vm));
    atomic_store(&portal_owned, simulate_portal);
    atomic_store(&request_done, true);
    while (!atomic_load(&release_vm)) delay();
  } else {
    while (!px_service_vm_should_stop(vm)) delay();
  }
  atomic_store(&vm_exited, true);
  return app_result;
}
static int prepare(void *opaque, uint32_t ms)
{
  assert(opaque == &prepare_result && ms == requested_duration);
  assert(atomic_load(&vm_exited) && !atomic_load(&portal_owned));
  assert(!status().app_present); atomic_fetch_add(&prepare_calls, 1);
  return prepare_result;
}
static void *supervise(void *unused) { (void)unused; run_result = px_service_run(service); return NULL; }
static pthread_t begin(bool portal, int outcome, int app_outcome)
{
  prepare_result = outcome; app_result = app_outcome; requested_duration = 4321000;
  atomic_store(&release_vm, false); atomic_store(&vm_exited, false);
  simulate_portal = portal;
  atomic_store(&portal_shutdown_error, 0);
  atomic_store(&portal_owned, false); atomic_store(&portal_stop, false);
  atomic_store(&request_done, false); atomic_store(&prepare_calls, 0);
  atomic_store(&runs, 0); atomic_store(&queued_action, 0);
  struct px_service_config config = {.app = {.app_root = "/fixture", .data_root = "/fixture"},
    .run_app = app, .start_on_boot = true, .enable_portal = portal,
    .prepare_sleep = prepare, .sleep_opaque = &prepare_result};
  assert(!px_service_create(&config, &service)); pthread_t thread;
  assert(!pthread_create(&thread, NULL, supervise, NULL)); wait_flag(&request_done);
  uint32_t duration; assert(px_service_take_sleep(service, &duration) == -EBUSY);
  assert(!atomic_load(&prepare_calls)); return thread;
}
static void finish(pthread_t thread)
{
  assert(!pthread_join(thread, NULL)); assert(!run_result);
  assert(!px_service_destroy(service)); service = NULL;
}
static void wait_error(int expected)
{
  unsigned i; for (i = 0; i < 1000 && status().sleep_error != expected; ++i) delay();
  assert(i < 1000); assert(status().supervising && !status().sleep_ready && !status().sleep_duration_ms);
}
int main(void)
{
  assert(px_service_vm_request_sleep(NULL, 1) == -ENODEV);
  /* VM 尚未退出，或者门户仍拥有线程时，prepare 都不能提前调用。 */
  pthread_t thread = begin(true, 0, 0);
  wait_flag(&portal_stop); atomic_store(&release_vm, true); wait_flag(&vm_exited);
  for (unsigned i = 0; i < 25; ++i) delay();
  assert(!atomic_load(&prepare_calls)); atomic_store(&portal_owned, false);
  assert(!pthread_join(thread, NULL)); assert(!run_result && atomic_load(&prepare_calls) == 1);
  uint32_t duration; assert(px_service_take_sleep(service, &duration) == 1 && duration == requested_duration);
  assert(px_service_take_sleep(service, &duration) == 0 && duration == 0);
  assert(!px_service_destroy(service));
  /* prepare 失败保留监督器，显式 restart 能重新运行；不会自动重试睡眠。 */
  thread = begin(false, -ENOTSUP, 0); atomic_store(&release_vm, true); wait_error(-ENOTSUP);
  assert(atomic_load(&prepare_calls) == 1 && atomic_load(&runs) == 1);
  atomic_store(&queued_action, PX_DEVD_RESTART);
  for (unsigned i = 0; i < 1000 && atomic_load(&runs) < 2; ++i) delay();
  assert(atomic_load(&runs) == 2); px_service_request_shutdown(service); finish(thread);
  /* VM 清理返回失败时不能调用prepare或发放睡眠票据。 */
  thread = begin(false, 0, 1); atomic_store(&release_vm, true); wait_error(-ECANCELED);
  assert(!atomic_load(&prepare_calls)); px_service_request_shutdown(service); finish(thread);
  /* native/门户阻塞超过总预算：拒绝睡眠，仍不强杀或提前释放资源。 */
  thread = begin(false, 0, 0); wait_error(-ETIMEDOUT);
  assert(status().app_present && !atomic_load(&prepare_calls));
  atomic_store(&release_vm, true); px_service_request_shutdown(service); finish(thread);
  thread = begin(true, 0, 0); atomic_store(&release_vm, true); wait_error(-ETIMEDOUT);
  assert(status().portal_owned && !atomic_load(&prepare_calls));
  atomic_store(&portal_owned, false); px_service_request_shutdown(service); finish(thread);
  /* 门户线程虽已释放，但最终shutdown失败仍要撤销授权并保留服务。 */
  thread = begin(true, 0, 0); atomic_store(&portal_shutdown_error, -EIO);
  atomic_store(&release_vm, true); atomic_store(&portal_owned, false); wait_error(-EIO);
  assert(!status().shutting_down && atomic_load(&prepare_calls) == 1);
  atomic_store(&portal_shutdown_error, 0); px_service_request_shutdown(service); finish(thread);
  /* 显式系统退出撤销定时睡眠，不能在迟到回收后重新获得授权。 */
  thread = begin(false, 0, 0); px_service_request_shutdown(service); atomic_store(&release_vm, true);
  assert(!pthread_join(thread, NULL)); assert(!atomic_load(&prepare_calls));
  assert(px_service_take_sleep(service, &duration) == 0); assert(!px_service_destroy(service));
  puts("sleep service: seven lifecycle scenarios passed"); return 0;
}
