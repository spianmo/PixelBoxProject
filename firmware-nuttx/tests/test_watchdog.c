#define _POSIX_C_SOURCE 200809L
#include "pixelbox_watchdog.h"
#include "watchdog_test_platform.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t g_now = 1000;
static unsigned g_opens, g_closes, g_launches, g_starts, g_stops, g_feeds, g_status_reads;
static unsigned g_status_flags, g_timeout;
static int g_fail_command;
static bool g_open_fail, g_clock_fail, g_post_status_fail, g_wrong_mode, g_launch_fail, g_delay_start;
static unsigned g_sleeps, g_setup_after_sleeps;

int px_wdt_test_open(const char *path, int flags)
{
  ++g_opens;
  assert(strcmp(path, "/dev/watchdog0") == 0 && flags == O_RDWR);
  if (g_open_fail) { errno = ENOENT; return -1; }
  return 73;
}
int px_wdt_test_close(int fd) { assert(fd == 73); ++g_closes; return 0; }
int px_wdt_test_ioctl(int fd, int command, unsigned long argument)
{
  assert(fd == 73);
  if (command == g_fail_command) { errno = EIO; return -1; }
  if (command == WDIOC_GETSTATUS) {
    if (++g_status_reads > 1 && g_post_status_fail) { errno = EIO; return -1; }
    struct watchdog_status_s *status = (void *)(uintptr_t)argument;
    status->flags = g_status_flags;
    status->timeout = g_timeout;
  } else if (command == WDIOC_SETTIMEOUT) {
    assert(argument == PX_WATCHDOG_HARDWARE_MS);
    g_timeout = (unsigned)argument;
  } else if (command == WDIOC_START) {
    ++g_starts;
    g_status_flags = WDFLAGS_ACTIVE | (g_wrong_mode ? WDFLAGS_CAPTURE : WDFLAGS_RESET);
  } else if (command == WDIOC_STOP) {
    ++g_stops;
    g_status_flags = 0;
  } else if (command == WDIOC_KEEPALIVE) {
    assert(g_status_flags & WDFLAGS_ACTIVE);
    ++g_feeds;
  } else assert(!"unexpected ioctl");
  return 0;
}
int px_wdt_test_clock_gettime(clockid_t clock, struct timespec *result)
{
  assert(clock == CLOCK_MONOTONIC);
  if (g_clock_fail) { errno = EIO; return -1; }
  result->tv_sec = (time_t)(g_now / 1000);
  result->tv_nsec = (long)(g_now % 1000) * 1000000;
  return 0;
}
int px_wdt_test_nanosleep(const struct timespec *delay, struct timespec *remaining)
{
  (void)remaining;
  ++g_sleeps;
  g_now += (uint64_t)delay->tv_sec * 1000 + (unsigned long)delay->tv_nsec / 1000000;
  if (g_setup_after_sleeps && g_sleeps == g_setup_after_sleeps) {
    struct px_watchdog_status pending;
    assert(px_watchdog_get_status(&pending) == 0);
    /* 硬件尚未确认时不能提前注册，更不能开始喂狗；回调也验证等待没有持锁。 */
    assert(!pending.running && !pending.registered && !g_feeds && !g_opens);
    (void)px_watchdog_test_setup();
  }
  return 0;
}
int px_wdt_test_kthread_create(const char *name, int priority, int stack,
                               int (*entry)(int, char **), char *const argv[])
{
  ++g_launches;
  assert(strcmp(name, "px-watchdog") == 0 && priority > 0 && stack >= 2048 && entry && !argv);
  if (g_launch_fail) return -ENOMEM;
  if (!g_delay_start) (void)px_watchdog_test_setup();
  return 42;
}

static struct px_watchdog_status status(void)
{
  struct px_watchdog_status value;
  assert(px_watchdog_get_status(&value) == 0);
  return value;
}

static uint32_t client(void)
{
  uint32_t handle = 0;
  assert(px_watchdog_register(&handle) == 0 && handle);
  return handle;
}

static void check_idle(void)
{
  for (int i = 0; i < 100; ++i) {
    g_now += 1000;
    assert(px_watchdog_test_tick() == 0);
  }
  struct px_watchdog_status s = status();
  assert(g_feeds == 100 && !s.fault_latched && s.running && !s.busy);
  assert(g_starts == 1 && g_stops == 0 && g_closes == 0);
  assert(px_watchdog_start() == 0 && g_launches == 1 && g_opens == 1);
}

