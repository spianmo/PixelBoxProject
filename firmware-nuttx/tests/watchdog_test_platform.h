#ifndef PIXELBOX_WATCHDOG_TEST_PLATFORM_H
#define PIXELBOX_WATCHDOG_TEST_PLATFORM_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>

/* 测试用ioctl编号；实际生产编号来自NuttX的nuttx/timers/watchdog.h。 */
#define WDIOC_START 1
#define WDIOC_STOP 2
#define WDIOC_GETSTATUS 3
#define WDIOC_SETTIMEOUT 4
#define WDIOC_KEEPALIVE 6
#define WDFLAGS_ACTIVE 1
#define WDFLAGS_RESET 2
#define WDFLAGS_CAPTURE 4
struct watchdog_status_s { uint32_t flags, timeout, timeleft; };

int px_wdt_test_open(const char *path, int flags);
int px_wdt_test_close(int fd);
int px_wdt_test_ioctl(int fd, int command, unsigned long argument);
int px_wdt_test_clock_gettime(clockid_t clock, struct timespec *result);
int px_wdt_test_nanosleep(const struct timespec *delay, struct timespec *remaining);
int px_wdt_test_kthread_create(const char *name, int priority, int stack,
                               int (*entry)(int, char **), char *const argv[]);
int px_watchdog_test_setup(void);
int px_watchdog_test_tick(void);

#ifdef PX_WATCHDOG_REDIRECT
#define open px_wdt_test_open
#define close px_wdt_test_close
#define ioctl px_wdt_test_ioctl
#define clock_gettime px_wdt_test_clock_gettime
#define nanosleep px_wdt_test_nanosleep
#define kthread_create px_wdt_test_kthread_create
#endif
#endif
