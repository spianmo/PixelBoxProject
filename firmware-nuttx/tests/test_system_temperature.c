#include "pixelbox_system_net.h"
#include "system_temperature_test_platform.h"
#include <assert.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct test_temperature_registers SENS;
static unsigned module_enables, sar_enables, clock_enables, powers, calibration_reads, elapsed;
static unsigned wake_after;
static int calibration_result;
static float calibration = 15;
int esp_efuse_rtc_calib_get_tsens_val(float *out) { ++calibration_reads; *out = calibration; return calibration_result; }
void periph_module_enable(int module) { assert(module == PERIPH_SARADC_MODULE); ++module_enables; }
void regi2c_saradc_enable(void) { ++sar_enables; }
void temperature_sensor_ll_clk_enable(bool enabled) { assert(enabled); ++clock_enables; }
void temperature_sensor_ll_set_clk_div(uint8_t value) { assert(value == 6); }
void temperature_sensor_ll_set_range(uint32_t value) { assert(value == 15); }
void temperature_sensor_ll_enable(bool enabled) { assert(enabled); ++powers; }
void esp_rom_delay_us(unsigned value)
{
  elapsed += value;
  if (wake_after && elapsed >= wake_after) SENS.sar_tctrl.tsens_ready = 1;
}
int main(int argc, char **argv)
{
  assert(argc == 2); double value = -999;
  if (!strcmp(argv[1], "uncalibrated")) calibration_result = ESP_ERR_NOT_SUPPORTED;
  if (!strcmp(argv[1], "negative")) calibration = -15;
  if (!strcmp(argv[1], "error")) {
    calibration_result = 1; assert(px_system_temperature(&value) == -EIO);
    assert(value == -999 && !module_enables); calibration_result = 0;
  }
  if (!strcmp(argv[1], "nan")) {
    calibration = NAN; assert(px_system_temperature(&value) == -EIO);
    assert(value == -999 && !module_enables); calibration = 15;
  }
  assert(px_system_temperature(NULL) == -EINVAL);
  SENS.sar_tctrl.tsens_out = 100; wake_after = 350;
  assert(!px_system_temperature(&value));
  double expected = 23.34 - (calibration_result == ESP_ERR_NOT_SUPPORTED ? 0 : calibration / 10.0);
  assert(fabs(value - expected) < 0.000001 && !SENS.sar_tctrl.tsens_dump_out);
  assert(elapsed == 350 && module_enables == 1 && sar_enables == 1 && clock_enables == 1 && powers == 1);
  unsigned reads = calibration_reads;
  assert(!px_system_temperature(&value) && calibration_reads == reads && module_enables == 1);
  /* ready永久不置位时，1000次10us后超时，并清除请求；后续调用仍能恢复。 */
  SENS.sar_tctrl.tsens_ready = 0; wake_after = 0; elapsed = 0;
  value = -999; assert(px_system_temperature(&value) == -ETIMEDOUT);
  assert(elapsed == 10000 && value == -999 && !SENS.sar_tctrl.tsens_dump_out);
  SENS.sar_tctrl.tsens_ready = 1; assert(!px_system_temperature(&value));
  SENS.sar_tctrl.tsens_out = 0; assert(px_system_temperature(&value) == -ERANGE);
  SENS.sar_tctrl.tsens_out = 255; assert(px_system_temperature(&value) == -ERANGE);
  printf("芯片温度通过：%s、eFuse修正、初始化引用、10ms采样超时/恢复与量程\n", argv[1]);
  return 0;
}
