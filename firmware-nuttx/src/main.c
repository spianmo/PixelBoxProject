#ifdef __NuttX__
#  include <nuttx/config.h>
#  include <sys/mount.h>
#  include <sys/statfs.h>
#  include <sys/wait.h>
#  include <sched.h>
#  include <malloc.h>
#  include <nuttx/kthread.h>
#  include "pixelbox_board.h"
#  include "pixelbox_watchdog.h"
#  ifdef CONFIG_ARCH_CHIP_ESP32S3
#    include "soc/rtc_cntl_reg.h"
#    include "soc/spi_mem_reg.h"
#  endif
#  ifdef CONFIG_INTERPRETERS_PIXELBOX_CONSOLE_AFTER_APP
#    include "nshlib/nshlib.h"
#  endif
#endif

#include "pixelbox.h"
#include "pixelbox_wifi.h"
#include "pixelbox_power.h"
#include "pixelbox_service.h"
#include "pixelbox_mdns.h"
#include "pixelbox_system_keys.h"
#ifdef PX_TIMED_SLEEP
#include "pixelbox_sleep.h"
#endif
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef CONFIG_INTERPRETERS_PIXELBOX_HEAP_SIZE
#  define CONFIG_INTERPRETERS_PIXELBOX_HEAP_SIZE (4 * 1024 * 1024)
#endif
#ifndef CONFIG_INTERPRETERS_PIXELBOX_APP_ROOT
#  define CONFIG_INTERPRETERS_PIXELBOX_APP_ROOT "/data/app"
#endif
#ifndef CONFIG_INTERPRETERS_PIXELBOX_DATA_ROOT
#  define CONFIG_INTERPRETERS_PIXELBOX_DATA_ROOT "/data"
#endif

#ifdef __NuttX__
/* Flash 文件系统探测/挂载可能等待底层 MTD 锁；放到低优先级 worker，不能阻塞
 * 启动任务和 USB NSH。服务监督器会在挂载完成后自动重试。 */
static int storage_mount_worker(int argc, char **argv)
{
  (void)argc;
  (void)argv;
#if defined(CONFIG_FS_LITTLEFS) && defined(CONFIG_ESP32S3_SPIFLASH)
  struct statfs mounted;
  printf("[pixelbox] storage mount worker starting\n");
  bool data_ready = statfs("/data", &mounted) == 0 &&
                    mounted.f_type == LITTLEFS_SUPER_MAGIC;
  if (!data_ready && mount("/dev/esp32s3flash", "/data", "littlefs", 0, NULL) &&
      errno != EBUSY)
    {
      fprintf(stderr,
              "[pixelbox] /data 未挂载: %s；请显式配置/格式化 LittleFS，未执行自动格式化\n",
              strerror(errno));
      return -errno;
    }
  printf("[pixelbox] storage mount worker ready\n");
#else
  printf("[pixelbox] storage mount worker skipped\n");
#endif
  return 0;
}

/* AXP2101 的 I2C 探测可能在控制器异常时一直等待；不能让它阻塞
 * init/NSH。独立任务只负责一次初始化，按键 worker 会在成功后自动使用 PMU。 */
static int power_init_worker(int argc, char **argv)
{
  (void)argc;
  (void)argv;
  printf("[pixelbox] PMU init worker starting\n");
  int result = px_power_init("/dev/i2c0");
  if (result < 0) {
    fprintf(stderr, "[pixelbox] PMU probe failed: %d\n", result);
    return result;
  }
  printf("[pixelbox] PMU probe ready\n");
  result = px_power_enable_monitoring();
  if (result < 0)
    fprintf(stderr, "[pixelbox] PMU monitoring failed: %d\n", result);
  else
    printf("[pixelbox] PMU monitoring ready\n");
  return result;
}
#endif

static int positive_number(const char *text, unsigned *value)
{
  char *end;
  errno = 0;
  unsigned long parsed = strtoul(text, &end, 10);
  if (errno || !*text || *end || text[0] == '-' || parsed > 2147483647UL)
    return -1;
  *value = (unsigned)parsed;
  return 0;
}

