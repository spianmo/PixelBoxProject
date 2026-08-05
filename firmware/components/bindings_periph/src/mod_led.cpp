/**
 * mod_led.cpp — px.led 绑定(WS2812 灯带, Kconfig PX_ENABLE_LED 默认关)
 *
 * 未启用时:available() === false, count === 0, 其余方法抛 Error("ENOTSUP")。
 */
#include "hal_periph/led_hal.hpp"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

namespace {

/** 未启用统一拦截;可用返回 true, 否则已抛 ENOTSUP */
bool guard(JSContext* ctx) {
    if (hal_periph::led_available()) return true;
    jsvm::throw_enotsup(ctx);
    return false;
}

JSValue js_available(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewBool(ctx, hal_periph::led_available());
}

JSValue js_set_brightness(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    int32_t pct = 100;
    if (argc >= 1) JS_ToInt32(ctx, &pct, argv[0]);
    hal_periph::led_set_brightness(pct);
    return JS_UNDEFINED;
}

JSValue js_set(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    int32_t index = 0;
    uint32_t color = 0;
    if (argc < 2 || JS_ToInt32(ctx, &index, argv[0]) != 0 ||
        JS_ToUint32(ctx, &color, argv[1]) != 0) {
        return JS_ThrowTypeError(ctx, "set(index, color) 需要 2 个数值参数");
    }
    if (hal_periph::led_set(index, color) != ESP_OK) {
        return JS_ThrowRangeError(ctx, "灯珠下标越界: %d (count=%d)", static_cast<int>(index),
                                  hal_periph::led_count());
    }
    return JS_UNDEFINED;
}

JSValue js_fill(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    uint32_t color = 0;
    if (argc < 1 || JS_ToUint32(ctx, &color, argv[0]) != 0) {
        return JS_ThrowTypeError(ctx, "fill(color) 需要颜色参数");
    }
    hal_periph::led_fill(color);
    return JS_UNDEFINED;
}

JSValue js_clear(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    hal_periph::led_clear();
    return JS_UNDEFINED;
}

JSValue js_show(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (hal_periph::led_show() != ESP_OK) {
        return JS_ThrowInternalError(ctx, "灯带提交失败 (RMT)");
    }
    return JS_UNDEFINED;
}

void led_init(JSContext* ctx, JSValue px) {
    JSValue led = JS_NewObject(ctx);
    pxb::def_fn(ctx, led, "available", js_available, 0);
    // count 为数据属性(编译期常量;未启用时为 0)
    JS_SetPropertyStr(ctx, led, "count", JS_NewInt32(ctx, hal_periph::led_count()));
    pxb::def_fn(ctx, led, "setBrightness", js_set_brightness, 1);
    pxb::def_fn(ctx, led, "set", js_set, 2);
    pxb::def_fn(ctx, led, "fill", js_fill, 1);
    pxb::def_fn(ctx, led, "clear", js_clear, 0);
    pxb::def_fn(ctx, led, "show", js_show, 0);
    JS_SetPropertyStr(ctx, px, "led", led);
}

const jsvm::Module s_module = {
    .name = "led",
    .priority = 10,
    .init = led_init,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