static void check_progress(void)
{
  uint32_t handle = client();
  assert(px_watchdog_begin(handle) == 0);
  for (int i = 0; i < 100; ++i) {
    g_now += 4000;
    assert(px_watchdog_beat(handle) == 0);
    assert(px_watchdog_test_tick() == 0);
  }
  assert(px_watchdog_end(handle) == 0 && px_watchdog_unregister(handle) == 0);
  g_now += 100000;
  assert(px_watchdog_test_tick() == 0);
  assert(status().registered == 0 && status().busy == 0 && !status().fault_latched);
}

static void check_stall(bool late, bool multiple)
{
  uint32_t blocked = client(), healthy = multiple ? client() : 0;
  assert(px_watchdog_begin(blocked) == 0);
  if (multiple) assert(px_watchdog_begin(healthy) == 0);
  assert(px_watchdog_test_tick() == 0);
  g_now += 4000;
  if (multiple) assert(px_watchdog_beat(healthy) == 0);
  /* 监督门限由头文件统一定义，测试不再把实现细节锁死为 5 秒。 */
  g_now += PX_WATCHDOG_STALL_MS;
  if (late) assert(px_watchdog_end(blocked) == -ETIMEDOUT);
  assert(px_watchdog_test_tick() == -ETIMEDOUT);
  struct px_watchdog_status s = status();
  assert(s.fault_latched && s.failed_handle == blocked && s.error == -ETIMEDOUT);
  assert(g_feeds == 1 && g_stops == 0 && g_closes == 0);
  assert(px_watchdog_beat(blocked) == -ETIMEDOUT);
  assert(px_watchdog_end(blocked) == -ETIMEDOUT);
  assert(px_watchdog_unregister(blocked) == -ETIMEDOUT);
  assert(px_watchdog_start() == -ETIMEDOUT);
  if (multiple) assert(px_watchdog_beat(healthy) == -ETIMEDOUT);
  assert(px_watchdog_test_tick() == -ETIMEDOUT && g_feeds == 1);
}

static void check_handles(void)
{
  uint32_t handles[PX_WATCHDOG_MAX_CLIENTS];
  for (unsigned i = 0; i < PX_WATCHDOG_MAX_CLIENTS; ++i) handles[i] = client();
  uint32_t extra = 99;
  assert(px_watchdog_register(&extra) == -ENOSPC && !extra);
  assert(px_watchdog_unregister(handles[0]) == 0);
  uint32_t replacement = client();
  assert(replacement != handles[0]);
  assert(px_watchdog_begin(handles[0]) == -ENOENT);
  assert(px_watchdog_begin(0) == -ENOENT);
  assert(px_watchdog_beat(replacement) == -EINVAL);
  assert(px_watchdog_begin(replacement) == 0);
  assert(px_watchdog_begin(replacement) == -EALREADY);
  assert(px_watchdog_unregister(replacement) == -EBUSY);
  assert(px_watchdog_end(replacement) == 0);
  assert(px_watchdog_end(replacement) == -EINVAL);
  assert(px_watchdog_unregister(replacement) == 0);
  for (unsigned i = 1; i < PX_WATCHDOG_MAX_CLIENTS; ++i)
    assert(px_watchdog_unregister(handles[i]) == 0);
  assert(px_watchdog_get_status(NULL) == -EINVAL);
}