#if defined(__NuttX__)
static void initialize_platform(void)
{
  /* 服务归轻量启动任务所有，JS应用结束不会终止Wi-Fi线程或关闭其descriptor。 */
  static int initialized;
  if (initialized) return;
  initialized = 1;
#ifdef CONFIG_ARCH_CHIP_ESP32S3
  /* 直接记录只读启动诊断，避免为了查看原因而用 JTAG halt 并停掉看门狗。 */
  printf("[pixelbox] reset cause cpu0=%u cpu1=%u; clock_glitch_reset=%u\n",
         (unsigned)REG_GET_FIELD(RTC_CNTL_RESET_STATE_REG, RTC_CNTL_RESET_CAUSE_PROCPU),
         (unsigned)REG_GET_FIELD(RTC_CNTL_RESET_STATE_REG, RTC_CNTL_RESET_CAUSE_APPCPU),
         (unsigned)REG_GET_FIELD(RTC_CNTL_ANA_CONF_REG, RTC_CNTL_GLITCH_RST_EN));
  /* 读取实际取指控制器模式；配置启用QIO不代表Flash的QE已设置成功。 */
  uint32_t flash_ctrl = REG_READ(SPI_MEM_CTRL_REG(0));
  uint32_t flash_mode = flash_ctrl & (SPI_MEM_FREAD_QIO | SPI_MEM_FREAD_DIO |
                                     SPI_MEM_FREAD_QUAD | SPI_MEM_FREAD_DUAL);
  const char *flash_mode_name = flash_mode == SPI_MEM_FREAD_QIO ? "QIO" :
                               flash_mode == SPI_MEM_FREAD_DIO ? "DIO" :
                               flash_mode == SPI_MEM_FREAD_QUAD ? "QOUT" :
                               flash_mode == SPI_MEM_FREAD_DUAL ? "DOUT" : "other";
  printf("[pixelbox] flash read mode=%s ctrl=0x%08lx\n",
         flash_mode_name, (unsigned long)flash_ctrl);
#endif
  (void)pixelbox_board_initialize();
  printf("[pixelbox] board initialization complete\n");
  int watchdog_result = px_watchdog_start();
  printf("[pixelbox] watchdog start returned %d\n", watchdog_result);
  if (watchdog_result < 0) fprintf(stderr, "[pixelbox] watchdog unavailable: %d\n", watchdog_result);
  /* 无线服务归启动任务所有，切换 JS 应用不销毁已建立的连接与 DHCP 续租线程。 */
  printf("[pixelbox] Wi-Fi init starting\n");
  int wifi_result = px_wifi_init("wlan0");
  printf("[pixelbox] Wi-Fi init returned %d\n", wifi_result);
  if (wifi_result < 0) fprintf(stderr, "[pixelbox] Wi-Fi service init failed: %d\n", wifi_result);
  int storage_pid = kthread_create("px-storage", 80, 4096,
                                   storage_mount_worker, NULL);
  if (storage_pid < 0)
    fprintf(stderr, "[pixelbox] storage worker failed: %d\n", storage_pid);
  else
    printf("[pixelbox] storage worker started: pid=%d\n", storage_pid);
  int power_pid = kthread_create("px-power-init", 80, 4096, power_init_worker, NULL);
  if (power_pid < 0)
    fprintf(stderr, "[pixelbox] PMU init worker failed: %d\n", power_pid);
  else
    printf("[pixelbox] PMU init worker started: pid=%d\n", power_pid);
  printf("[pixelbox] system keys init starting\n");
  int keys_result = px_system_keys_start();
  printf("[pixelbox] system keys init returned %d\n", keys_result);
  if (keys_result < 0) fprintf(stderr, "[pixelbox] system keys init: %d\n", keys_result);
}
#endif

static int network_status(void *opaque, struct px_service_network *out)
{
  (void)opaque;
  struct px_wifi_status status;
  int result = px_wifi_get_status(&status);
  if (result) return result;
  snprintf(out->ip, sizeof(out->ip), "%s", status.ip);
  snprintf(out->mac, sizeof(out->mac), "%s", status.mac);
#ifdef __NuttX__
  out->heap_free = mallinfo().fordblks;
#else
  out->heap_free = 0;
#endif
  return 0;
}

