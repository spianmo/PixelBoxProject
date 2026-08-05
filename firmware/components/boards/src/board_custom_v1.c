/**
 * board_custom_v1.c — PixelBox 定制 PCB v1 (Stage B) 板型实现
 *
 * 基于微雪 AMOLED-1.8 方案的定制板: 引脚全部走 Kconfig (打板后按原理图填写)。
 * 可选外设 (摄像头/GPS/灯带) 由 Kconfig 开关控制 capabilities,
 * 默认关闭 → 对应 px.* 域 available() 返回 false。
 */
#include "hal_common/board.h"

#include "sdkconfig.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "boards/axp2101.h"

static const char *TAG = "board";

static const board_display_config_t s_display = {
    .width = 368,
    .height = 448,
    .qspi_host = 1, /* SPI2_HOST */
    .pclk_hz = CONFIG_BOARD_CV1_LCD_PCLK_MHZ * 1000 * 1000,
    .pin_cs = CONFIG_BOARD_CV1_LCD_CS,
    .pin_sclk = CONFIG_BOARD_CV1_LCD_SCLK,
    .pin_d0 = CONFIG_BOARD_CV1_LCD_D0,
    .pin_d1 = CONFIG_BOARD_CV1_LCD_D1,
    .pin_d2 = CONFIG_BOARD_CV1_LCD_D2,
    .pin_d3 = CONFIG_BOARD_CV1_LCD_D3,
    .pin_reset = CONFIG_BOARD_CV1_LCD_RST,
    .pin_te = BOARD_PIN_NC,
};

static const board_audio_config_t s_audio = {
    .i2s_port = 0,
    .pin_mclk = CONFIG_BOARD_CV1_I2S_MCLK,
    .pin_bclk = CONFIG_BOARD_CV1_I2S_BCLK,
    .pin_ws = CONFIG_BOARD_CV1_I2S_WS,
    .pin_dout = CONFIG_BOARD_CV1_I2S_DOUT,
    .pin_din = CONFIG_BOARD_CV1_I2S_DIN,
    .pin_pa_enable = CONFIG_BOARD_CV1_PA_ENABLE,
    .es8311_addr = 0x18,
};

static const board_i2c_config_t s_i2c = {
    .port = 0,
    .pin_sda = CONFIG_BOARD_CV1_I2C_SDA,
    .pin_scl = CONFIG_BOARD_CV1_I2C_SCL,
    .freq_hz = CONFIG_BOARD_CV1_I2C_FREQ_KHZ * 1000,
};

static const board_touch_config_t s_touch = {
    .i2c_addr = 0x38,
    .pin_int = CONFIG_BOARD_CV1_TP_INT,
    .pin_reset = BOARD_PIN_NC,
};

static const board_imu_config_t s_imu = {
    .i2c_addr = 0x6B,
    .pin_int1 = BOARD_PIN_NC,
    .pin_int2 = BOARD_PIN_NC,
};

static const board_rtc_config_t s_rtc = {
    .i2c_addr = 0x51,
};

static const board_button_config_t s_button = {
    .pin_boot = CONFIG_BOARD_CV1_BOOT_GPIO,
};

static const board_caps_t s_caps = {
#ifdef CONFIG_BOARD_CV1_HAS_CAMERA
    .camera = true,
#else
    .camera = false,
#endif
#ifdef CONFIG_BOARD_CV1_HAS_GPS
    .gps = true,
#else
    .gps = false,
#endif
    .ble = true,
#ifdef CONFIG_BOARD_CV1_HAS_LED
    .led = true,
#else
    .led = false,
#endif
    .imu = true,
    .touch = true,
#ifdef CONFIG_BOARD_CV1_HAS_AXP2101
    .battery = true,
#else
    .battery = false,
#endif
    .mic = true,
    .speaker = true,
};

static i2c_master_bus_handle_t s_i2c_bus;
static SemaphoreHandle_t s_i2c_mutex;
static bool s_inited;

esp_err_t board_init(void)
{
    if (s_inited) {
        return ESP_OK;
    }
    s_i2c_mutex = xSemaphoreCreateRecursiveMutex();
    if (!s_i2c_mutex) {
        return ESP_ERR_NO_MEM;
    }

    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = s_i2c.port,
        .sda_io_num = s_i2c.pin_sda,
        .scl_io_num = s_i2c.pin_scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s_i2c_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "I2C 总线初始化失败: %s", esp_err_to_name(err));
        return err;
    }

#ifdef CONFIG_BOARD_CV1_HAS_AXP2101
    if (axp2101_init(s_i2c_bus, AXP2101_I2C_ADDR_DEFAULT) != ESP_OK) {
        ESP_LOGW(TAG, "AXP2101 不可用, 电池状态将返回 -1");
    }
#endif

    s_inited = true;
    ESP_LOGI(TAG, "板级初始化完成: %s", board_model());
    return ESP_OK;
}

const char *board_model(void)
{
    return "pixelbox-custom-v1";
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
    if (!axp2101_available()) {
        return ESP_OK;
    }
    esp_err_t err = board_i2c_lock(200);
    if (err != ESP_OK) {
        return err;
    }
    err = axp2101_read_battery(out);
    board_i2c_unlock();
    return err;
}

board_i2c_bus_handle_t board_i2c_bus(void)
{
    return s_i2c_bus;
}

esp_err_t board_i2c_lock(uint32_t timeout_ms)
{
    if (!s_i2c_mutex) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTakeRecursive(s_i2c_mutex, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

void board_i2c_unlock(void)
{
    if (s_i2c_mutex) {
        xSemaphoreGiveRecursive(s_i2c_mutex);
    }
}
