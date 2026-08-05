/**
 * button_input.cpp — BOOT 按键实现(espressif/button v4 API)
 */
#include "hal_periph/button_input.hpp"

#include <mutex>

#include "esp_log.h"
#include "hal_common/board.h"
#include "iot_button.h"
#include "button_gpio.h"

static const char* TAG = "px.btn";

namespace hal_periph {

namespace {

button_handle_t s_btn = nullptr;
std::function<void(ButtonEventType)> s_cb;
std::mutex s_cb_mtx;

void emit(ButtonEventType t) {
    std::function<void(ButtonEventType)> cb;
    {
        std::lock_guard<std::mutex> lk(s_cb_mtx);
        cb = s_cb;
    }
    if (cb) cb(t);
}

void on_btn_event(void* /*btn_handle*/, void* usr_data) {
    emit(static_cast<ButtonEventType>(reinterpret_cast<uintptr_t>(usr_data)));
}

}  // namespace

esp_err_t button_init() {
    if (s_btn != nullptr) return ESP_OK;

    // 引脚来自 boards;-1 表示该板无 BOOT 键
    int pin = board_button_config()->pin_boot;
    if (pin < 0) return ESP_ERR_NOT_SUPPORTED;

    button_config_t btn_cfg = {};
    btn_cfg.long_press_time = 1000;  // 长按判定 1s
    btn_cfg.short_press_time = 180;  // 连击间隔窗口

    button_gpio_config_t gpio_cfg = {};
    gpio_cfg.gpio_num = pin;
    gpio_cfg.active_level = 0;  // BOOT 键按下为低

    esp_err_t err = iot_button_new_gpio_device(&btn_cfg, &gpio_cfg, &s_btn);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "创建 BOOT 按键失败: %s", esp_err_to_name(err));
        return err;
    }

    struct EvMap {
        button_event_t ev;
        ButtonEventType type;
    };
    static constexpr EvMap kMap[] = {
        {BUTTON_PRESS_DOWN, ButtonEventType::Down},
        {BUTTON_PRESS_UP, ButtonEventType::Up},
        {BUTTON_SINGLE_CLICK, ButtonEventType::Click},
        {BUTTON_DOUBLE_CLICK, ButtonEventType::DoubleClick},
        {BUTTON_LONG_PRESS_START, ButtonEventType::LongPress},
    };
    for (const auto& m : kMap) {
        iot_button_register_cb(s_btn, m.ev, nullptr, on_btn_event,
                               reinterpret_cast<void*>(static_cast<uintptr_t>(m.type)));
    }
    return ESP_OK;
}

void button_set_callback(std::function<void(ButtonEventType)> cb) {
    std::lock_guard<std::mutex> lk(s_cb_mtx);
    s_cb = std::move(cb);
}

}  // namespace hal_periph
