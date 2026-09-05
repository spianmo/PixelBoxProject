/**
 * errscreen.cpp — 应用异常屏幕提示的编排 (见 errscreen.hpp)
 *
 * 绘制归 js_task: 帧缓冲与 QSPI IO 由它独占 (与 wifi_portal 同范式,
 * 一切经 jsvm::post() 投递)。
 *
 * 横幅期间应用仍在逐帧绘制, 只画一次会立刻被盖掉 —— 故走 hal_display 的
 * 覆盖层钩子: 每次 flush 前把预渲染好的横幅贴进帧缓冲, 推送完再把原像素写
 * 回去, 应用的帧缓冲内容不受破坏。
 *
 * 全屏卡片则相反: 应用已经停了, 没人再画, 直接画进帧缓冲 flush 一次即可,
 * 之后设置页/配网页/重启后的应用谁画谁覆盖, 天然让位。唯一的例外是"横幅升级"
 * 路径 —— jsvm::request_stop() 是异步的, 停机前可能还会漏出一两帧, 这段窗口
 * 里同样挂覆盖层压住 (不做 save/restore: 帧缓冲反正要被下一个应用重画),
 * 由 s_watch 定时器发现 VM 真的停了以后摘掉。
 */
#include "errscreen/errscreen.hpp"

#include <mutex>
#include <string>

#include "esp_log.h"
#include "esp_timer.h"

#include "errscreen/error_card.hpp"
#include "hal_display/fonts.h"
#include "hal_display/hal_display.hpp"
#include "jsvm/jsvm.hpp"