static void check_startup_race(const char *test)
{
  uint32_t handle = 99;
  if (!strcmp(test, "register_before_start")) {
    assert(px_watchdog_register(&handle) == -EAGAIN && !handle);
    assert(!g_sleeps && !g_launches && !g_opens);
    return;
  }
  g_delay_start = true;
  assert(px_watchdog_start() == 0);
  assert(g_launches == 1 && !g_opens && !g_sleeps && !status().running);
  assert(px_watchdog_start() == -EINPROGRESS && g_launches == 1);
  uint64_t began = g_now;
  if (!strcmp(test, "register_delayed_success") ||
      !strcmp(test, "register_delayed_failure")) {
    g_setup_after_sleeps = 3;
    g_open_fail = !strcmp(test, "register_delayed_failure");
    int result = px_watchdog_register(&handle);
    assert(g_sleeps == 3 && g_opens == 1 && g_now - began == 30);
    if (g_open_fail) {
      assert(result == -ENOENT && !handle && !status().registered && !g_feeds);
      assert(px_watchdog_register(&handle) == -ENOENT && !handle && g_sleeps == 3);
    } else {
      assert(result == 0 && handle && status().running && status().registered == 1);
      assert(px_watchdog_begin(handle) == 0 && px_watchdog_test_tick() == 0);
      g_now += PX_WATCHDOG_STALL_MS;
      assert(px_watchdog_test_tick() == -ETIMEDOUT);
      assert(px_watchdog_beat(handle) == -ETIMEDOUT && g_feeds == 1 && !g_stops);
    }
  } else {
    assert(!strcmp(test, "register_start_timeout"));
    assert(px_watchdog_register(&handle) == -ETIMEDOUT && !handle);
    assert(g_now - began == 2000 && !status().registered && !g_opens && !g_feeds);
    /* 超时只拒绝当前客户端，不能伪造故障或重复创建硬件监督器。 */
    assert(px_watchdog_test_setup() == 0);
    assert(px_watchdog_start() == 0 && g_launches == 1);
    assert(px_watchdog_register(&handle) == 0 && handle);
  }
}

int main(int argc, char **argv)
{
  assert(argc == 2);
  const char *test = argv[1];
  if (!strncmp(test, "register_", 9)) {
    check_startup_race(test);
    printf("PASS %s\n", test);
    return 0;
  }
  int expect = 0;
  if (!strcmp(test, "open_fail")) { g_open_fail = true; expect = -ENOENT; }
  else if (!strcmp(test, "set_fail")) { g_fail_command = WDIOC_SETTIMEOUT; expect = -EIO; }
  else if (!strcmp(test, "start_fail")) { g_fail_command = WDIOC_START; expect = -EIO; }
  else if (!strcmp(test, "verify_fail")) { g_post_status_fail = true; expect = -EIO; }
  else if (!strcmp(test, "capture_mode")) { g_wrong_mode = true; expect = -EIO; }
  else if (!strcmp(test, "owned")) { g_status_flags = WDFLAGS_ACTIVE; expect = -EBUSY; }
  else if (!strcmp(test, "launch_fail")) { g_launch_fail = true; expect = -ENOMEM; }
  else if (!strcmp(test, "slow_start")) g_delay_start = true;
  assert(px_watchdog_start() == expect);
  if (expect) {
    assert(!status().running && g_feeds == 0);
    assert(g_stops == (unsigned)(g_post_status_fail || g_wrong_mode));
    if (!g_open_fail && !g_launch_fail && !g_delay_start) assert(g_closes == 1);
    assert(px_watchdog_start() == expect && g_launches == 1);
  } else if (!strcmp(test, "slow_start")) {
    assert(!status().running && !g_sleeps && !g_opens);
    assert(px_watchdog_start() == -EINPROGRESS && g_launches == 1);
    assert(px_watchdog_test_setup() == 0);
    assert(px_watchdog_start() == 0 && g_launches == 1);
  } else if (!strcmp(test, "idle")) check_idle();
  else if (!strcmp(test, "progress")) check_progress();
  else if (!strcmp(test, "stall")) check_stall(false, false);
  else if (!strcmp(test, "late_end")) check_stall(true, false);
  else if (!strcmp(test, "multiple")) check_stall(false, true);
  else if (!strcmp(test, "handles")) check_handles();
  else if (!strcmp(test, "feed_fail")) {
    g_fail_command = WDIOC_KEEPALIVE;
    assert(px_watchdog_test_tick() == -EIO);
    g_fail_command = 0;
    assert(px_watchdog_test_tick() == -EIO && g_feeds == 0);
    assert(status().fault_latched && status().error == -EIO);
  } else if (!strcmp(test, "clock_fail")) {
    g_clock_fail = true;
    assert(px_watchdog_test_tick() == -EIO && g_feeds == 0);
    assert(status().fault_latched);
  } else if (!strcmp(test, "clock_back")) {
    uint32_t handle = client();
    assert(px_watchdog_begin(handle) == 0);
    g_now = 0;
    assert(px_watchdog_test_tick() == -EIO && g_feeds == 0);
    assert(status().failed_handle == handle);
  } else assert(!"unknown test");
  printf("PASS %s\n", test);
  return 0;
}
