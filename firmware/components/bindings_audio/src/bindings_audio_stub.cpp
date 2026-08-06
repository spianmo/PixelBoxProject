/**
 * bindings_audio_stub.cpp — 音频栈裁剪时 (PX_ENABLE_AUDIO=n) 的 px.audio 桩
 *
 * 与 bindings_audio.cpp 互斥编译 (CMakeLists 按 CONFIG_PX_ENABLE_AUDIO 选择)。
 * C6 等小内存/无 codec 目标默认裁掉音频栈 (hal_audio/esp_codec_dev/
 * esp_audio_codec/I2S 不参与链接, 省 flash 与任务内存), 本桩按 d.ts
 * 契约保留完整 API 表面:
 *   - 方法一律抛 Error("ENOTSUP") / 返回被拒 Promise (d.ts 第 16 行约定);
 *   - 状态如实: getVolume()=0, mic.active=false, player.playing=false。
 */
#include "esp_log.h"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

namespace {

constexpr const char* TAG = "px.audio";

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

JSValue js_zero(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return JS_NewInt32(ctx, 0);
}

void set_method(JSContext* ctx, JSValue obj, const char* name, JSCFunction* fn, int len)
{
    JS_SetPropertyStr(ctx, obj, name, JS_NewCFunction(ctx, fn, name, len));
}

void audio_native_init(JSContext* ctx, JSValue px)
{
    JSValue audio = JS_NewObject(ctx);
    set_method(ctx, audio, "setVolume", js_throw_enotsup, 1);
    set_method(ctx, audio, "getVolume", js_zero, 0);

    JSValue mic = JS_NewObject(ctx);
    set_method(ctx, mic, "start", js_throw_enotsup, 1);
    set_method(ctx, mic, "stop", js_throw_enotsup, 0);
    set_method(ctx, mic, "setGain", js_throw_enotsup, 1);
    JS_SetPropertyStr(ctx, mic, "active", JS_NewBool(ctx, false));
    JS_SetPropertyStr(ctx, audio, "mic", mic);

    JSValue player = JS_NewObject(ctx);
    set_method(ctx, player, "play", js_reject_enotsup, 1);
    set_method(ctx, player, "playPcm", js_throw_enotsup, 2);
    set_method(ctx, player, "openPcmStream", js_throw_enotsup, 1);
    set_method(ctx, player, "tone", js_throw_enotsup, 3);
    set_method(ctx, player, "stopAll", js_throw_enotsup, 0);
    JS_SetPropertyStr(ctx, player, "playing", JS_NewBool(ctx, false));
    JS_SetPropertyStr(ctx, audio, "player", player);

    set_method(ctx, audio, "record", js_reject_enotsup, 2);

    JS_SetPropertyStr(ctx, px, "audio", audio);
    ESP_LOGI(TAG, "px.audio 已注册 (音频栈裁剪 PX_ENABLE_AUDIO=n, ENOTSUP 桩)");
}

const jsvm::Module s_audio_module = {
    "audio",           // 模块名 (与真实实现一致)
    10,                // hal 域优先级
    audio_native_init, // native 初始化
    nullptr,           // 无 prelude
};

}  // namespace

JSVM_REGISTER_MODULE(s_audio_module);
