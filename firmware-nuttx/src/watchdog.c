#include "pixelbox_watchdog.h"

#include <errno.h>
#include <string.h>
#ifdef __NuttX__
#include <nuttx/config.h>
#endif

#if defined(PX_WATCHDOG_TEST) || (defined(__NuttX__) && defined(CONFIG_WATCHDOG) && \
                                defined(CONFIG_ESP32S3_MWDT0))
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>
#ifdef PX_WATCHDOG_TEST
#include "watchdog_test_platform.h"
#else
#include <nuttx/kthread.h>
#include <nuttx/timers/watchdog.h>
#endif

#if defined(CONFIG_WATCHDOG_AUTOMONITOR)
#error "PixelBox health watchdog requires CONFIG_WATCHDOG_AUTOMONITOR=n"
#endif
#if defined(CONFIG_WATCHDOG_PANIC_NOTIFIER)
#error "PixelBox health watchdog must remain armed during panic"
#endif

#define WATCHDOG_PATH "/dev/watchdog0"
#define WATCHDOG_POLL_MS 1000u
/* 唤醒模型同步初始化持续占用 CPU；监督器每秒必须能抢占同级轮转的 VM/worker。 */
#define WATCHDOG_PRIORITY 120
#define WATCHDOG_STACK_BYTES 3072
#define WATCHDOG_START_POLL_MS 10u
#define WATCHDOG_START_POLLS 200u

struct health_client {
  uint32_t handle;
  bool busy;
  uint64_t progress_ms;
};

enum startup_state { NOT_STARTED, STARTING, RUNNING, START_FAILED };
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static struct health_client g_clients[PX_WATCHDOG_MAX_CLIENTS];
static struct px_watchdog_status g_status;
static enum startup_state g_startup;
static uint32_t g_next_handle;

static int now_ms(uint64_t *value)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return -errno;
  if (now.tv_nsec < 0 || now.tv_nsec >= 1000000000L) return -EIO;
  *value = (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
  return 0;
}

static int latch_fault(int error, uint32_t handle)
{
  if (!g_status.fault_latched) {
    g_status.fault_latched = true;
    g_status.error = error;
    g_status.failed_handle = handle;
  }
  return g_status.error;
}

/* 调用方持有g_lock。所有生命周期操作先检查超时，防止迟到的beat/end
 * 在监督线程下一次唤醒前把已卡死的状态洗掉；不同VM之间也不相互掩盖。 */
static int check_health_locked(uint64_t *now)
{
  if (g_status.fault_latched) return g_status.error;
  if (g_startup != RUNNING) return g_startup == START_FAILED ? g_status.error : -EAGAIN;
  int result = now_ms(now);
  if (result) return latch_fault(result, 0);
  for (unsigned i = 0; i < PX_WATCHDOG_MAX_CLIENTS; ++i) {
    struct health_client *client = &g_clients[i];
    if (!client->handle || !client->busy) continue;
    if (*now < client->progress_ms) return latch_fault(-EIO, client->handle);
    if (*now - client->progress_ms >= PX_WATCHDOG_STALL_MS)
      return latch_fault(-ETIMEDOUT, client->handle);
  }
  return 0;
}

static struct health_client *find_client(uint32_t handle)
{
  if (!handle) return NULL;
  for (unsigned i = 0; i < PX_WATCHDOG_MAX_CLIENTS; ++i)
    if (g_clients[i].handle == handle) return &g_clients[i];
  return NULL;
}

static int arm_hardware(int *result_fd)
{
  *result_fd = -1;
  int fd = open(WATCHDOG_PATH, O_RDWR);
  if (fd < 0) return -errno;
  struct watchdog_status_s status;
  bool started = false;
  int result;
  if (ioctl(fd, WDIOC_GETSTATUS, (unsigned long)(uintptr_t)&status) < 0) {
    result = -errno;
    goto fail;
  }
  /* 不接管已由其他服务启动的看门狗，也不停止它。 */
  if (status.flags & WDFLAGS_ACTIVE) { result = -EBUSY; goto fail; }
  if (ioctl(fd, WDIOC_SETTIMEOUT, (unsigned long)PX_WATCHDOG_HARDWARE_MS) < 0) {
    result = -errno;
    goto fail;
  }
  if (ioctl(fd, WDIOC_START, 0ul) < 0) { result = -errno; goto fail; }
  started = true;
  if (ioctl(fd, WDIOC_GETSTATUS, (unsigned long)(uintptr_t)&status) < 0) {
    result = -errno;
    goto fail;
  }
  if ((status.flags & (WDFLAGS_ACTIVE | WDFLAGS_RESET | WDFLAGS_CAPTURE)) !=
      (WDFLAGS_ACTIVE | WDFLAGS_RESET) || status.timeout != PX_WATCHDOG_HARDWARE_MS) {
    result = -EIO;
    goto fail;
  }
  *result_fd = fd;
  return 0;
fail:
  if (started) (void)ioctl(fd, WDIOC_STOP, 0ul);
  close(fd);
  return result;
}

