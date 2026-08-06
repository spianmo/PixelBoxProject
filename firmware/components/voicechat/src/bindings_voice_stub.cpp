/**
 * bindings_voice_stub.cpp — 音频栈裁剪时 (PX_ENABLE_AUDIO=n) 的 px.voice 桩
 *
 * 与 voice_engine/bindings_voice 等互斥编译 (CMakeLists 按
 * CONFIG_PX_ENABLE_AUDIO 选择)。语音对话依赖麦克风/扬声器 (hal_audio),
 * 音频栈裁剪的目标 (默认 C6) 上按 d.ts 契约保留 API 表面:
 *   - 动作方法抛 Error("ENOTSUP"); say() 返回被拒 Promise;
 *   - state() 如实返回 'idle'; on() 可订阅但永不触发。
 */
#include "esp_log.h"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

namespace {

constexpr const char* TAG = "px.voice";

JSValue rejected_enotsup(JSContext* ctx)
{
    JSValue funcs[2];
    JSValue prom = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(prom)) return prom;
    JSValue err = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, "ENOTSUP"));
    JSValue r = JS_Call(ctx, funcs[1], JS_UNDEFINED, 1, &err);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, err);
    JS_FreeValue(ctx, funcs[0]);
    JS_FreeValue(ctx, funcs[1]);
    return prom;
}

JSValue js_reject_enotsup(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return rejected_enotsup(ctx);
}

JSValue js_throw_enotsup(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return jsvm::throw_enotsup(ctx);
}

JSValue js_noop(JSContext*, JSValueConst, int, JSValueConst*)
{
    return JS_UNDEFINED;
}

JSValue js_on_noop(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return JS_NewCFunction(ctx, js_noop, "unsubscribe", 0);
}

JSValue js_state_idle(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return JS_NewString(ctx, "idle");
}

void set_method(JSContext* ctx, JSValue obj, const char* name, JSCFunction* fn, int len)
{
    JS_SetPropertyStr(ctx, obj, name, JS_NewCFunction(ctx, fn, name, len));
}

void voice_native_init(JSContext* ctx, JSValue px)
{
    JSValue voice = JS_NewObject(ctx);
    set_method(ctx, voice, "configure", js_throw_enotsup, 1);
    set_method(ctx, voice, "start", js_throw_enotsup, 0);
    set_method(ctx, voice, "startContinuous", js_throw_enotsup, 0);
    set_method(ctx, voice, "stop", js_noop, 0);
    set_method(ctx, voice, "interrupt", js_noop, 0);
    set_method(ctx, voice, "sendText", js_throw_enotsup, 1);
    set_method(ctx, voice, "say", js_reject_enotsup, 1);
    set_method(ctx, voice, "state", js_state_idle, 0);
    set_method(ctx, voice, "on", js_on_noop, 2);
    JS_SetPropertyStr(ctx, px, "voice", voice);
    ESP_LOGI(TAG, "px.voice 已注册 (音频栈裁剪 PX_ENABLE_AUDIO=n, ENOTSUP 桩)");
}

const jsvm::Module s_voice_module = {
    "voice",           // 模块名 (与真实实现一致)
    20,                // 在 audio(10) 之后初始化
    voice_native_init, // native 初始化
    nullptr,           // 无 prelude
};

}  // namespace

JSVM_REGISTER_MODULE(s_voice_module);
