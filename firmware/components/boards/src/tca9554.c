/* TCA9554 IO 扩展器最小驱动 (寄存器级自写) */
#include "boards/tca9554.h"

#include <string.h>
#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "tca9554";

#define REG_INPUT  0x00
#define REG_OUTPUT 0x01
#define REG_CONFIG 0x03

static i2c_master_dev_handle_t s_dev;
/* 输出/方向寄存器影子值 (芯片复位默认: 输出 0xFF, 方向 0xFF 全输入) */
static uint8_t s_shadow_output = 0xFF;
static uint8_t s_shadow_config = 0xFF;

static esp_err_t reg_write(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = { reg, val };
    return i2c_master_transmit(s_dev, buf, sizeof(buf), 100);
}

static esp_err_t reg_read(uint8_t reg, uint8_t *val)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, val, 1, 100);
}

esp_err_t tca9554_init(board_i2c_bus_handle_t bus, uint8_t addr)
{
    if (s_dev) {
        return ESP_OK;
    }
    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = 400000,
    };
    esp_err_t err = i2c_master_bus_add_device(bus, &cfg, &s_dev);
    if (err != ESP_OK) {
        return err;
    }
    /* 探测: 读输入寄存器确认器件在位 */
    uint8_t dummy = 0;
    err = reg_read(REG_INPUT, &dummy);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "探测失败 (addr=0x%02X), IO 扩展器不可用", addr);
        i2c_master_bus_rm_device(s_dev);
        s_dev = NULL;
        return err;
    }
    /* 同步影子寄存器 */
    reg_read(REG_OUTPUT, &s_shadow_output);
    reg_read(REG_CONFIG, &s_shadow_config);
    ESP_LOGI(TAG, "初始化完成 (addr=0x%02X)", addr);
    return ESP_OK;
}

bool tca9554_available(void)
{
    return s_dev != NULL;
}

esp_err_t tca9554_set_direction(uint8_t pin, bool output)
{
    if (!s_dev || pin > 7) {
        return ESP_ERR_INVALID_STATE;
    }
    if (output) {
        s_shadow_config &= ~(1u << pin);
    } else {
        s_shadow_config |= (1u << pin);
    }
    return reg_write(REG_CONFIG, s_shadow_config);
}

esp_err_t tca9554_write(uint8_t pin, bool level)
{
    if (!s_dev || pin > 7) {
        return ESP_ERR_INVALID_STATE;
    }
    if (level) {
        s_shadow_output |= (1u << pin);
    } else {
        s_shadow_output &= ~(1u << pin);
    }
    return reg_write(REG_OUTPUT, s_shadow_output);
}

esp_err_t tca9554_read(uint8_t pin, bool *level)
{
    if (!s_dev || pin > 7 || !level) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t v = 0;
    esp_err_t err = reg_read(REG_INPUT, &v);
    if (err != ESP_OK) {
        return err;
    }
    *level = (v >> pin) & 1u;
    return ESP_OK;
}