static int serve_app(const struct px_options *options, unsigned port)
{
#ifdef PX_TIMED_SLEEP
  /* 进入平台阶段后失败也不自动重启同一睡眠脚本；devd 的显式 restart 仍可恢复。 */
  static bool hold_after_sleep_attempt;
#endif
#if defined(__NuttX__) && defined(CONFIG_FS_LITTLEFS) && defined(CONFIG_ESP32S3_SPIFLASH)
  /* 挂载由独立低优先级任务完成；不能在 pseudo 根目录上创建 apps 并缓存
   * “未安装应用”。未就绪时返回监督循环重试，NSH 仍在自己的任务运行。 */
  struct statfs mounted;
  if (statfs(options->data_root, &mounted) < 0 ||
      mounted.f_type != LITTLEFS_SUPER_MAGIC) {
    fprintf(stderr, "[pixelbox] waiting for persistent storage before devd/app startup\n");
    return 1;
  }
#endif
#ifdef __NuttX__
  /* board I2C 探测在独立 worker 中执行。这里只在启动任务内最多等待
   * 250ms；NSH 是独立任务，不会被 I2C 控制器异常拖住。若仍未完成，交给
   * 外层监督器稍后重试，避免 JS 在 touchAvailable=false 时直接退出。 */
  for (unsigned attempt = 0; attempt < 25; ++attempt) {
    int io_status = pixelbox_board_io_status();
    if (io_status != 0) break;
    usleep(10000);
  }
  int io_status = pixelbox_board_io_status();
  if (io_status == 0) {
    fprintf(stderr, "[pixelbox] waiting for board I2C probe before devd/app startup\n");
    return 1;
  }
  if (io_status < 0)
    fprintf(stderr, "[pixelbox] board I2C probe failed (%d); optional devices remain unavailable\n",
            io_status);
#endif
  char storage[512];
  int length = snprintf(storage, sizeof(storage), "%s/apps", options->data_root);
  if (length < 0 || (size_t)length >= sizeof(storage)) return 2;
  struct px_service_config config = {
    .devd = {.storage_root = storage, .port = port, .name = "PixelBox",
#ifdef __NuttX__
             .advertise = true,
#endif
             .model = "pixelbox-nuttx-esp32s3", .firmware = "0.1.0"},
    .app = *options, .run_app = px_run, .start_on_boot = true,
#ifdef PX_TIMED_SLEEP
    .prepare_sleep = px_sleep_prepare,
#endif
#ifdef PX_SERVICE_PORTAL
    /* 配网仅由已启用的监督器接管；普通启动不主动开启热点。 */
    .enable_portal = true,
#endif
    .app_priority = 100, .network_status = network_status
  };
  struct px_service *service = NULL;
#ifdef PX_TIMED_SLEEP
  if (hold_after_sleep_attempt || px_sleep_woke_from_deep_sleep()) {
    config.start_on_boot = false;
    printf("[pixelbox] deep-sleep wake: application stays stopped; explicit restart required\n");
  }
#endif
  int result = px_service_create(&config, &service);
  if (result) { fprintf(stderr, "[pixelbox] devd service failed: %d\n", result); return 1; }
  printf("[pixelbox] devd listening on port %u\n", px_service_port(service));
  fflush(stdout);
  result = px_service_run(service);
#ifdef PX_TIMED_SLEEP
  uint32_t sleep_duration = 0;
  int sleep_requested = px_service_take_sleep(service, &sleep_duration);
  if (sleep_requested == 1) hold_after_sleep_attempt = true;
#endif
  int destroyed = px_service_destroy(service);
  /* 监督器已回收 VM 和 devd 后才结束共享广播，不能在每代 VM 退出时关闭。 */
  int mdns_result = destroyed ? 0 : px_mdns_shutdown();
  if (mdns_result) fprintf(stderr, "[pixelbox] mDNS shutdown incomplete: %d\n", mdns_result);
  if (result || destroyed || mdns_result) return 1;
#ifdef PX_TIMED_SLEEP
  if (sleep_requested == 1) {
    int slept = px_sleep_enter(sleep_duration);
    fprintf(stderr, "[pixelbox] timed sleep did not enter: %d\n", slept);
    return 1;
  }
#endif
  return 0;
}

