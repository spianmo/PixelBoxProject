/**
 * board_generic_spi.c — 通用 SPI 屏板型 (BOARD_GENERIC_SPI)
 *
 * 面向多目标 (ESP32-C6 / ESP32-P4 / 其他) 的最小可视化板型:
 *   - 任意开发板 + 单线 SPI ST7789 TFT (默认 240x240, esp_lcd 内置驱动,
 *     hal_display 按本板型编译 st7789 行带 flush 后端);
 *   - 无触摸/IMU/PMU/codec/IO 扩展器, 能力位如实返回 false;
 *   - I2C 总线可选 (Kconfig BOARD_GSPI_HAS_I2C, 供外接传感器实验);
 *   - BLE 能力 = 芯片/配置是否编入 NimBLE (C6 可用, P4 无片上蓝牙)。
 *
 * 引脚全部走 Kconfig (boards/Kconfig), 默认值面向 ESP32-C6 DevKit。
 */
#include "hal_common/board.h"

#include "sdkconfig.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#if CONFIG_BOARD_GSPI_HAS_I2C
#include "driver/i2c_master.h"
#endif

static const char *TAG = "board";

/* ------------------------------------------------------------
 * 静态配置
 * ------------------------------------------------------------ */

static const board_display_config_t s_display = {
    .width = CONFIG_BOARD_GSPI_LCD_WIDTH,
    .height = CONFIG_BOARD_GSPI_LCD_HEIGHT,
    .qspi_host = 1, /* SPI2_HOST (各目标 GP-SPI 均从 SPI2 起) */
    .pclk_hz = CONFIG_BOARD_GSPI_LCD_PCLK_MHZ * 1000 * 1000,
    .pin_cs = CONFIG_BOARD_GSPI_LCD_CS,
    .pin_sclk = CONFIG_BOARD_GSPI_LCD_SCLK,
    .pin_d0 = CONFIG_BOARD_GSPI_LCD_MOSI, /* 单线 SPI: MOSI 复用 d0 */
    .pin_d1 = BOARD_PIN_NC,
    .pin_d2 = BOARD_PIN_NC,
    .pin_d3 = BOARD_PIN_NC,
    .pin_reset = CONFIG_BOARD_GSPI_LCD_RST,
    .pin_te = BOARD_PIN_NC,
    .pin_dc = CONFIG_BOARD_GSPI_LCD_DC,
    .pin_backlight = CONFIG_BOARD_GSPI_LCD_BACKLIGHT,
};

/* 无 codec: 引脚全 NC, hal_audio 因能力位 mic/speaker=false 不会初始化 */
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
#if CONFIG_BOARD_GSPI_HAS_I2C
    .pin_sda = CONFIG_BOARD_GSPI_I2C_SDA,
    .pin_scl = CONFIG_BOARD_GSPI_I2C_SCL,
    .freq_hz = CONFIG_BOARD_GSPI_I2C_FREQ_KHZ * 1000,
#else
    .pin_sda = BOARD_PIN_NC,
    .pin_scl = BOARD_PIN_NC,
    .freq_hz = 0,
#endif
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
    .pin_boot = CONFIG_BOARD_GSPI_BOOT_GPIO,
};

/* 能力位如实: 板上只有屏; BLE 取决于芯片/配置是否编入 NimBLE */
static const board_caps_t s_caps = {
    .camera = false,
    .gps = false,
#if CONFIG_BT_NIMBLE_ENABLED
    .ble = true,
#else
    .ble = false, /* P4 无片上蓝牙 / 未启用 NimBLE */
#endif
    .led = false,
    .imu = false,
    .touch = false,
    .battery = false,
    .mic = false,
    .speaker = false,
};

/* ------------------------------------------------------------
 * 运行状态
 * ------------------------------------------------------------ */

#if CONFIG_BOARD_GSPI_HAS_I2C
static i2c_master_bus_handle_t s_i2c_bus;
static SemaphoreHandle_t s_i2c_mutex;
#endif
static bool s_inited;

/* ------------------------------------------------------------
 * 接口实现
 * ------------------------------------------------------------ */

esp_err_t board_init(void)
{
    if (s_inited) {
        return ESP_OK;
    }

#if CONFIG_BOARD_GSPI_HAS_I2C
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
#endif

    s_inited = true;
    ESP_LOGI(TAG, "板级初始化完成: %s (%s)", board_model(), CONFIG_IDF_TARGET);
    return ESP_OK;
}

const char *board_model(void)
{
    return "pixelbox-generic-spi";
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
    /* 无 PMU/电池: 按契约返回 level=-1 */
    out->level = -1;
    out->charging = false;
    out->voltage_mv = 0;
    return ESP_OK;
}

board_i2c_bus_handle_t board_i2c_bus(void)
{
#if CONFIG_BOARD_GSPI_HAS_I2C
    return s_i2c_bus;
#else
    return NULL;
#endif
}

esp_err_t board_i2c_lock(uint32_t timeout_ms)
{
#if CONFIG_BOARD_GSPI_HAS_I2C
    if (!s_i2c_mutex) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTakeRecursive(s_i2c_mutex, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
#else
    (void)timeout_ms;
    return ESP_ERR_INVALID_STATE; /* 本板未启用 I2C */
#endif
}

void board_i2c_unlock(void)
{
#if CONFIG_BOARD_GSPI_HAS_I2C
    if (s_i2c_mutex) {
        xSemaphoreGiveRecursive(s_i2c_mutex);
    }
#endif
}