namespace errscreen {

namespace {

constexpr const char *TAG = "errscreen";

constexpr int64_t kBannerHoldUs = 5 * 1000 * 1000;   // 横幅停留时长
constexpr int64_t kBurstWindowUs = 3 * 1000 * 1000;  // 刷屏判定窗口
constexpr int kBurstLimit = 5;                       // 窗口内同一错误达此次数 → 升级
constexpr int64_t kWatchPeriodUs = 200 * 1000;       // 升级后查 VM 是否已停

enum class Mode { None, Banner, Fatal };

/* ---- 跨线程状态 (任意线程写, js_task 读) ---- */
std::mutex s_mtx;
Mode s_want = Mode::None;
std::string s_app, s_version, s_message, s_hint;
int s_repeat = 1;
/* 刷屏检测 */
std::string s_burst_key;
int64_t s_burst_start = 0;
int s_burst_count = 0;

/* ---- 仅 js_task 访问 (apply / 覆盖层回调) ---- */
Mode s_mode = Mode::None;
std::string s_draw_app, s_draw_version, s_draw_message, s_draw_hint;
int s_draw_repeat = 1;
gfx::Surface s_layer{};  // 预渲染的横幅内容
gfx::Surface s_save{};   // 横幅覆盖区域的原始像素
bool s_save_valid = false;

esp_timer_handle_t s_hide_timer = nullptr;   // 横幅 5s 自动消失
esp_timer_handle_t s_watch_timer = nullptr;  // 升级后等 VM 停机

bool fonts_ok(errscreen::Fonts &out)
{
    out.f12 = pxfonts_get(PXFONT_PIXEL12);
    out.f16 = pxfonts_get(PXFONT_PIXEL16);
    return out.f12 && out.f16;
}

CardInfo make_info()
{
    CardInfo info{};
    info.app = s_draw_app.empty() ? nullptr : s_draw_app.c_str();
    info.version = s_draw_version.empty() ? nullptr : s_draw_version.c_str();
    info.message = s_draw_message.c_str();
    info.hint = s_draw_hint.empty() ? nullptr : s_draw_hint.c_str();
    info.repeat = s_draw_repeat;
    return info;
}

void free_surfaces()
{
    gfx::destroy_surface(&s_layer);
    gfx::destroy_surface(&s_save);
    s_save_valid = false;
}

/* ------------------------------------------------------------
 * 覆盖层 (在 flush() 内、js_task 上同步调用)
 * ------------------------------------------------------------ */

void overlay_pre(gfx::Surface &fb, int w, int h)
{
    if (s_mode == Mode::Banner) {
        if (!s_layer.px) return;
        gfx::BlitOpts save_opts;
        save_opts.sw = s_layer.w;
        save_opts.sh = s_layer.h;
        if (s_save.px) {
            gfx::blit(s_save, fb, 0, 0, save_opts);  // 存下被盖住的像素
            s_save_valid = true;
        }
        gfx::blit(fb, s_layer, 0, 0, gfx::BlitOpts{});
        hal_display::mark_dirty(0, 0, s_layer.w, s_layer.h);
    } else if (s_mode == Mode::Fatal) {
        Fonts fonts;
        if (!fonts_ok(fonts)) return;
        render_fatal_card(fb, w, h, fonts, make_info());  // 不留 save: 帧缓冲随应用一起作废
        hal_display::mark_dirty(0, 0, w, h);
    }
}

void overlay_post(gfx::Surface &fb, int, int)
{
    if (!s_save_valid || !s_save.px) return;
    gfx::blit(fb, s_save, 0, 0, gfx::BlitOpts{});  // 还给应用
    s_save_valid = false;
}

const hal_display::Overlay kOverlay{overlay_pre, overlay_post};

/* ------------------------------------------------------------
 * js_task 上的实际动作
 * ------------------------------------------------------------ */

void stop_timers()
{
    if (s_hide_timer) esp_timer_stop(s_hide_timer);
    if (s_watch_timer) esp_timer_stop(s_watch_timer);
}

/** 撤下提示 (js_task) */
void apply_hide()
{
    if (s_mode == Mode::None) return;
    const Mode was = s_mode;
    s_mode = Mode::None;
    stop_timers();
    hal_display::set_overlay(nullptr);

    if (!hal_display::ready()) {
        free_surfaces();
        return;
    }
    gfx::Surface &fb = hal_display::framebuffer();
    if (was == Mode::Banner) {
        /* 帧缓冲里是应用自己的内容 (覆盖层每帧都还原过), 重推一次即可 */
        if (s_layer.px) hal_display::mark_dirty(0, 0, s_layer.w, s_layer.h);
    } else {
        /* 卡片是直接画进帧缓冲的: 清干净, 免得新应用只画局部时露出残影 */
        gfx::clear(fb, 0);
        hal_display::mark_dirty(0, 0, fb.w, fb.h);
    }
    hal_display::flush();
    free_surfaces();
}

/** 升级后轮询: VM 真的停了就摘掉覆盖层, 让卡片静态留在屏上 (js_task) */
void apply_watch()
{
    if (s_mode != Mode::Fatal) return;
    if (jsvm::vm_running()) return;  // 还在停机中, 下一拍再看
    if (s_watch_timer) esp_timer_stop(s_watch_timer);
    hal_display::set_overlay(nullptr);
    if (!hal_display::ready()) return;
    Fonts fonts;
    if (!fonts_ok(fonts)) return;
    gfx::Surface &fb = hal_display::framebuffer();
    render_fatal_card(fb, fb.w, fb.h, fonts, make_info());
    hal_display::mark_dirty(0, 0, fb.w, fb.h);
    hal_display::flush();
}

/** 取出待显示内容并画出来 (js_task) */
void apply_show()
{
    Mode want;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        want = s_want;
        s_draw_app = s_app;
        s_draw_version = s_version;
        s_draw_message = s_message;
        s_draw_hint = s_hint;
        s_draw_repeat = s_repeat;
    }
    if (want == Mode::None) {
        apply_hide();
        return;
    }
    if (!hal_display::ready()) {  // 无屏板型: 日志已经打过, 这里到此为止
        s_mode = want;
        return;
    }
    Fonts fonts;
    if (!fonts_ok(fonts)) {
        ESP_LOGE(TAG, "字体不可用, 无法显示错误提示");
        return;
    }

    gfx::Surface &fb = hal_display::framebuffer();
    stop_timers();

    if (want == Mode::Banner) {
        const int bh = banner_height(fb.w, fb.h);
        if (s_layer.w != fb.w || s_layer.h != bh) {
            free_surfaces();
            if (!gfx::create_surface(&s_layer, fb.w, bh)) {
                ESP_LOGE(TAG, "横幅缓冲分配失败 (%dx%d)", fb.w, bh);
                return;
            }
            if (!gfx::create_surface(&s_save, fb.w, bh)) {
                /* 没有 save 面板也能显示, 只是撤下时要等应用重画该区域 */
                ESP_LOGW(TAG, "横幅还原缓冲分配失败, 撤下后可能残留一帧");
            }
        }
        render_banner(s_layer, fb.w, fb.h, fonts, make_info());
        s_mode = Mode::Banner;
        hal_display::set_overlay(&kOverlay);
        hal_display::mark_dirty(0, 0, s_layer.w, s_layer.h);
        hal_display::flush();  // 立刻可见, 不必等应用下一帧
        if (s_hide_timer) esp_timer_start_once(s_hide_timer, kBannerHoldUs);
        return;
    }

