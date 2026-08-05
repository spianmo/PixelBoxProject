/* AXP2101 PMU 最小 I2C 驱动 */
#include "boards/axp2101.h"

#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "axp2101";

/* 寄存器定义 (对齐 XPowersLib) */
#define REG_STATUS1        0x00 /* bit3: 电池在位 */
#define REG_STATUS2        0x01 /* bit[6:5]: 00 待机 01 充电 10 放电 */
#define REG_CHIP_ID        0x03
#define REG_ADC_CH_CTRL    0x30 /* bit0: VBAT ADC 使能 */
#define REG_VBAT_H         0x34 /* VBAT 高 6 位 */
#define REG_VBAT_L         0x35 /* VBAT 低 8 位, 合并后单位 mV */
#define REG_FUEL_GAUGE     0x68 /* bit0: 电池检测使能 */
#define REG_BAT_PERCENT    0xA4 /* 电量百分比 0-100 */

#define CHIP_ID_AXP2101    0x4A

static i2c_master_dev_handle_t s_dev;

static esp_err_t reg_read(uint8_t reg, uint8_t *val)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, val, 1, 100);
}

static esp_err_t reg_write(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = { reg, val };
    return i2c_master_transmit(s_dev, buf, sizeof(buf), 100);
}

static esp_err_t reg_set_bits(uint8_t reg, uint8_t mask)
{
    uint8_t v = 0;
    esp_err_t err = reg_read(reg, &v);
    if (err != ESP_OK) {
        return err;
    }
    return reg_write(reg, v | mask);
}

esp_err_t axp2101_init(board_i2c_bus_handle_t bus, uint8_t addr)
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

    uint8_t id = 0;
    err = reg_read(REG_CHIP_ID, &id);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "探测失败 (addr=0x%02X), PMU 不可用", addr);
        i2c_master_bus_rm_device(s_dev);
        s_dev = NULL;
        return err;
    }
    if (id != CHIP_ID_AXP2101) {
        ESP_LOGW(TAG, "芯片 ID 0x%02X 与 AXP2101(0x4A) 不符, 继续尝试使用", id);
    }

    /* 使能电池检测 + VBAT ADC (电量计上电默认开启, 这里确保打开) */
    reg_set_bits(REG_FUEL_GAUGE, 0x01);
    reg_set_bits(REG_ADC_CH_CTRL, 0x01);

    ESP_LOGI(TAG, "初始化完成 (addr=0x%02X id=0x%02X)", addr, id);
    return ESP_OK;
}

bool axp2101_available(void)
{
    return s_dev != NULL;
}

esp_err_t axp2101_read_battery(board_battery_info_t *out)
{
    if (!out) {
        return ESP_ERR_INVALID_ARG;
    }
    out->level = -1;
    out->charging = false;
    out->voltage_mv = 0;
    if (!s_dev) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t st1 = 0, st2 = 0;
    esp_err_t err = reg_read(REG_STATUS1, &st1);
    if (err != ESP_OK) {
        return err;
    }
    err = reg_read(REG_STATUS2, &st2);
    if (err != ESP_OK) {
        return err;
    }

    bool bat_present = (st1 >> 3) & 1u;
    out->charging = (((st2 >> 5) & 0x03) == 0x01);

    if (!bat_present) {
        /* 无电池: level = -1 (契约约定) */
        return ESP_OK;
    }

    uint8_t pct = 0;
    if (reg_read(REG_BAT_PERCENT, &pct) == ESP_OK) {
        out->level = (pct > 100) ? 100 : pct;
    }

    uint8_t vh = 0, vl = 0;
    if (reg_read(REG_VBAT_H, &vh) == ESP_OK && reg_read(REG_VBAT_L, &vl) == ESP_OK) {
        out->voltage_mv = ((int)(vh & 0x3F) << 8) | vl; /* 单位 mV */
    }
    return ESP_OK;
}
