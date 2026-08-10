/**
 * board_headless.c — 无屏调试板型 (BOARD_HEADLESS)
 *
 * 面向 ESP32-P4 / ESP32-C6 等裸开发板的最小板型:
 *   - 无屏 (hal_display 编译 stub 后端, px.screen 全部抛 ENOTSUP,
 *     system.info().screen = 0x0);
 *   - 无 I2C/触摸/IMU/PMU/codec, 能力位全 false (BLE 视 NimBLE 配置);
 *   - 仅保留 BOOT 按键 (px.input.onButton 可用)。
 *
 * 用途: P4/C6 上跑通 JS 运行时 / 存储 / OTA 等非可视链路的编译与调试。
 */
#include "hal_common/board.h"

#include "sdkconfig.h"
#include "esp_log.h"

static const char *TAG = "board";

/* ------------------------------------------------------------
 * 静态配置 (全部"无")
 * ------------------------------------------------------------ */

static const board_display_config_t s_display = {
    .width = 0, /* 无屏; hal_display stub 后端不读取本配置 */
    .height = 0,
    .qspi_host = 1,
    .pclk_hz = 0,
    .pin_cs = BOARD_PIN_NC,
    .pin_sclk = BOARD_PIN_NC,
    .pin_d0 = BOARD_PIN_NC,
    .pin_d1 = BOARD_PIN_NC,
    .pin_d2 = BOARD_PIN_NC,
    .pin_d3 = BOARD_PIN_NC,
    .pin_reset = BOARD_PIN_NC,
    .pin_te = BOARD_PIN_NC,
    .pin_dc = BOARD_PIN_NC,
    .pin_backlight = BOARD_PIN_NC,
};

static const board_audio_config_t s_audio = {
    .i2s_port = 0,
    .pin_mclk = BOARD_PIN_NC,
    .pin_bclk = BOARD_PIN_NC,
    .pin_ws = BOARD_PIN_NC,
    .pin_dout = BOARD_PIN_NC,
    .pin_din = BOARD_PIN_NC,
    .pin_pa_enable = BOARD_PIN_NC,
    .es8311_addr = 0,
};

static const board_i2c_config_t s_i2c = {
    .port = 0,
    .pin_sda = BOARD_PIN_NC,
    .pin_scl = BOARD_PIN_NC,
    .freq_hz = 0,
};

static const board_touch_config_t s_touch = {
    .i2c_addr = 0,
    .pin_int = BOARD_PIN_NC,
    .pin_reset = BOARD_PIN_NC,
};

static const board_imu_config_t s_imu = {
    .i2c_addr = 0,
    .pin_int1 = BOARD_PIN_NC,
    .pin_int2 = BOARD_PIN_NC,
};

static const board_rtc_config_t s_rtc = {
    .i2c_addr = 0,
};

static const board_button_config_t s_button = {
    .pin_boot = CONFIG_BOARD_HEADLESS_BOOT_GPIO,
    .pin_user = -1,
    .pin_pwr_sense = -1,
};

/* 能力位如实全 false; BLE 取决于芯片/配置 (C6 可用, P4 无片上蓝牙) */
static const board_caps_t s_caps = {
    .camera = false,
    .gps = false,
#if CONFIG_BT_NIMBLE_ENABLED
    .ble = true,
#else
    .ble = false,
#endif
    .led = false,
    .imu = false,
    .touch = false,
    .battery = false,
    .mic = false,
    .speaker = false,
};

static bool s_inited;

/* ------------------------------------------------------------
 * 接口实现
 * ------------------------------------------------------------ */

esp_err_t board_init(void)
{
    if (s_inited) {
        return ESP_OK;
    }
    s_inited = true;
    ESP_LOGI(TAG, "板级初始化完成: %s (%s, 无屏调试板)", board_model(), CONFIG_IDF_TARGET);
    return ESP_OK;
}

const char *board_model(void)
{
    return "pixelbox-headless";
}

const board_display_config_t *board_display_config(void) { return &s_display; }
const board_audio_config_t *board_audio_config(void)     { return &s_audio; }
const board_i2c_config_t *board_i2c_config(void)         { return &s_i2c; }
const board_touch_config_t *board_touch_config(void)     { return &s_touch; }
const board_imu_config_t *board_imu_config(void)         { return &s_imu; }
const board_rtc_config_t *board_rtc_config(void)         { return &s_rtc; }
const board_button_config_t *board_button_config(void)   { return &s_button; }
const board_caps_t *board_caps(void)                     { return &s_caps; }

esp_err_t board_battery(board_battery_info_t *out)
{
    if (!out) {
        return ESP_ERR_INVALID_ARG;
    }
    out->level = -1;
    out->charging = false;
    out->voltage_mv = 0;
    return ESP_OK;
}

board_i2c_bus_handle_t board_i2c_bus(void)
{
    return NULL; /* 本板无 I2C 总线 */
}

esp_err_t board_i2c_lock(uint32_t timeout_ms)
{
    (void)timeout_ms;
    return ESP_ERR_INVALID_STATE;
}

void board_i2c_unlock(void)
{
}