    /* 全屏卡片 */
    free_surfaces();
    s_mode = Mode::Fatal;
    render_fatal_card(fb, fb.w, fb.h, fonts, make_info());
    hal_display::mark_dirty(0, 0, fb.w, fb.h);
    hal_display::flush();
    if (jsvm::vm_running()) {
        /* 停机前可能还有漏帧, 挂覆盖层压住, 停稳后由 apply_watch 摘掉 */
        hal_display::set_overlay(&kOverlay);
        if (s_watch_timer) esp_timer_start_periodic(s_watch_timer, kWatchPeriodUs);
    }
}

/* ------------------------------------------------------------
 * 定时器 (定时器任务上下文: 只投递, 不绘制)
 * ------------------------------------------------------------ */

void on_hide_timer(void *) { jsvm::post(apply_hide); }
void on_watch_timer(void *) { jsvm::post(apply_watch); }

std::once_flag s_timers_once;

/** 惰性建表 (首次报错时): 无错误的设备不占定时器槽位 */
void ensure_timers()
{
    std::call_once(s_timers_once, [] {
        const esp_timer_create_args_t hide = {on_hide_timer, nullptr, ESP_TIMER_TASK,
                                              "errscr_hide", true};
        const esp_timer_create_args_t watch = {on_watch_timer, nullptr, ESP_TIMER_TASK,
                                               "errscr_watch", true};
        esp_timer_create(&hide, &s_hide_timer);
        esp_timer_create(&watch, &s_watch_timer);
    });
}

/** message 首行 (刷屏判定按摘要, 堆栈行号可能因内联而抖动) */
std::string summary_of(const char *message)
{
    if (!message) return std::string();
    const char *nl = message;
    while (*nl && *nl != '\n') ++nl;
    return std::string(message, static_cast<size_t>(nl - message));
}

}  // namespace

void show_fatal(const char *app, const char *version, const char *message)
{
    ensure_timers();
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_want = Mode::Fatal;
        s_app = app ? app : "";
        s_version = version ? version : "";
        s_message = message ? message : "未知错误";
        s_hint.clear();
        s_repeat = 1;
        s_burst_key.clear();
        s_burst_count = 0;
    }
    jsvm::post(apply_show);
}

void report_error(const char *app, const char *version, const char *message)
{
    ensure_timers();
    bool escalate = false;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        if (s_want == Mode::Fatal) return;  // 已经是致命卡片, 不再降级

        const std::string key = summary_of(message);
        const int64_t now = esp_timer_get_time();
        if (key == s_burst_key && now - s_burst_start < kBurstWindowUs) {
            ++s_burst_count;
        } else {
            s_burst_key = key;
            s_burst_start = now;
            s_burst_count = 1;
        }

        s_app = app ? app : "";
        s_version = version ? version : "";
        s_message = message ? message : "未知错误";
        s_repeat = s_burst_count;
        escalate = s_burst_count >= kBurstLimit;
        if (escalate) {
            s_want = Mode::Fatal;
            s_hint = "同一错误反复发生, 应用已停止 · 键2 重启应用";
        } else {
            s_want = Mode::Banner;
            s_hint.clear();
        }
    }
    if (escalate) {
        ESP_LOGE(TAG, "同一异常 %d 秒内 %d 次, 停止应用并显示错误卡片",
                 (int)(kBurstWindowUs / 1000000), kBurstLimit);
        jsvm::request_stop();
    }
    jsvm::post(apply_show);
}

void hide()
{
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        if (s_want == Mode::None) return;
        s_want = Mode::None;
        s_burst_key.clear();
        s_burst_count = 0;
    }
    jsvm::post(apply_hide);
}

bool active()
{
    std::lock_guard<std::mutex> lk(s_mtx);
    return s_want != Mode::None;
}

}  // namespace errscreen
