/**
 * button_input.cpp — 板载按键实现(espressif/button v4 API)
 *
 * Boot/User: 常规低有效 GPIO 键。
 * Power: 电源键状态经电平转换到感知脚 (2.16 板 SYS_OUT=GPIO16),
 *        电路极性不确定 → 上电按"当前未按下"自检空闲电平, 反相为按下。
 */
#include "hal_periph/button_input.hpp"

#include <mutex>
#include <vector>

#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "hal_common/board.h"
#include "iot_button.h"
#include "button_gpio.h"

static const char* TAG = "px.btn";

namespace hal_periph {

namespace {

button_handle_t s_handles[3] = {nullptr, nullptr, nullptr};
std::vector<std::function<void(ButtonKey, ButtonEventType)>> s_cbs;
std::mutex s_cb_mtx;

void on_btn_event(void* /*btn_handle*/, void* usr_data) {
    const auto packed = reinterpret_cast<uintptr_t>(usr_data);
    button_emit(static_cast<ButtonKey>(packed >> 8), static_cast<ButtonEventType>(packed & 0xFF));
}

/** 注册一个 GPIO 键; active_level: 按下时的电平 */
esp_err_t add_key(ButtonKey key, int pin, int active_level, bool keep_pull = false) {
    button_config_t btn_cfg = {};
    btn_cfg.long_press_time = 1200;  // 长按判定 1.2s (息屏/关机等系统动作)
    btn_cfg.short_press_time = 180;  // 连击间隔窗口

    button_gpio_config_t gpio_cfg = {};
    gpio_cfg.gpio_num = pin;
    gpio_cfg.active_level = active_level;
    // keep_pull: 保留调用方已配置的上/下拉 (iot_button 默认按 active_level
    // 自动配拉向, 对开漏感知脚会把浮空节点钉死在空闲电平)
    gpio_cfg.disable_pull = keep_pull;

    button_handle_t h = nullptr;
    esp_err_t err = iot_button_new_gpio_device(&btn_cfg, &gpio_cfg, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "创建按键失败 (key=%d pin=%d): %s", static_cast<int>(key), pin,
                 esp_err_to_name(err));
        return err;
    }
    s_handles[static_cast<int>(key)] = h;

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
        const uintptr_t packed = (static_cast<uintptr_t>(key) << 8) | static_cast<uintptr_t>(m.type);
        iot_button_register_cb(h, m.ev, nullptr, on_btn_event, reinterpret_cast<void*>(packed));
    }
    ESP_LOGI(TAG, "按键就绪: key=%d pin=%d active=%d", static_cast<int>(key), pin, active_level);
    return ESP_OK;
}

}  // namespace

void button_emit(ButtonKey key, ButtonEventType type) {
    std::vector<std::function<void(ButtonKey, ButtonEventType)>> cbs;
    {
        std::lock_guard<std::mutex> lk(s_cb_mtx);
        cbs = s_cbs;
    }
    for (auto& cb : cbs) {
        if (cb) cb(key, type);
    }
}

esp_err_t button_init() {
    if (s_handles[0] || s_handles[1] || s_handles[2]) return ESP_OK;

    const board_button_config_t* cfg = board_button_config();
    bool any = false;

    if (cfg->pin_boot >= 0) {
        any |= add_key(ButtonKey::Boot, cfg->pin_boot, 0) == ESP_OK;
    }
    if (cfg->pin_user >= 0) {
        any |= add_key(ButtonKey::User, cfg->pin_user, 0) == ESP_OK;
    }
    if (cfg->pin_pwr_sense >= 0) {
        // SYS_OUT 是 BSS138 开漏输出: 板上上拉可能未贴 (2.16 真机实测悬空),
        // 统一启用内部上拉 —— 空闲时 FET 导通强拉 0, 按下时 FET 截止读 1
        gpio_config_t io = {};
        io.pin_bit_mask = 1ULL << cfg->pin_pwr_sense;
        io.mode = GPIO_MODE_INPUT;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        gpio_config(&io);
        vTaskDelay(pdMS_TO_TICKS(2));  // 上拉建立
        const int idle = gpio_get_level(static_cast<gpio_num_t>(cfg->pin_pwr_sense));
        any |= add_key(ButtonKey::Power, cfg->pin_pwr_sense, idle ? 0 : 1,
                       /*keep_pull=*/true) == ESP_OK;
    }

    return any ? ESP_OK : ESP_ERR_NOT_SUPPORTED;
}

void button_add_callback(std::function<void(ButtonKey, ButtonEventType)> cb) {
    if (!cb) return;
    std::lock_guard<std::mutex> lk(s_cb_mtx);
    s_cbs.push_back(std::move(cb));
}

}  // namespace hal_periph
