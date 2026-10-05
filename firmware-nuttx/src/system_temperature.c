/* ESP32-S3芯片温度：沿用-10..80℃量程与eFuse修正；采样ready等待有硬上限。 */
#ifdef __NuttX__
#include <nuttx/config.h>
#endif
#include "pixelbox_system_net.h"
#include <errno.h>
#include <pthread.h>
#include <math.h>
#include <stdbool.h>

#if defined(PX_SYSTEM_TEMPERATURE_TEST) || (defined(__NuttX__) && defined(CONFIG_ARCH_CHIP_ESP32S3))
#ifdef PX_SYSTEM_TEMPERATURE_TEST
#include "system_temperature_test_platform.h"
#else
#include "esp_efuse_rtc_calib.h"
#include "esp_private/periph_ctrl.h"
#include "esp_private/regi2c_ctrl.h"
#include "esp_rom_sys.h"
#include "hal/temperature_sensor_ll.h"
#include "soc/periph_defs.h"
#endif

static pthread_mutex_t temperature_lock = PTHREAD_MUTEX_INITIALIZER;
static bool temperature_initialized;
static float temperature_calibration;

int px_system_temperature(double *celsius)
{
  if (!celsius) return -EINVAL;
  int error = pthread_mutex_lock(&temperature_lock);
  if (error) return -error;
  if (!temperature_initialized) {
    float calibration = 0;
    int result = esp_efuse_rtc_calib_get_tsens_val(&calibration);
    if (result != ESP_OK && result != ESP_ERR_NOT_SUPPORTED) {
      pthread_mutex_unlock(&temperature_lock); return -EIO;
    }
    if (!isfinite(calibration)) { pthread_mutex_unlock(&temperature_lock); return -EIO; }
    temperature_calibration = result == ESP_OK ? calibration : 0;
    /* 保留一次全局引用，不reset/关闭共用SARADC，避免破坏Wi-Fi或其它ADC使用者。
     * 旧SDK也在首次读取后保留已启用传感器，后续调用只读样本。
     */
    periph_module_enable(PERIPH_SARADC_MODULE);
    regi2c_saradc_enable();
    temperature_sensor_ll_clk_enable(true);
    temperature_sensor_ll_set_clk_div(6);
    temperature_sensor_ll_set_range(15); /* offset=0，-10..80℃，误差档1℃ */
    temperature_sensor_ll_enable(true);
    esp_rom_delay_us(300);
    temperature_initialized = true;
  }
  SENS.sar_tctrl.tsens_dump_out = 1;
  unsigned attempts = 0;
  while (!SENS.sar_tctrl.tsens_ready && attempts < 1000) {
    esp_rom_delay_us(10); ++attempts;
  }
  /* 不调用HAL无界busy-loop；无论成功/超时，都清除dump请求以允许下一次重试。 */
  bool ready = SENS.sar_tctrl.tsens_ready;
  unsigned raw = ready ? HAL_FORCE_READ_U32_REG_FIELD(SENS.sar_tctrl, tsens_out) : 0;
  SENS.sar_tctrl.tsens_dump_out = 0;
  double value = TEMPERATURE_SENSOR_LL_ADC_FACTOR * raw - TEMPERATURE_SENSOR_LL_OFFSET_FACTOR -
                 (double)temperature_calibration / 10.0;
  pthread_mutex_unlock(&temperature_lock);
  if (!ready) return -ETIMEDOUT;
  if (!isfinite(value) || value < -10 || value > 80) return -ERANGE;
  *celsius = value; return 0;
}
#else
int px_system_temperature(double *celsius) { return celsius ? -ENOTSUP : -EINVAL; }
#endif
