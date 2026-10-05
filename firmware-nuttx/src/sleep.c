#ifdef __NuttX__
#include <nuttx/config.h>
#endif
#include "pixelbox_sleep.h"
#include "pixelbox.h"
#include <errno.h>
#include <math.h>
#include <stddef.h>

int px_sleep_validate(double milliseconds, uint32_t *duration)
{
  if (!duration || !isfinite(milliseconds) || milliseconds < 1 ||
      milliseconds > PX_SLEEP_MAX_MS || floor(milliseconds) != milliseconds) return -EINVAL;
  *duration = (uint32_t)milliseconds;
  return 0;
}

#if defined(__NuttX__) && defined(CONFIG_ARCH_CHIP_ESP32S3) && defined(CONFIG_PM)
#if CONFIG_PM_GOVERNOR_EXPLICIT_RELAX != -1
#error "Timed deep sleep requires PM_GOVERNOR_EXPLICIT_RELAX=-1 to prevent idle sleep"
#endif
#include "pixelbox_audio.h"
#include "pixelbox_mic.h"
#include "pixelbox_watchdog.h"
#include "soc/rtc_cntl_reg.h"
#include <fcntl.h>
#include <nuttx/video/fb.h>
#include <sys/ioctl.h>
#include <unistd.h>

/* NuttX 芯片级公开入口；这里不需要通用 /dev/rtc 驱动。 */
void esp32s3_pmsleep(uint64_t time_in_us);

bool px_sleep_woke_from_deep_sleep(void)
{
  /* 对应 esp32s3_reset_reasons.h 的 RESET_REASON_CORE_DEEP_SLEEP。 */
  return REG_GET_FIELD(RTC_CNTL_RESET_STATE_REG, RTC_CNTL_RESET_CAUSE_PROCPU) == 0x05;
}

int px_sleep_prepare(void *opaque, uint32_t duration)
{
  (void)opaque;
  if (!duration || duration > PX_SLEEP_MAX_MS) return -EINVAL;
#if defined(CONFIG_ESPRESSIF_WIFI) || defined(CONFIG_ESPRESSIF_BLE) || defined(CONFIG_NIMBLE)
  /* Wi-Fi 的 void shutdown 和 BLE 的会话 STOP 不能证明 radio 已停止。
   * 尚未有可验证的完整收尾时，保留恢复通道并明确拒绝，不能假报可睡。 */
  return -ENOTSUP;
#else
  int result = px_mic_quiesce(0);
  return result ? result : px_audio_quiesce(0);
#endif
}

int px_sleep_enter(uint32_t duration)
{
  /* service 已回收自己的 VM，仍需排除刚从 NSH 启动的非托管 VM。
   * 持锁直到芯片睡眠；失败只由本线程释放，不借用其它线程的锁。 */
  int locked = px_runtime_lock_for_sleep();
  if (locked) return locked;
  int result = px_sleep_prepare(NULL, duration);
  if (result) { px_runtime_unlock_after_sleep_failure(); return result; }
  uint32_t health = 0;
  result = px_watchdog_register(&health);
  if (!result) result = px_watchdog_begin(health);
  if (result) {
    if (health) (void)px_watchdog_unregister(health);
    px_runtime_unlock_after_sleep_failure();
    return result;
  }
  int display = -1, previous_power = 0;
#ifdef CONFIG_INTERPRETERS_PIXELBOX_FRAMEBUFFER
  display = open(CONFIG_INTERPRETERS_PIXELBOX_FB_DEVICE, O_RDWR);
  if (display < 0) { result = -errno; goto rejected; }
  if (ioctl(display, FBIOGET_POWER, (unsigned long)&previous_power) < 0 ||
      ioctl(display, FBIOSET_POWER, 0) < 0) { result = -errno; goto rejected; }
#endif
  /* 上层已 join 应用/devd，sync 后不再有 JS 或推送写入。
   * 看门狗 busy 票据保留到不返回的芯片入口，底层意外自旋仍可被监督。 */
  sync();
  (void)px_watchdog_beat(health);
  esp32s3_pmsleep((uint64_t)duration * 1000u);
  result = -EIO; /* 不返回的入口若返回，绝不能声称已经入睡。 */
rejected:
  if (display >= 0) {
    (void)ioctl(display, FBIOSET_POWER, previous_power);
    close(display);
  }
  (void)px_watchdog_end(health);
  (void)px_watchdog_unregister(health);
  px_runtime_unlock_after_sleep_failure();
  return result;
}
#else
bool px_sleep_woke_from_deep_sleep(void) { return false; }
int px_sleep_prepare(void *opaque, uint32_t duration)
{ (void)opaque; (void)duration; return -ENOTSUP; }
int px_sleep_enter(uint32_t duration) { (void)duration; return -ENOTSUP; }
#endif
