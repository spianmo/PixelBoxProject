#include "pixelbox_system_keys.h"
#include "pixelbox_watchdog.h"
#include "system_keys_test_platform.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static atomic_int creates, registers, begins, ends, hardware_reads, power_polls;
static atomic_bool block_power, inside_power, fail_begin, busy;
static atomic_int power_event, gpio_boot, gpio_user;
static int launch_error, register_error;
static int (*worker_entry)(int, char **);

static void delay_ms(unsigned ms)
{
  struct timespec delay = {ms / 1000, (long)(ms % 1000) * 1000000};
  nanosleep(&delay, NULL);
}

static void *worker(void *unused)
{ (void)unused; worker_entry(0, NULL); return NULL; }

int px_keys_test_kthread_create(const char *name, int priority, int stack,
                                 int (*entry)(int, char **), char *const argv[])
{
  (void)argv;
  assert(!strcmp(name, "px-keys") && priority == 110 && stack >= 4096);
  ++creates;
  if (launch_error) { errno = EDOM; return -launch_error; }
  worker_entry = entry;
  pthread_t thread;
  assert(pthread_create(&thread, NULL, worker, NULL) == 0);
  pthread_detach(thread);
  return 123;
}

int px_watchdog_register(uint32_t *handle)
{ ++registers; *handle = register_error ? 0 : 42; return register_error; }
int px_watchdog_begin(uint32_t handle)
{
  assert(handle == 42);
  if (fail_begin) return -EIO;
  assert(!busy);
  busy = true;
  ++begins;
  return 0;
}
int px_watchdog_end(uint32_t handle)
{
  assert(handle == 42 && busy && hardware_reads >= 2);
  busy = false;
  ++ends;
  return 0;
}
int px_watchdog_unregister(uint32_t handle)
{ assert(handle == 42); return busy ? -EBUSY : 0; }
int pixelbox_board_button_read(unsigned index, bool *pressed)
{
  assert(index < 2 && busy);
  ++hardware_reads;
  *pressed = index ? gpio_user : gpio_boot;
  return 0;
}
int px_keys_test_power_poll(struct px_button_event *event)
{
  assert(busy);
  inside_power = true;
  ++power_polls;
  while (block_power) delay_ms(1);
  inside_power = false;
  int value = atomic_exchange(&power_event, 0);
  if (value < 0) return value;
  if (!value) return 0;
  event->id = PX_BUTTON_POWER;
  event->type = (enum px_button_type)value;
  return 1;
}

static int feed(struct px_system_key_state *state, int id, int type, uint64_t now,
                  struct px_system_key_request *request)
{
  struct px_button_event event = {(enum px_button_id)id, (enum px_button_type)type};
  return px_system_keys_feed(state, &event, now, request);
}

