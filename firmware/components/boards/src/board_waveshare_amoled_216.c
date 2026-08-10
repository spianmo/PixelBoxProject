/**
 * board_waveshare_amoled_216.c — 微雪 ESP32-S3-Touch-AMOLED-2.16 板型实现
 *
 * 硬件: ESP32-S3R8 (16MB Flash + 8MB Octal PSRAM)
 *   - 2.16" AMOLED 480x480, CO5300, QSPI (CS=12 SCLK=38 D0-3=4/5/6/7 RST=39)
 *   - CST9220 电容触摸 (I2C, INT=11, RST=40)
 *   - ES8311 codec + ES7210 拾音 ADC + NS4150B 功放 (I2S + I2C 0x18)
 *   - QMI8658 IMU (I2C 0x6B, INT1=17/INT2=21) + PCF85063 RTC (I2C 0x51, INT=13)
 *   - AXP2101 PMU (I2C 0x34): DCDC1 → 全板 VCC3V3 (含屏 VCI/VDDIO, 上电默认开)
 *
 * 与 1.8 板的关键差异: 无 TCA9554 IO 扩展器, LCD/TP 复位直连 GPIO;
 * 屏幕电源使能 DSI_PWR_EN 由 10K 上拉默认开启, 无需软件干预。
 * 引脚默认值取自官方 wiki 引脚表, 与原理图 (J4/KEYS/Codec 块) 逐一核对。
 */
#include "hal_common/board.h"

#include "sdkconfig.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "boards/axp2101.h"

static const char *TAG = "board";

/* ------------------------------------------------------------
 * 静态配置
 * ------------------------------------------------------------ */

static const board_display_config_t s_display = {
    .width = 480,
    .height = 480,
    .qspi_host = 1, /* SPI2_HOST */
    .pclk_hz = CONFIG_BOARD_WS216_LCD_PCLK_MHZ * 1000 * 1000,
    .pin_cs = CONFIG_BOARD_WS216_LCD_CS,
    .pin_sclk = CONFIG_BOARD_WS216_LCD_SCLK,
    .pin_d0 = CONFIG_BOARD_WS216_LCD_D0,
    .pin_d1 = CONFIG_BOARD_WS216_LCD_D1,
    .pin_d2 = CONFIG_BOARD_WS216_LCD_D2,
    .pin_d3 = CONFIG_BOARD_WS216_LCD_D3,
    .pin_reset = CONFIG_BOARD_WS216_LCD_RST, /* 直连 GPIO, esp_lcd 驱动内做复位脉冲 */
    .pin_te = BOARD_PIN_NC,
    .pin_dc = BOARD_PIN_NC,        /* QSPI 无 DC 线 */
    .pin_backlight = BOARD_PIN_NC, /* AMOLED 无背光, 亮度走面板命令 0x51 */
};

static const board_audio_config_t s_audio = {
    .i2s_port = 0,
    .pin_mclk = CONFIG_BOARD_WS216_I2S_MCLK,
    .pin_bclk = CONFIG_BOARD_WS216_I2S_BCLK,
    .pin_ws = CONFIG_BOARD_WS216_I2S_WS,
    .pin_dout = CONFIG_BOARD_WS216_I2S_DOUT,
    .pin_din = CONFIG_BOARD_WS216_I2S_DIN,
    .pin_pa_enable = CONFIG_BOARD_WS216_PA_ENABLE,
    .es8311_addr = 0x18,
    .es7210_addr = 0x40, /* 双 MEMS 麦克风经 ES7210 四通道 ADC 拾音 */
};

static const board_i2c_config_t s_i2c = {
    .port = 0,
    .pin_sda = CONFIG_BOARD_WS216_I2C_SDA,
    .pin_scl = CONFIG_BOARD_WS216_I2C_SCL,
    .freq_hz = CONFIG_BOARD_WS216_I2C_FREQ_KHZ * 1000,
};

static const board_touch_config_t s_touch = {
    .i2c_addr = CONFIG_BOARD_WS216_TP_ADDR, /* CST9220 */
    .pin_int = CONFIG_BOARD_WS216_TP_INT,
    .pin_reset = CONFIG_BOARD_WS216_TP_RST, /* 直连 GPIO, board_init 做复位脉冲 */
};

static const board_imu_config_t s_imu = {
    .i2c_addr = 0x6B, /* QMI8658 */
    .pin_int1 = 17,
    .pin_int2 = 21,
};

static const board_rtc_config_t s_rtc = {
    .i2c_addr = 0x51, /* PCF85063 */
};

static const board_button_config_t s_button = {
    .pin_boot = CONFIG_BOARD_WS216_BOOT_GPIO,
};

static const board_caps_t s_caps = {
    .camera = false,
    .gps = false,
    .ble = true,
    .led = false,
    .imu = true,
    .touch = true,
    .battery = true,
    .mic = true,
    .speaker = true,
};

/* ------------------------------------------------------------
 * 运行状态
 * ------------------------------------------------------------ */

static i2c_master_bus_handle_t s_i2c_bus;
static SemaphoreHandle_t s_i2c_mutex;
static bool s_inited;

/* ------------------------------------------------------------
 * 接口实现
 * ------------------------------------------------------------ */

esp_err_t board_init(void)
{
    if (s_inited) {
        return ESP_OK;
    }

    s_i2c_mutex = xSemaphoreCreateRecursiveMutex();
    if (!s_i2c_mutex) {
        return ESP_ERR_NO_MEM;
    }

    /* 1. 共享 I2C 总线 (新 i2c_master 驱动) */
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

    /* 2. 触摸复位脉冲 (CST9220 直连 GPIO40, 低 10ms 后拉高, 等 >=100ms 才可探测;
     *    LCD 复位 GPIO39 交给 esp_lcd 面板驱动, 此处不碰) */
    gpio_config_t tp_rst_cfg = {
        .pin_bit_mask = 1ULL << CONFIG_BOARD_WS216_TP_RST,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&tp_rst_cfg);
    gpio_set_level(CONFIG_BOARD_WS216_TP_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(CONFIG_BOARD_WS216_TP_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(120));

    /* 3. AXP2101 PMU: 电量计/ADC 使能 (DCDC1 主轨上电默认已开, 不额外改动) */
    if (axp2101_init(s_i2c_bus, AXP2101_I2C_ADDR_DEFAULT) != ESP_OK) {
        ESP_LOGW(TAG, "AXP2101 不可用, 电池状态将返回 -1");
    }

    s_inited = true;
    ESP_LOGI(TAG, "板级初始化完成: %s", board_model());
    return ESP_OK;
}

const char *board_model(void)
{
    return "pixelbox-s3-216";
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
        return ESP_OK; /* 无 PMU: 按"无电池"返回 */
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