static int start_hardware(int *fd)
{
  int result = arm_hardware(fd);
  pthread_mutex_lock(&g_lock);
  g_startup = result ? START_FAILED : RUNNING;
  g_status.running = result == 0;
  g_status.error = result;
  pthread_mutex_unlock(&g_lock);
  return result;
}

static int feed_if_healthy(int fd)
{
  uint64_t now;
  pthread_mutex_lock(&g_lock);
  int result = check_health_locked(&now);
  if (result) { pthread_mutex_unlock(&g_lock); return result; }
  /* 检查和喂狗在同一临界区，防止别的线程已锁存故障后又补喂一次。 */
  if (ioctl(fd, WDIOC_KEEPALIVE, 0ul) < 0) {
    result = -errno;
    result = latch_fault(result, 0);
  } else {
    g_status.last_feed_ms = now;
  }
  pthread_mutex_unlock(&g_lock);
  return result;
}

static int watchdog_main(int argc, char **argv)
{
  (void)argc; (void)argv;
  int fd;
  int result = start_hardware(&fd);
  if (result) {
    syslog(LOG_ERR, "[watchdog] start failed: %d\n", result);
    return 1;
  }
  syslog(LOG_INFO, "[watchdog] armed: hardware=%ums, progress=%ums\n",
         PX_WATCHDOG_HARDWARE_MS, PX_WATCHDOG_STALL_MS);
  bool reported = false;
  for (;;) {
    result = feed_if_healthy(fd);
    if (result && !reported) {
      reported = true;
      struct px_watchdog_status status;
      px_watchdog_get_status(&status);
      syslog(LOG_ERR, "[watchdog] progress lost: handle=%lu error=%d; reset pending\n",
             (unsigned long)status.failed_handle, result);
    }
    /* 故障后继续持有fd且不STOP、不喂狗，迟到的进展不能取消硬件复位。 */
    struct timespec delay = {WATCHDOG_POLL_MS / 1000u,
                            (WATCHDOG_POLL_MS % 1000u) * 1000000L};
    while (nanosleep(&delay, &delay) < 0 && errno == EINTR) { }
  }
  return 0;
}

int px_watchdog_start(void)
{
  pthread_mutex_lock(&g_lock);
  if (g_startup == RUNNING || g_startup == START_FAILED) {
    int result = g_status.error;
    pthread_mutex_unlock(&g_lock);
    return result;
  }
  if (g_startup == STARTING) {
    pthread_mutex_unlock(&g_lock);
    return -EINPROGRESS;
  }
  g_startup = STARTING;
  pthread_mutex_unlock(&g_lock);
  /* kthread拥有独立task group；由它打开fd，避免继承调用者失效的descriptor。 */
  int pid = kthread_create("px-watchdog", WATCHDOG_PRIORITY, WATCHDOG_STACK_BYTES,
                           watchdog_main, NULL);
  if (pid < 0) {
    pthread_mutex_lock(&g_lock);
    g_startup = START_FAILED;
    g_status.error = pid;
    pthread_mutex_unlock(&g_lock);
    return pid;
  }
  /* NuttX 上硬件 open/ioctl 可能被坏设备拖住；这里只确认任务已创建，
   * 由 watchdog_main 更新 RUNNING/START_FAILED。宿主也使用同一异步路径，
   * 避免同步测试掩盖低优先级监督任务晚于 VM/按键 worker 启动的竞态。 */
  pthread_mutex_lock(&g_lock);
  int result = g_status.error;
  pthread_mutex_unlock(&g_lock);
  return result;
}