static void core_test(void)
{
  struct px_system_key_state state;
  struct px_system_key_request request;
  px_system_keys_state_init(&state);
  assert(feed(&state, PX_BUTTON_BOOT, PX_BUTTON_CLICK, 0, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_OPEN_SETTINGS && request.result == 0);
  state.in_settings = true;
  assert(feed(&state, PX_BUTTON_BOOT, PX_BUTTON_CLICK, 1, &request) == 1);
  assert(feed(&state, PX_BUTTON_POWER, PX_BUTTON_CLICK, 2, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_RETURN_APP);
  state.in_settings = false;
  assert(feed(&state, PX_BUTTON_POWER, PX_BUTTON_CLICK, 3, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_CLICK, 4, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_TOGGLE_SCREEN && request.result == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_LONG_PRESS, 5, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_DEEP_SLEEP && request.result == -ENOTSUP);
  assert(feed(&state, PX_BUTTON_POWER, PX_BUTTON_LONG_PRESS, 6, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_UNINSTALL_APP && request.result == -ENOTSUP);
  assert(feed(&state, PX_BUTTON_BOOT, PX_BUTTON_DOWN, 10, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_DOWN, 20, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_LONG_PRESS, 1220, &request) == 0);
  assert(px_system_keys_tick(&state, 2019, &request) == 0);
  assert(px_system_keys_tick(&state, 2020, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_OPEN_PROVISIONING && request.result == -ENOTSUP);
  assert(px_system_keys_tick(&state, 2030, &request) == 0);
  assert(feed(&state, PX_BUTTON_BOOT, PX_BUTTON_UP, 2040, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_UP, 2040, &request) == 0);
  assert(feed(&state, PX_BUTTON_BOOT, PX_BUTTON_CLICK, 2240, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_CLICK, 2240, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_DOWN, 2300, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_UP, 2320, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_CLICK, 2520, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_TOGGLE_SCREEN);
  assert(feed(&state, PX_BUTTON_BOOT, PX_BUTTON_DOWN, 2600, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_DOWN, 2600, &request) == 0);
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_UP, 2650, &request) == 0);
  assert(px_system_keys_tick(&state, 4700, &request) == 0);
  assert(px_system_keys_tick(&state, 4699, &request) == -ERANGE);
  assert(feed(&state, 3, PX_BUTTON_CLICK, 4800, &request) == -EINVAL);
  assert(feed(&state, PX_BUTTON_BOOT, 6, 4800, &request) == -EINVAL);
  /* 只有生产者能力已启用，组合键才排队成功；默认仍明确不支持。 */
  state.provisioning_enabled = true;
  assert(feed(&state, PX_BUTTON_USER, PX_BUTTON_DOWN, 5000, &request) == 0);
  assert(px_system_keys_tick(&state, 7000, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_OPEN_PROVISIONING && request.result == 0);
  state.in_provisioning = true;
  assert(feed(&state, PX_BUTTON_POWER, PX_BUTTON_CLICK, 7001, &request) == 1);
  assert(request.action == PX_SYSTEM_KEY_RETURN_APP && request.result == 0);
  state.in_provisioning = false;
  assert(feed(&state, PX_BUTTON_POWER, PX_BUTTON_CLICK, 7002, &request) == 0);
}

static void inject(int id, int type, uint64_t now)
{
  struct px_button_event event = {(enum px_button_id)id, (enum px_button_type)type};
  px_system_keys_test_inject(&event, now);
}

static void queues_test(void)
{
  struct px_system_key_request request;
  struct px_button_event events[64];
  /* 无 JS 订阅时 BOOT 仍然生成系统动作。 */
  inject(PX_BUTTON_BOOT, PX_BUTTON_CLICK, 0);
  assert(px_system_keys_next_action(&request) == 1 && request.action == PX_SYSTEM_KEY_OPEN_SETTINGS);
  assert(px_system_keys_read_buttons(events, 64) == -ENODEV);
  px_system_keys_vm_reset();
  /* 设置页没有 onButton 时不会堆积原始事件或产生虚假溢出。 */
  for (unsigned i = 0; i < 70; ++i) inject(PX_BUTTON_BOOT, PX_BUTTON_DOUBLE_CLICK, 0);
  struct px_system_keys_status idle_status;
  assert(px_system_keys_get_status(&idle_status) == 0 && idle_status.overflows == 0);
  assert(px_system_keys_read_buttons(events, 64) == -ENODEV);
  assert(px_system_keys_listen_buttons(true) == 0);
  inject(PX_BUTTON_USER, PX_BUTTON_CLICK, 1);
  assert(px_system_keys_read_buttons(events, 64) == 1 && events[0].id == PX_BUTTON_USER);
  assert(px_system_keys_next_display(&request) == 1 && request.action == PX_SYSTEM_KEY_TOGGLE_SCREEN);
  px_system_keys_set_settings(true);
  inject(PX_BUTTON_POWER, PX_BUTTON_CLICK, 2);
  assert(px_system_keys_next_action(&request) == 1 && request.action == PX_SYSTEM_KEY_RETURN_APP);
  inject(PX_BUTTON_USER, PX_BUTTON_CLICK, 3);
  inject(PX_BUTTON_BOOT, PX_BUTTON_DOWN, 4);
  px_system_keys_vm_detach();
  px_system_keys_vm_reset();
  assert(px_system_keys_read_buttons(events, 64) == -ENODEV);
  assert(px_system_keys_next_display(&request) == -ENODEV);
  /* 换 VM 不重置另一键仍按住的物理状态。 */
  inject(PX_BUTTON_USER, PX_BUTTON_LONG_PRESS, 5);
  assert(px_system_keys_next_action(&request) == -ENODEV);
  inject(PX_BUTTON_BOOT, PX_BUTTON_UP, 6);
  inject(PX_BUTTON_USER, PX_BUTTON_LONG_PRESS, 7);
  assert(px_system_keys_next_action(&request) == 1 && request.result == -ENOTSUP);
  px_system_keys_vm_reset();
  assert(px_system_keys_listen_buttons(true) == 0);
  for (unsigned i = 0; i < 65; ++i) inject(PX_BUTTON_BOOT, PX_BUTTON_DOUBLE_CLICK, 10 + i);
  assert(px_system_keys_read_buttons(events, 64) == -EOVERFLOW);
  assert(px_system_keys_read_buttons(events, 64) == 64);
  assert(px_system_keys_read_buttons(events, 64) == -ENODEV);
  inject(PX_BUTTON_BOOT, PX_BUTTON_DOUBLE_CLICK, 80);
  assert(px_system_keys_listen_buttons(false) == 0);
  assert(px_system_keys_listen_buttons(true) == 0);
  assert(px_system_keys_read_buttons(events, 64) == -ENODEV);
  px_system_keys_vm_detach();
  assert(px_system_keys_listen_buttons(true) == -ENODEV);
  for (unsigned i = 0; i < 17; ++i) inject(PX_BUTTON_BOOT, PX_BUTTON_CLICK, 100 + i);
  assert(px_system_keys_next_action(&request) == -EOVERFLOW);
  for (unsigned i = 0; i < 16; ++i) assert(px_system_keys_next_action(&request) == 1);
  assert(px_system_keys_next_action(&request) == -ENODEV);
  px_system_keys_vm_reset();
  for (unsigned i = 0; i < 17; ++i) inject(PX_BUTTON_USER, PX_BUTTON_CLICK, 200 + i);
  assert(px_system_keys_next_display(&request) == -EOVERFLOW);
  for (unsigned i = 0; i < 16; ++i) assert(px_system_keys_next_display(&request) == 1);
  struct px_system_keys_status status;
  assert(px_system_keys_get_status(&status) == 0 && status.overflows == 3);
  assert(status.last_request.result == -EOVERFLOW);
  assert(creates == 0 && power_polls == 0);
  px_system_keys_set_settings(false);
  px_system_keys_set_provisioning_active(true); /* 能力未开时不能伪造门户模式。 */
  inject(PX_BUTTON_POWER, PX_BUTTON_CLICK, 300);
  assert(px_system_keys_next_action(&request) == -ENODEV);
  px_system_keys_set_provisioning_enabled(true);
  px_system_keys_set_provisioning_active(true);
  inject(PX_BUTTON_POWER, PX_BUTTON_CLICK, 301);
  assert(px_system_keys_next_action(&request) == 1 && request.action == PX_SYSTEM_KEY_RETURN_APP);
  px_system_keys_set_provisioning_enabled(false);
  inject(PX_BUTTON_POWER, PX_BUTTON_CLICK, 302);
  assert(px_system_keys_next_action(&request) == -ENODEV);
}

static void stop_worker(void)
{
  fail_begin = true;
  for (unsigned i = 0; i < 100 && px_system_keys_buttons_available(); ++i) delay_ms(2);
  assert(!px_system_keys_buttons_available());
}

static void worker_test(void)
{
  px_system_keys_vm_reset();
  px_system_keys_set_settings(true);
  assert(px_system_keys_start() == 0);
  /* start 初始化状态后由 service 设置真实模式。 */
  px_system_keys_set_settings(true);
  assert(px_system_keys_start() == 0 && creates == 1 && registers == 1);
  assert(px_system_keys_buttons_available());
  power_event = PX_BUTTON_CLICK;
  delay_ms(230);
  struct px_system_key_request request;
  assert(px_system_keys_next_action(&request) == 1 && request.action == PX_SYSTEM_KEY_RETURN_APP);
  /* 系统服务仍采样，旧 VM 结束不能杀死它。 */
  px_system_keys_vm_detach();
  gpio_boot = true;
  delay_ms(30);
  gpio_boot = false;
  delay_ms(230);
  assert(px_system_keys_next_action(&request) == 1 && request.action == PX_SYSTEM_KEY_OPEN_SETTINGS);
  assert(hardware_reads > 30 && power_polls >= 2 && power_polls <= 4 && ends > 10);
  stop_worker();
}

static void blocked_io_test(void)
{
  block_power = true;
  assert(px_system_keys_start() == 0);
  for (unsigned i = 0; i < 100 && !inside_power; ++i) delay_ms(1);
  assert(inside_power && busy);
  int before = ends;
  delay_ms(40);
  assert(ends == before && busy);
  block_power = false;
  delay_ms(20);
  assert(ends > before);
  stop_worker();
}

static void provisioning_test(void)
{
  assert(px_system_keys_start() == 0);
  struct px_system_key_request request;
  for (unsigned enabled = 0; enabled < 2; ++enabled) {
    px_system_keys_set_provisioning_enabled(enabled != 0);
    gpio_boot = gpio_user = true;
    /* 使用真实采样 worker 的单调时间与 2 秒组合键，不直接伪造 action。 */
    int taken = 0;
    for (unsigned i = 0; i < 250 && !taken; ++i) {
      delay_ms(10); taken = px_system_keys_next_action(&request); assert(taken >= 0);
    }
    assert(taken == 1 && request.action == PX_SYSTEM_KEY_OPEN_PROVISIONING);
    assert(request.result == (enabled ? 0 : -ENOTSUP));
    gpio_boot = gpio_user = false; delay_ms(230);
    assert(px_system_keys_next_action(&request) == 0); /* 释放时不漏出单键 click。 */
  }
  px_system_keys_set_provisioning_active(true); power_event = PX_BUTTON_CLICK;
  delay_ms(230);
  assert(px_system_keys_next_action(&request) == 1 && request.action == PX_SYSTEM_KEY_RETURN_APP);
  px_system_keys_set_provisioning_enabled(false); power_event = PX_BUTTON_CLICK;
  delay_ms(230); assert(px_system_keys_next_action(&request) == 0);
  stop_worker();
}

int main(int argc, char **argv)
{
  assert(argc == 2);
  if (!strcmp(argv[1], "core")) core_test();
  else if (!strcmp(argv[1], "queues")) queues_test();
  else if (!strcmp(argv[1], "worker")) worker_test();
  else if (!strcmp(argv[1], "blocked_io")) blocked_io_test();
  else if (!strcmp(argv[1], "provisioning")) provisioning_test();
  else if (!strcmp(argv[1], "launch_fail")) {
    launch_error = EAGAIN;
    assert(px_system_keys_start() == -EAGAIN && !px_system_keys_buttons_available());
    assert(px_system_keys_start() == -EAGAIN && creates == 1);
  } else if (!strcmp(argv[1], "watchdog_fail")) {
    register_error = -ENOSPC;
    assert(px_system_keys_start() == -ENOSPC && !px_system_keys_buttons_available());
    assert(hardware_reads == 0 && power_polls == 0);
  } else assert(0);
  printf("system keys %s passed\n", argv[1]);
  return 0;
}