int pixelbox_main(int argc, char *argv[])
{
#ifdef __NuttX__
  initialize_platform();
#endif
  /* 启动阶段示例模型会预计算多组体素；适当放宽单轮预算仍保留死循环保护。 */
  struct px_options options = {
    CONFIG_INTERPRETERS_PIXELBOX_APP_ROOT,
    CONFIG_INTERPRETERS_PIXELBOX_DATA_ROOT,
    NULL, CONFIG_INTERPRETERS_PIXELBOX_HEAP_SIZE, 3000, 0, NULL
  };
  bool serve = false;
  unsigned port = 8765;
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--serve")) serve = true;
    else if (!strcmp(argv[i], "--port") && i + 1 < argc) {
      if (positive_number(argv[++i], &port) || port > 65535) return 2;
    }
    else if (!strcmp(argv[i], "--app-root") && i + 1 < argc)
      options.app_root = argv[++i];
    else if (!strcmp(argv[i], "--data-root") && i + 1 < argc)
      options.data_root = argv[++i];
    else if (!strcmp(argv[i], "--eval") && i + 1 < argc) {
      if (options.eval_source || options.entry) return 2;
      options.eval_source = argv[++i];
    }
    else if (!strcmp(argv[i], "--timeout-ms") && i + 1 < argc) {
      if (positive_number(argv[++i], &options.runtime_timeout_ms)) return 2;
    } else if (!strcmp(argv[i], "--turn-timeout-ms") && i + 1 < argc) {
      if (positive_number(argv[++i], &options.turn_timeout_ms) || !options.turn_timeout_ms) return 2;
    } else if (!strcmp(argv[i], "--heap-bytes") && i + 1 < argc) {
      unsigned bytes;
      if (positive_number(argv[++i], &bytes) || bytes < 262144) return 2;
      options.heap_limit = bytes;
    } else if (!strcmp(argv[i], "--help")) {
      puts("pixelbox [--app-root /app] [--data-root /data] [--timeout-ms N]\n"
           "         [--turn-timeout-ms 3000] [--heap-bytes N] [--eval SOURCE | main.js]\n"
           "         [--serve --port 8765]");
      return 0;
    } else if (argv[i][0] == '-' || options.entry || options.eval_source) {
      fprintf(stderr, "未知或重复参数: %s\n", argv[i]);
      return 2;
    } else options.entry = argv[i];
  }
  if (serve) return serve_app(&options, port);
  int result = px_run(&options);
#ifndef __NuttX__
  /* 宿主单进程收尾；NSH 的一次 --eval 不得关闭后台监督器的设备广播。 */
  int mdns_result = px_mdns_shutdown();
  if (mdns_result) { fprintf(stderr, "[pixelbox] mDNS shutdown incomplete: %d\n", mdns_result); return 1; }
#endif
  return result;
}

#ifdef __NuttX__
#ifdef CONFIG_INTERPRETERS_PIXELBOX_CONSOLE_AFTER_APP
static int console_main(int argc, char *argv[])
{
  puts("[pixelbox] NSH console ready; storage is never formatted automatically.");
  return nsh_consolemain(argc, argv);
}
#endif

int pixelbox_boot_main(int argc, char *argv[])
{
  (void)argc; (void)argv;
  /* USB NSH 先于所有硬件服务创建；任何驱动等待都不能夺走恢复入口。 */
#ifdef CONFIG_INTERPRETERS_PIXELBOX_CONSOLE_AFTER_APP
  nsh_initialize();
  int console_pid = task_create("pixelbox-nsh", CONFIG_INTERPRETERS_PIXELBOX_PRIORITY,
                                8192, console_main, NULL);
  if (console_pid < 0) fprintf(stderr, "[pixelbox] NSH task failed: %d\n", errno);
#endif
  initialize_platform();
  /* init始终保留Wi-Fi/devd所有权，NSH和JS各用独立任务；应用退出不丢远程入口。 */
  const struct px_options options = {
    CONFIG_INTERPRETERS_PIXELBOX_APP_ROOT, CONFIG_INTERPRETERS_PIXELBOX_DATA_ROOT,
    NULL, CONFIG_INTERPRETERS_PIXELBOX_HEAP_SIZE, 3000, 0, NULL
  };
  for (;;) {
    (void)serve_app(&options, 8765);
    /* 存储/监听暂不可用仍保持init及NSH存活；不让退出连带终止Wi-Fi线程。 */
    fprintf(stderr, "[pixelbox] supervisor stopped; retrying in 5 seconds\n");
    sleep(5);
  }
}
#endif

#ifndef __NuttX__
int main(int argc, char *argv[]) { return pixelbox_main(argc, argv); }
#endif
