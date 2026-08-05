/**
 * mod_input.cpp — px.input 绑定(触摸 / BOOT 按键 / swipe 手势合成)
 *
 * 事件链路:
 *   FT3168 轮询任务 ─┬→ touch 事件 → jsvm::Callback 投递 JS 线程
 *                    └→ 手势状态机(驱动任务内, 纯 C++)→ gesture 事件
 *   iot_button 任务 ──→ button 事件
 */
#include <cmath>
#include <cstdint>

#include "esp_log.h"
#include "esp_timer.h"

#include "hal_periph/button_input.hpp"
#include "hal_periph/touch_ft3168.hpp"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

static const char* TAG = "px.input";

namespace {

pxb::CallbackRegistry s_touch_reg;
pxb::CallbackRegistry s_button_reg;
pxb::CallbackRegistry s_gesture_reg;

// ---------------------------------------------------------------
// swipe 手势合成(在触摸驱动任务上下文运行, 无 JS 依赖)
// ---------------------------------------------------------------

constexpr int kSwipeMinDistance = 30;       // 最小滑动距离 px
constexpr int64_t kSwipeMaxUs = 800 * 1000; // 最长手势时间

struct GestureState {
    bool tracking = false;
    int down_x = 0, down_y = 0;
    int64_t down_us = 0;
};
GestureState s_gs;

/** 触摸序列 → 判定滑动方向与距离;命中返回 true */
bool gesture_feed(const hal_periph::TouchEvent& ev, const char*& dir, int& distance) {
    switch (ev.type) {
        case hal_periph::TouchEventType::Down:
            s_gs.tracking = true;
            s_gs.down_x = ev.x;
            s_gs.down_y = ev.y;
            s_gs.down_us = esp_timer_get_time();
            return false;
        case hal_periph::TouchEventType::Move:
            return false;
        case hal_periph::TouchEventType::Up: {
            if (!s_gs.tracking) return false;
            s_gs.tracking = false;
            if (esp_timer_get_time() - s_gs.down_us > kSwipeMaxUs) return false;
            int dx = static_cast<int>(ev.x) - s_gs.down_x;
            int dy = static_cast<int>(ev.y) - s_gs.down_y;
            int ax = std::abs(dx), ay = std::abs(dy);
            if (ax < kSwipeMinDistance && ay < kSwipeMinDistance) return false;
            if (ax >= ay) {
                dir = dx > 0 ? "right" : "left";
                distance = ax;
            } else {
                dir = dy > 0 ? "down" : "up";
                distance = ay;
            }
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------
// 事件投递
// ---------------------------------------------------------------

const char* touch_type_str(hal_periph::TouchEventType t) {
    switch (t) {
        case hal_periph::TouchEventType::Down: return "down";
        case hal_periph::TouchEventType::Move: return "move";
        case hal_periph::TouchEventType::Up: return "up";
    }
    return "up";
}

const char* button_type_str(hal_periph::ButtonEventType t) {
    switch (t) {
        case hal_periph::ButtonEventType::Down: return "down";
        case hal_periph::ButtonEventType::Up: return "up";
        case hal_periph::ButtonEventType::Click: return "click";
        case hal_periph::ButtonEventType::DoubleClick: return "doubleClick";
        case hal_periph::ButtonEventType::LongPress: return "longPress";
    }
    return "click";
}

/** 触摸驱动任务回调:分发 touch + 合成 gesture */
void on_hal_touch(const hal_periph::TouchEvent& ev) {
    if (s_touch_reg.active()) {
        const char* type = touch_type_str(ev.type);
        uint16_t x = ev.x, y = ev.y;
        s_touch_reg.invoke_all([type, x, y](JSContext* ctx, JSValue* argv) -> int {
            JSValue o = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, o, "type", JS_NewString(ctx, type));
            JS_SetPropertyStr(ctx, o, "x", JS_NewInt32(ctx, x));
            JS_SetPropertyStr(ctx, o, "y", JS_NewInt32(ctx, y));
            argv[0] = o;
            return 1;
        });
    }

    const char* dir = nullptr;
    int distance = 0;
    if (gesture_feed(ev, dir, distance) && s_gesture_reg.active()) {
        s_gesture_reg.invoke_all([dir, distance](JSContext* ctx, JSValue* argv) -> int {
            JSValue o = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, o, "dir", JS_NewString(ctx, dir));
            JS_SetPropertyStr(ctx, o, "distance", JS_NewInt32(ctx, distance));
            argv[0] = o;
            return 1;
        });
    }
}

/** 按键任务回调 */
void on_hal_button(hal_periph::ButtonEventType t) {
    if (!s_button_reg.active()) return;
    const char* type = button_type_str(t);
    s_button_reg.invoke_all([type](JSContext* ctx, JSValue* argv) -> int {
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "id", JS_NewString(ctx, "boot"));
        JS_SetPropertyStr(ctx, o, "type", JS_NewString(ctx, type));
        argv[0] = o;
        return 1;
    });
}

// ---------------------------------------------------------------
// JS 方法
// ---------------------------------------------------------------

JSValue subscribe(JSContext* ctx, pxb::CallbackRegistry& reg, int argc, JSValueConst* argv,
                  const char* name) {
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "%s 需要回调函数", name);
    }
    uint64_t id = reg.add(ctx, argv[0]);
    return pxb::make_unsubscribe(ctx, &reg, id);
}

JSValue js_on_touch(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    return subscribe(ctx, s_touch_reg, argc, argv, "onTouch");
}
JSValue js_on_button(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    return subscribe(ctx, s_button_reg, argc, argv, "onButton");
}
JSValue js_on_gesture(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    return subscribe(ctx, s_gesture_reg, argc, argv, "onGesture");
}

// ---------------------------------------------------------------
// 模块注册
// ---------------------------------------------------------------

void input_init(JSContext* ctx, JSValue px) {
    // 清掉上一代 VM 的订阅
    s_touch_reg.clear();
    s_button_reg.clear();
    s_gesture_reg.clear();

    // 硬件初始化(幂等);失败仅告警 — 订阅仍可注册, 只是不会有事件
    if (hal_periph::touch_init() != ESP_OK) ESP_LOGW(TAG, "触摸初始化失败");
    if (hal_periph::button_init() != ESP_OK) ESP_LOGW(TAG, "BOOT 按键初始化失败");
    hal_periph::touch_set_callback(on_hal_touch);
    hal_periph::button_set_callback(on_hal_button);

    JSValue input = JS_NewObject(ctx);
    pxb::def_fn(ctx, input, "onTouch", js_on_touch, 1);
    pxb::def_fn(ctx, input, "onButton", js_on_button, 1);
    pxb::def_fn(ctx, input, "onGesture", js_on_gesture, 1);
    JS_SetPropertyStr(ctx, px, "input", input);
}

const jsvm::Module s_module = {
    .name = "input",
    .priority = 10,
    .init = input_init,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
