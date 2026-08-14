/**
 * system_keys.cpp — 三键系统动作 (2.16 板, 键序 = 外壳物理顺序, 真机实测)
 *
 *   键1 Boot  (GPIO0)      短按 → 打开内置设置页
 *   键2 PWR   (PMU 轮询)   短按 → 返回应用页 (退出设置页/重载应用/退出配网)
 *   键3 User  (GPIO18)     短按 → 息屏/亮屏切换
 *                          长按 1.2s → 屏显关机提示 → 深度睡眠 (再按键3 开机)
 *   键1 + 键3 同时按住 2s  → 网页配网模式 (SoftAP + 手机浏览器填表)
 *
 * 键2 事实依据: 真机实测 SYS_OUT(GPIO16) 感知线路不可用 (加内部上拉后电平
 * 仍恒 0, 疑上拉/FET 未按原理图贴装), PWR 键事件唯一可靠来源是 AXP2101 的
 * PKEY IRQ 状态寄存器 —— 200ms 轮询 (官方 demo 同款思路, IRQ 脚未连 ESP32)。
 * 该寄存器只报"短按/长按已发生", 读不到"当前是否按住", 所以键2 无法参与
 * 组合键 —— 组合键只能用键1 + 键3 (两者都是常规 GPIO 键, Down/Up 全程可知)。
 * 屏幕/面板操作一律投递到 JS 线程执行 (帧缓冲与 QSPI IO 归 JS 线程所有);
 * 深睡由 GPIO18 低电平唤醒 (板载 10K 上拉深睡期间维持)。
 * 兜底: 长按 PWR 键 6 秒触发 AXP2101 硬件断电 (芯片默认行为, 无需软件参与)。
 */
#include "system_keys.h"

#include <atomic>

#include "boards/axp2101.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "appmgr/appmgr.h"
#include "hal_common/board.h"
#include "hal_display/gfx.hpp"
#include "hal_display/hal_display.hpp"
#include "hal_display/fonts.h"
#include "hal_periph/button_input.hpp"
#include "jsvm/jsvm.hpp"
#include "wifi_portal/wifi_portal.hpp"

static const char *TAG = "syskeys";

namespace {

/* ---------------- 键1 + 键3 组合键 → 网页配网 ---------------- */

constexpr uint32_t COMBO_HOLD_MS = 2000;

/* 按键回调 (button 任务) 与组合键定时器回调 (esp_timer 任务) 都会读写这几个
 * 标志, 故用 atomic。 */
std::atomic<bool> s_boot_down{false};
std::atomic<bool> s_user_down{false};
/* 组合键已触发 → 抑制该键随后到达的 Click/LongPress。
 * 注意不在 Up 时清: iot_button 的 SINGLE_CLICK 在 PRESS_UP 之后才送到,
 * 那时清就漏抑制了 —— 改为该键下一次 Down 时清。 */
std::atomic<bool> s_suppress_boot{false};
std::atomic<bool> s_suppress_user{false};
esp_timer_handle_t s_combo_timer = nullptr;

void combo_timer_cb(void *)
{
    if (!s_boot_down.load() || !s_user_down.load()) return;  // 期间已松开
    s_suppress_boot.store(true);
    s_suppress_user.store(true);
    ESP_LOGI(TAG, "键1+键3 长按 2s: 进入网页配网");
    wifi_portal::start();
}

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

    /* ---- 组合键状态跟踪 (只有键1/键3 有可靠的 Down/Up) ---- */
    if (key == ButtonKey::Boot || key == ButtonKey::User) {
        const bool is_boot = (key == ButtonKey::Boot);
        std::atomic<bool> *down = is_boot ? &s_boot_down : &s_user_down;
        std::atomic<bool> *suppress = is_boot ? &s_suppress_boot : &s_suppress_user;

        if (ev == ButtonEventType::Down) {
            suppress->store(false);  // 新的一次按下, 上一轮抑制到此为止
            down->store(true);
            if (s_boot_down.load() && s_user_down.load() && s_combo_timer) {
                esp_timer_stop(s_combo_timer);
                esp_timer_start_once(s_combo_timer, (uint64_t)COMBO_HOLD_MS * 1000);
            }
            return;
        }
        if (ev == ButtonEventType::Up) {
            down->store(false);
            if (s_combo_timer) esp_timer_stop(s_combo_timer);  // 任一键松开即取消
            return;
        }
    }

    /* ---- 配网期间独占屏幕: 键1/键3 的单键动作一律忽略 ----
     * 开设置页会热重启 JS VM 跟配网页抢屏; 息屏会把热点密码藏起来。
     * 退出配网走键2; PMU 长按 6s 硬断电始终可用作兜底。 */
    if (wifi_portal::active()) return;

    /* 组合键进行中 (另一键按着) 或刚触发过 → 吞掉这次单键动作。
     * 尤其键3: 长按 1.2s 关机会抢在 2s 组合键之前, 必须在键1 按着时无条件忽略
     * —— 那是组合键进行中, 不是关机意图。 */
    const bool combo_boot = s_suppress_boot.load() || s_user_down.load();
    const bool combo_user = s_suppress_user.load() || s_boot_down.load();

    if (key == ButtonKey::Boot && ev == ButtonEventType::Click) {
        if (combo_boot) return;
        ESP_LOGI(TAG, "键1(BOOT): 打开设置页");
        appmgr_open_settings();
        return;
    }
    if (key == ButtonKey::User && combo_user &&
        (ev == ButtonEventType::Click || ev == ButtonEventType::LongPress)) {
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
        if (wifi_portal::active()) {
            // 配网期间键2 = 退出 (沿用"键2 返回应用"语义); 长按也只当退出,
            // 别顺手把应用清了
            if (sp || lp) {
                ESP_LOGI(TAG, "键2(PWR): 退出网页配网, 返回应用");
                wifi_portal::stop(/*restart_app=*/true);
            }
            continue;
        }
        if (lp) {
            // 键2 长按 (~2s, PMU IRQ 默认时长): 清空推送应用, 回欢迎页。
            // 注意别按满 6 秒 —— 那是 PMU 硬断电兜底。
            ESP_LOGI(TAG, "键2(PWR) 长按: 清空应用, 回欢迎页");
            appmgr_uninstall_app();
        } else if (sp) {
            // PMU 是 2.16 真机上键2的唯一可靠来源；统一分发后系统和当前应用都能收到。
            ESP_LOGI(TAG, "键2(PWR): 短按");
            hal_periph::button_emit(hal_periph::ButtonKey::Power,
                                    hal_periph::ButtonEventType::Click);
        }
    }
}

}  // namespace

void system_keys_init(void)
{
    esp_timer_create_args_t combo = {};
    combo.callback = combo_timer_cb;
    combo.arg = nullptr;
    combo.name = "px_combo";
    if (esp_timer_create(&combo, &s_combo_timer) != ESP_OK) {
        s_combo_timer = nullptr;  // 组合键退化为无操作, 单键动作不受影响
        ESP_LOGW(TAG, "组合键定时器创建失败, 网页配网手势不可用");
    }

    hal_periph::button_add_callback(on_key);
    xTaskCreate(pkey_poll_task, "px_pkey", 3072, nullptr, 4, nullptr);
    ESP_LOGI(TAG, "系统按键动作已注册 (键1 设置 / 键2 应用 / 键3 息屏·关机 / 键1+键3 配网)");
}
