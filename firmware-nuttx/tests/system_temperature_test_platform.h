#ifndef SYSTEM_TEMPERATURE_TEST_PLATFORM_H
#define SYSTEM_TEMPERATURE_TEST_PLATFORM_H
#include <stdbool.h>
#include <stdint.h>

#define ESP_OK 0
#define ESP_ERR_NOT_SUPPORTED 0x106
#define PERIPH_SARADC_MODULE 1
#define TEMPERATURE_SENSOR_LL_ADC_FACTOR 0.4386
#define TEMPERATURE_SENSOR_LL_OFFSET_FACTOR 20.52
#define HAL_FORCE_READ_U32_REG_FIELD(reg, field) ((reg).field)

struct test_temperature_registers {
  struct { unsigned tsens_dump_out, tsens_ready, tsens_out; } sar_tctrl;
};
extern struct test_temperature_registers SENS;
int esp_efuse_rtc_calib_get_tsens_val(float *value);
void periph_module_enable(int module);
void regi2c_saradc_enable(void);
void temperature_sensor_ll_clk_enable(bool enabled);
void temperature_sensor_ll_set_clk_div(uint8_t value);
void temperature_sensor_ll_set_range(uint32_t value);
void temperature_sensor_ll_enable(bool enabled);
void esp_rom_delay_us(unsigned value);
#endif
