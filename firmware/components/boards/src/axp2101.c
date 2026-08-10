/* AXP2101 PMU 最小 I2C 驱动 */
#include "boards/axp2101.h"

#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "axp2101";

/* 寄存器定义 (对齐 XPowersLib) */
#define REG_STATUS1        0x00 /* bit3: 电池在位 */
#define REG_STATUS2        0x01 /* bit[6:5]: 00 待机 01 充电 10 放电 */
#define REG_CHIP_ID        0x03
#define REG_ADC_CH_CTRL    0x30 /* bit0: VBAT ADC 使能; bit1: TS ADC */
#define REG_VBAT_H         0x34 /* VBAT 高 6 位 */
#define REG_VBAT_L         0x35 /* VBAT 低 8 位, 合并后单位 mV */
#define REG_PRECHG_CUR     0x61 /* bit[1:0]: 预充电流, 2=50mA */
#define REG_CC_CUR         0x62 /* bit[4:0]: 恒流充电, 0x0A=400mA */
#define REG_TERM_CUR       0x63 /* bit[3:0]: 截止电流, 1=25mA */
#define REG_CHG_VOLT       0x64 /* bit[2:0]: 截止电压, 3=4.2V */
#define REG_FUEL_GAUGE     0x68 /* bit0: 电池检测使能 */
#define REG_BAT_PERCENT    0xA4 /* 电量百分比 0-100 */
#define REG_INTEN1         0x40 /* IRQ 使能组 1 */
#define REG_INTEN2         0x41 /* IRQ 使能组 2: bit3 PKEY 短按, bit2 PKEY 长按 */
#define REG_INTEN3         0x42 /* IRQ 使能组 3 */
#define REG_INTSTS1        0x48 /* IRQ 状态组 1 (写 1 清除) */
#define REG_INTSTS2        0x49 /* IRQ 状态组 2: bit3 PKEY 短按, bit2 PKEY 长按 */
#define REG_INTSTS3        0x4A /* IRQ 状态组 3 */

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

static esp_err_t reg_update(uint8_t reg, uint8_t mask, uint8_t val)
{
    uint8_t v = 0;
    esp_err_t err = reg_read(reg, &v);
    if (err != ESP_OK) {
        return err;
    }
    return reg_write(reg, (v & ~mask) | (val & mask));
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

    /* 充电参数对齐官方 demo (port_axp2101.cpp): 预充 50mA / 恒流 400mA /
     * 截止 25mA / 4.2V; 并关 TS 通道 ADC (板载 TS 无温感配套软件路径,
     * 官方注释: 不关会充电异常) */
    reg_update(REG_PRECHG_CUR, 0x03, 2);
    reg_update(REG_CC_CUR, 0x1F, 0x0A);
    reg_update(REG_TERM_CUR, 0x0F, 1);
    reg_update(REG_CHG_VOLT, 0x07, 3);
    reg_update(REG_ADC_CH_CTRL, 0x02, 0);

    /* PKEY 短按/长按 IRQ (官方 demo 同款: 全关 → 清标志 → 仅开 PKEY 两位;
     * IRQ 引脚未连 ESP32, 事件经 axp2101_poll_pkey 轮询 INTSTS2 读取) */
    reg_write(REG_INTEN1, 0x00);
    reg_write(REG_INTEN2, 0x0C);
    reg_write(REG_INTEN3, 0x00);
    reg_write(REG_INTSTS1, 0xFF);
    reg_write(REG_INTSTS2, 0xFF);
    reg_write(REG_INTSTS3, 0xFF);

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

esp_err_t axp2101_poll_pkey(bool *short_press, bool *long_press)
{
    if (short_press) {
        *short_press = false;
    }
    if (long_press) {
        *long_press = false;
    }
    if (!s_dev) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t sts = 0;
    esp_err_t err = reg_read(REG_INTSTS2, &sts);
    if (err != ESP_OK) {
        return err;
    }
    if (sts == 0) {
        return ESP_OK;
    }
    if (short_press) {
        *short_press = (sts >> 3) & 1u;
    }
    if (long_press) {
        *long_press = (sts >> 2) & 1u;
    }
    return reg_write(REG_INTSTS2, sts); /* 写 1 清除已读事件 */
}