static int wait_for_startup(void)
{
  /* 仅客户端在注册前让出 CPU，不能持锁等待或在这里访问设备；
   * open/ioctl 卡住时最多等待 200 次短睡眠，NSH 始终可调度。 */
  for (unsigned poll = 0; poll <= WATCHDOG_START_POLLS; ++poll) {
    pthread_mutex_lock(&g_lock);
    enum startup_state state = g_startup;
    int result = state == START_FAILED ? g_status.error :
                 state == NOT_STARTED ? -EAGAIN : 0;
    pthread_mutex_unlock(&g_lock);
    if (state != STARTING) return result;
    if (poll == WATCHDOG_START_POLLS) return -ETIMEDOUT;
    struct timespec delay = {0, WATCHDOG_START_POLL_MS * 1000000L};
    nanosleep(&delay, NULL);
  }
  return -ETIMEDOUT;
}

int px_watchdog_register(uint32_t *handle)
{
  if (!handle) return -EINVAL;
  *handle = 0;
  int result = wait_for_startup();
  if (result) return result;
  uint64_t now;
  pthread_mutex_lock(&g_lock);
  result = check_health_locked(&now);
  if (!result) {
    result = -ENOSPC;
    for (unsigned i = 0; i < PX_WATCHDOG_MAX_CLIENTS; ++i) {
      if (g_clients[i].handle) continue;
      do { ++g_next_handle; } while (!g_next_handle || find_client(g_next_handle));
      g_clients[i] = (struct health_client){g_next_handle, false, now};
      ++g_status.registered;
      *handle = g_next_handle;
      result = 0;
      break;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return result;
}

enum client_operation { BEGIN, BEAT, END, UNREGISTER };
static int update_client(uint32_t handle, enum client_operation operation)
{
  uint64_t now;
  pthread_mutex_lock(&g_lock);
  int result = check_health_locked(&now);
  struct health_client *client = find_client(handle);
  if (!result && !client) result = -ENOENT;
  if (!result) {
    if (operation == BEGIN) {
      if (client->busy) result = -EALREADY;
      else { client->busy = true; client->progress_ms = now; ++g_status.busy; }
    } else if (operation == BEAT) {
      if (!client->busy) result = -EINVAL;
      else client->progress_ms = now;
    } else if (operation == END) {
      if (!client->busy) result = -EINVAL;
      else { client->busy = false; --g_status.busy; }
    } else {
      if (client->busy) result = -EBUSY;
      else { memset(client, 0, sizeof(*client)); --g_status.registered; }
    }
  }
  pthread_mutex_unlock(&g_lock);
  return result;
}

int px_watchdog_begin(uint32_t handle) { return update_client(handle, BEGIN); }
int px_watchdog_beat(uint32_t handle) { return update_client(handle, BEAT); }
int px_watchdog_end(uint32_t handle) { return update_client(handle, END); }
int px_watchdog_unregister(uint32_t handle) { return update_client(handle, UNREGISTER); }

int px_watchdog_get_status(struct px_watchdog_status *status)
{
  if (!status) return -EINVAL;
  uint64_t now;
  pthread_mutex_lock(&g_lock);
  if (g_startup == RUNNING) (void)check_health_locked(&now);
  *status = g_status;
  pthread_mutex_unlock(&g_lock);
  return 0;
}

#ifdef PX_WATCHDOG_TEST
/* 测试只驱动真实状态机和ioctl顺序，不启动宿主永不退出的监督线程。 */
static int g_test_fd = -1;
int px_watchdog_test_setup(void) { return start_hardware(&g_test_fd); }
int px_watchdog_test_tick(void) { return feed_if_healthy(g_test_fd); }
#endif

#else
int px_watchdog_start(void) { return -ENOTSUP; }
int px_watchdog_register(uint32_t *handle)
{ if (handle) *handle = 0; return -ENOTSUP; }
int px_watchdog_begin(uint32_t handle) { (void)handle; return -ENOTSUP; }
int px_watchdog_beat(uint32_t handle) { (void)handle; return -ENOTSUP; }
int px_watchdog_end(uint32_t handle) { (void)handle; return -ENOTSUP; }
int px_watchdog_unregister(uint32_t handle) { (void)handle; return -ENOTSUP; }
int px_watchdog_get_status(struct px_watchdog_status *status)
{ if (!status) return -EINVAL; memset(status, 0, sizeof(*status)); return 0; }
#endif
