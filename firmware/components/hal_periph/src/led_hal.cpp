/**
 * led_hal.cpp — WS2812 灯带实现
 */
#include "hal_periph/led_hal.hpp"

#include <cstring>
#include <mutex>

#include "esp_log.h"
#include "hal_common/board.h"
#include "sdkconfig.h"

#if CONFIG_PX_ENABLE_LED
#include "led_strip.h"
#endif

static const char* TAG = "px.led";

namespace hal_periph {

#if CONFIG_PX_ENABLE_LED

namespace {

led_strip_handle_t s_strip = nullptr;
std::mutex s_mtx;
uint32_t s_colors[CONFIG_PX_LED_COUNT] = {};
int s_brightness = 100;

/** 惰性创建 RMT 通道 + 灯带句柄 */
bool ensure_strip() {
    if (s_strip != nullptr) return true;

    led_strip_config_t strip_cfg = {};
    strip_cfg.strip_gpio_num = CONFIG_PX_LED_GPIO;
    strip_cfg.max_leds = CONFIG_PX_LED_COUNT;
    strip_cfg.led_model = LED_MODEL_WS2812;
    strip_cfg.color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB;
    strip_cfg.flags.invert_out = false;

    led_strip_rmt_config_t rmt_cfg = {};
    rmt_cfg.clk_src = RMT_CLK_SRC_DEFAULT;
    rmt_cfg.resolution_hz = 10 * 1000 * 1000;  // 10MHz, WS2812 时序足够
    rmt_cfg.flags.with_dma = false;

    esp_err_t err = led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "创建灯带失败: %s", esp_err_to_name(err));
        s_strip = nullptr;
        return false;
    }
    return true;
}

}  // namespace

// 运行期可用性 = 编译开关 AND 板级能力位
bool led_available() { return board_caps()->led; }
int led_count() { return led_available() ? CONFIG_PX_LED_COUNT : 0; }

void led_set_brightness(int percent) {
    std::lock_guard<std::mutex> lk(s_mtx);
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    s_brightness = percent;
}

int led_get_brightness() {
    std::lock_guard<std::mutex> lk(s_mtx);
    return s_brightness;
}

esp_err_t led_set(int index, uint32_t rgb) {
    std::lock_guard<std::mutex> lk(s_mtx);
    if (index < 0 || index >= CONFIG_PX_LED_COUNT) return ESP_ERR_INVALID_ARG;
    s_colors[index] = rgb & 0xFFFFFF;
    return ESP_OK;
}

esp_err_t led_fill(uint32_t rgb) {
    std::lock_guard<std::mutex> lk(s_mtx);
    for (auto& c : s_colors) c = rgb & 0xFFFFFF;
    return ESP_OK;
}

esp_err_t led_clear() { return led_fill(0x000000); }

esp_err_t led_show() {
    std::lock_guard<std::mutex> lk(s_mtx);
    if (!ensure_strip()) return ESP_FAIL;
    for (int i = 0; i < CONFIG_PX_LED_COUNT; i++) {
        uint32_t c = s_colors[i];
        uint32_t r = ((c >> 16) & 0xFF) * static_cast<uint32_t>(s_brightness) / 100;
        uint32_t g = ((c >> 8) & 0xFF) * static_cast<uint32_t>(s_brightness) / 100;
        uint32_t b = (c & 0xFF) * static_cast<uint32_t>(s_brightness) / 100;
        led_strip_set_pixel(s_strip, static_cast<uint32_t>(i), r, g, b);
    }
    return led_strip_refresh(s_strip);
}

#else  // !CONFIG_PX_ENABLE_LED —— 桩实现

bool led_available() { return false; }
int led_count() { return 0; }
void led_set_brightness(int) {}
int led_get_brightness() { return 0; }
esp_err_t led_set(int, uint32_t) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t led_fill(uint32_t) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t led_clear() { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t led_show() { return ESP_ERR_NOT_SUPPORTED; }

#endif  // CONFIG_PX_ENABLE_LED

}  // namespace hal_periph
