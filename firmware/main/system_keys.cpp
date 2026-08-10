/**
 * system_keys.cpp — 三键系统动作 (2.16 板, 键序 = 外壳物理顺序, 真机实测)
 *
 *   键1 Boot  (GPIO0)      短按 → 打开内置设置页
 *   键2 PWR   (PMU 轮询)   短按 → 返回应用页 (退出设置页/重载应用)
 *   键3 User  (GPIO18)     短按 → 息屏/亮屏切换
 *                          长按 1.2s → 屏显关机提示 → 深度睡眠 (再按键3 开机)
 *
 * 键2 事实依据: 真机实测 SYS_OUT(GPIO16) 感知线路不可用 (加内部上拉后电平
 * 仍恒 0, 疑上拉/FET 未按原理图贴装), PWR 键事件唯一可靠来源是 AXP2101 的
 * PKEY IRQ 状态寄存器 —— 200ms 轮询 (官方 demo 同款思路, IRQ 脚未连 ESP32)。
 * 屏幕/面板操作一律投递到 JS 线程执行 (帧缓冲与 QSPI IO 归 JS 线程所有);
 * 深睡由 GPIO18 低电平唤醒 (板载 10K 上拉深睡期间维持)。
 * 兜底: 长按 PWR 键 6 秒触发 AXP2101 硬件断电 (芯片默认行为, 无需软件参与)。
 */
#include "system_keys.h"

#include "boards/axp2101.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "appmgr/appmgr.h"
#include "hal_common/board.h"
#include "hal_display/gfx.hpp"
#include "hal_display/hal_display.hpp"
#include "hal_display/fonts.h"
#include "hal_periph/button_input.hpp"
#include "jsvm/jsvm.hpp"

static const char *TAG = "syskeys";

namespace {

/** 关机流程 (JS 线程执行): 提示 → 熄屏 → 深睡, 键③ 低电平唤醒 */
void shutdown_sequence()
{
    ESP_LOGI(TAG, "长按键③: 关机");
    if (hal_display::ready()) {
        auto &fb = hal_display::framebuffer();
        gfx::clear(fb, gfx::to565(0x000000));
        gfx::TextStyle st;
        st.font = pxfonts_get(PXFONT_PIXEL16);
        st.c565 = gfx::to565(0xFFFFFF);
        st.scale = hal_display::width() >= 480 ? 3 : 2;
        st.align = gfx::Align::Center;
        gfx::draw_text(fb, "正在关机", hal_display::width() / 2,
                       hal_display::height() / 2 - 8 * st.scale, st);
        gfx::TextStyle hint = st;
        hint.scale = st.scale > 1 ? st.scale - 1 : 1;
        hint.c565 = gfx::to565(0x8899AA);
        gfx::draw_text(fb, "按键3 开机", hal_display::width() / 2,
                       hal_display::height() / 2 + 10 * st.scale, hint);
        hal_display::mark_dirty(0, 0, hal_display::width(), hal_display::height());
        hal_display::flush();
        vTaskDelay(pdMS_TO_TICKS(1500));
        hal_display::set_power(false);  // AMOLED sleep-in, 深睡期间不残留画面
    }

    // 唤醒源 = 键3 (GPIO18, 板载 10K 上拉低有效, 上拉深睡期间维持)
    const int wake_pin = board_button_config()->pin_user;
    if (wake_pin >= 0) {
        esp_sleep_enable_ext1_wakeup(1ULL << wake_pin, ESP_EXT1_WAKEUP_ANY_LOW);
    }
    ESP_LOGI(TAG, "进入深度睡眠");
    esp_deep_sleep_start();
}

void on_key(hal_periph::ButtonKey key, hal_periph::ButtonEventType ev)
{
    using hal_periph::ButtonEventType;
    using hal_periph::ButtonKey;

    if (key == ButtonKey::Boot && ev == ButtonEventType::Click) {
        ESP_LOGI(TAG, "键1(BOOT): 打开设置页");
        appmgr_open_settings();
        return;
    }
    if (key == ButtonKey::User && ev == ButtonEventType::Click) {
        // 息屏/亮屏切换 (面板操作投递 JS 线程)
        jsvm::post([] {
            if (!hal_display::ready()) return;
            const bool on = !hal_display::get_power();
            ESP_LOGI(TAG, "键3: %s", on ? "亮屏" : "息屏");
            hal_display::set_power(on);
        });
        return;
    }
    if (key == ButtonKey::User && ev == ButtonEventType::LongPress) {
        jsvm::post([] { shutdown_sequence(); });
        return;
    }
    // ButtonKey::Power (GPIO16 感知) 在 2.16 真机上不可用, PWR 走 PMU 轮询;
    // 若未来板型感知可用, 这里同样把它当"键2"处理
    if (key == ButtonKey::Power && ev == ButtonEventType::Click) {
        if (appmgr_in_settings()) {
            appmgr_close_settings();
        }
        return;
    }
}

/** 键2 (PWR): AXP2101 PKEY 事件 200ms 轮询任务 */
void pkey_poll_task(void *)
{
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(200));
        if (!axp2101_available()) continue;
        bool sp = false, lp = false;
        if (board_i2c_lock(100) != ESP_OK) continue;
        const esp_err_t err = axp2101_poll_pkey(&sp, &lp);
        board_i2c_unlock();
        if (err != ESP_OK) continue;
        if (lp) {
            // 键2 长按 (~2s, PMU IRQ 默认时长): 清空推送应用, 回欢迎页。
            // 注意别按满 6 秒 —— 那是 PMU 硬断电兜底。
            ESP_LOGI(TAG, "键2(PWR) 长按: 清空应用, 回欢迎页");
            appmgr_uninstall_app();
        } else if (sp) {
            if (appmgr_in_settings()) {
                ESP_LOGI(TAG, "键2(PWR): 退出设置页, 返回应用");
                appmgr_close_settings();
            } else {
                ESP_LOGI(TAG, "键2(PWR): 已在应用页");
            }
        }
    }
}

}  // namespace

void system_keys_init(void)
{
    hal_periph::button_add_callback(on_key);
    xTaskCreate(pkey_poll_task, "px_pkey", 3072, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "系统按键动作已注册 (键1 设置 / 键2 应用 / 键3 息屏·关机)");
}
