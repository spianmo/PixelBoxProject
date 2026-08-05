/**
 * PixelBox voicechat — px.voice JS 绑定(模块名 "voice")
 *
 * 与 sdk/types/pixelbox.d.ts 逐一对齐:
 *   configure / start / startContinuous / stop / interrupt / sendText / say / state / on
 * 事件 8+1 类:stateChange wake speechStart speechEnd userText
 *             assistantDelta assistantText level error(level 已 100ms 节流)
 *
 * 引擎事件(任意内部线程)→ 适配器 → jsvm::post → JS 线程派发。
 * VM 热重启:px.voice 上的隐藏 guard 对象 finalizer 释放全部 JSValue 并 stop 引擎。
 */
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "esp_log.h"
#include "hal_audio/hal_audio.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"
#include "voice_engine.hpp"

namespace {

const char* TAG = "px.voice";

using voicechat::State;
using voicechat::VoiceEngine;

JSClassID g_voice_guard_cid;

/** 合法事件名(与 PxVoiceEvents 对齐) */
const char* kEventNames[] = {"stateChange", "wake",           "speechStart",
                             "speechEnd",   "userText",       "assistantDelta",
                             "assistantText", "level",        "error"};

bool is_valid_event(const char* name) {
    for (const char* e : kEventNames) {
        if (strcmp(e, name) == 0) return true;
    }
    return false;
}

/** JS 侧订阅注册表(subs/say_pending 仅 JS 线程访问;alive/ctx 由 mtx 保护) */
struct VoiceReg {
    std::mutex mtx;
    bool alive = false;
    JSContext* ctx = nullptr;
    std::map<std::string, std::vector<std::pair<int, JSValue>>> subs;
    int next_id = 1;
    std::map<int, std::pair<JSValue, JSValue>> say_pending;  // id → (resolve, reject)
};
VoiceReg g_reg;

JSValue throw_error(JSContext* ctx, const char* msg) {
    JSValue err = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, msg),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw(ctx, err);
}

void call_js(JSContext* ctx, JSValueConst fn, int argc, JSValueConst* argv) {
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, argc, const_cast<JSValue*>(argv));
    if (JS_IsException(ret)) jsvm::dump_error(ctx);
    JS_FreeValue(ctx, ret);
}

// ============================================================
// 事件派发(JS 线程)
// ============================================================

/** arg_builder 可为 nullptr(无参事件);在 JS 线程构造参数 */
void dispatch(const std::string& event, const std::function<JSValue(JSContext*)>& arg_builder) {
    JSContext* ctx = nullptr;
    std::vector<JSValue> fns;
    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        if (!g_reg.alive) return;
        ctx = g_reg.ctx;
        auto it = g_reg.subs.find(event);
        if (it == g_reg.subs.end() || it->second.empty()) return;
        fns.reserve(it->second.size());
        for (auto& kv : it->second) fns.push_back(JS_DupValue(ctx, kv.second));
    }
    JSValue arg = arg_builder ? arg_builder(ctx) : JS_UNDEFINED;
    const int argc = arg_builder ? 1 : 0;
    for (auto& fn : fns) {
        call_js(ctx, fn, argc, &arg);
        JS_FreeValue(ctx, fn);
    }
    JS_FreeValue(ctx, arg);
}

void post_simple(const char* event) {
    std::string e = event;
    jsvm::post([e] { dispatch(e, nullptr); });
}

void post_str(const char* event, const std::string& value) {
    std::string e = event;
    std::string v = value;
    jsvm::post([e, v] {
        dispatch(e, [&v](JSContext* ctx) { return JS_NewString(ctx, v.c_str()); });
    });
}

void post_int(const char* event, int value) {
    std::string e = event;
    jsvm::post([e, value] {
        dispatch(e, [value](JSContext* ctx) { return JS_NewInt32(ctx, value); });
    });
}

/** say 完成(JS 线程 resolve/reject) */
void post_say_done(int id, bool ok, const std::string& err) {
    jsvm::post([id, ok, err] {
        JSContext* ctx = nullptr;
        JSValue resolve = JS_UNDEFINED, reject = JS_UNDEFINED;
        {
            std::lock_guard<std::mutex> lk(g_reg.mtx);
            if (!g_reg.alive) return;
            ctx = g_reg.ctx;
            auto it = g_reg.say_pending.find(id);
            if (it == g_reg.say_pending.end()) return;
            resolve = it->second.first;
            reject = it->second.second;
            g_reg.say_pending.erase(it);
        }
        if (ok) {
            JSValue r = JS_Call(ctx, resolve, JS_UNDEFINED, 0, nullptr);
            JS_FreeValue(ctx, r);
        } else {
            JSValue e = JS_NewError(ctx);
            JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, err.c_str()),
                                      JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
            JSValue r = JS_Call(ctx, reject, JS_UNDEFINED, 1, &e);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, e);
        }
        JS_FreeValue(ctx, resolve);
        JS_FreeValue(ctx, reject);
    });
}

/** 引擎事件 → JS 适配器(任意线程安全,内部只做 jsvm::post) */
VoiceEngine::Events make_adapter() {
    VoiceEngine::Events ev;
    ev.state_change = [](State s) { post_str("stateChange", voicechat::state_name(s)); };
    ev.wake = [] { post_simple("wake"); };
    ev.speech_start = [] { post_simple("speechStart"); };
    ev.speech_end = [] { post_simple("speechEnd"); };
    ev.user_text = [](const std::string& t) { post_str("userText", t); };
    ev.assistant_delta = [](const std::string& t) { post_str("assistantDelta", t); };
    ev.assistant_text = [](const std::string& t) { post_str("assistantText", t); };
    ev.level = [](int lv) { post_int("level", lv); };
    ev.error = [](const std::string& m) { post_str("error", m); };
    ev.say_done = [](int id, bool ok, const std::string& e) { post_say_done(id, ok, e); };
    return ev;
}

// ============================================================
// px.voice 方法
// ============================================================

#define ENSURE_AUDIO(ctx)                                        \
    do {                                                         \
        if (!hal_audio::ready()) return jsvm::throw_enotsup(ctx); \
    } while (0)

JSValue js_voice_configure(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) return throw_error(ctx, "configure 需要选项对象");
    VoiceEngine::Options opts;

    JSValue jurl = JS_GetPropertyStr(ctx, argv[0], "serverUrl");
    const char* url = JS_ToCString(ctx, jurl);
    if (!url || url[0] == '\0') {
        if (url) JS_FreeCString(ctx, url);
        JS_FreeValue(ctx, jurl);
        return throw_error(ctx, "serverUrl 必填");
    }
    opts.server_url = url;
    JS_FreeCString(ctx, url);
    JS_FreeValue(ctx, jurl);

    JSValue jtoken = JS_GetPropertyStr(ctx, argv[0], "token");
    if (JS_IsString(jtoken)) {
        const char* tk = JS_ToCString(ctx, jtoken);
        if (tk) {
            opts.token = tk;
            JS_FreeCString(ctx, tk);
        }
    }
    JS_FreeValue(ctx, jtoken);

    JSValue jwake = JS_GetPropertyStr(ctx, argv[0], "wakeword");
    opts.wakeword = JS_ToBool(ctx, jwake) == 1;
    JS_FreeValue(ctx, jwake);

    JSValue jvad = JS_GetPropertyStr(ctx, argv[0], "vadSilenceMs");
    int32_t vad_ms = 800;
    if (!JS_IsUndefined(jvad) && !JS_IsNull(jvad)) {
        if (JS_ToInt32(ctx, &vad_ms, jvad) != 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            vad_ms = 800;
        }
    }
    JS_FreeValue(ctx, jvad);
    if (vad_ms < 200) vad_ms = 200;
    if (vad_ms > 5000) vad_ms = 5000;
    opts.vad_silence_ms = vad_ms;

    VoiceEngine::instance().configure(opts);
    return JS_UNDEFINED;
}

JSValue js_voice_start(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    ENSURE_AUDIO(ctx);
    VoiceEngine::instance().start();
    return JS_UNDEFINED;
}

JSValue js_voice_start_continuous(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    ENSURE_AUDIO(ctx);
    VoiceEngine::instance().start_continuous();
    return JS_UNDEFINED;
}

JSValue js_voice_stop(JSContext*, JSValueConst, int, JSValueConst*) {
    VoiceEngine::instance().stop();
    return JS_UNDEFINED;
}

JSValue js_voice_interrupt(JSContext*, JSValueConst, int, JSValueConst*) {
    VoiceEngine::instance().interrupt();
    return JS_UNDEFINED;
}

JSValue js_voice_send_text(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_AUDIO(ctx);
    if (argc < 1) return throw_error(ctx, "sendText 需要文本参数");
    const char* text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    VoiceEngine::instance().send_text(text);
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

JSValue js_voice_say(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    ENSURE_AUDIO(ctx);
    if (argc < 1) return throw_error(ctx, "say 需要文本参数");
    const char* text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    std::string t = text;
    JS_FreeCString(ctx, text);

    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) return promise;

    const int id = VoiceEngine::instance().say(t);
    if (id < 0) {
        const char* msg = id == -2 ? "上一条 say 尚未完成" : "voice 未配置,请先调用 configure()";
        JSValue e = JS_NewError(ctx);
        JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, msg),
                                  JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
        JSValue r = JS_Call(ctx, funcs[1], JS_UNDEFINED, 1, &e);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, e);
        JS_FreeValue(ctx, funcs[0]);
        JS_FreeValue(ctx, funcs[1]);
        return promise;
    }
    std::lock_guard<std::mutex> lk(g_reg.mtx);
    g_reg.say_pending.emplace(id, std::make_pair(funcs[0], funcs[1]));
    return promise;
}

JSValue js_voice_state(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewString(ctx, voicechat::state_name(VoiceEngine::instance().state()));
}

JSValue js_voice_unsub(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                       JSValueConst* data) {
    const char* event = JS_ToCString(ctx, data[0]);
    int32_t id = 0;
    JS_ToInt32(ctx, &id, data[1]);
    if (!event) return JS_UNDEFINED;
    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        if (g_reg.alive) {
            auto it = g_reg.subs.find(event);
            if (it != g_reg.subs.end()) {
                auto& v = it->second;
                for (auto i = v.begin(); i != v.end(); ++i) {
                    if (i->first == id) {
                        JS_FreeValue(ctx, i->second);
                        v.erase(i);
                        break;
                    }
                }
            }
        }
    }
    JS_FreeCString(ctx, event);
    return JS_UNDEFINED;
}

JSValue js_voice_on(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2) return throw_error(ctx, "on(event, cb) 需要两个参数");
    const char* event = JS_ToCString(ctx, argv[0]);
    if (!event) return JS_EXCEPTION;
    if (!is_valid_event(event)) {
        JS_FreeCString(ctx, event);
        return throw_error(ctx, "未知的 voice 事件名");
    }
    if (!JS_IsFunction(ctx, argv[1])) {
        JS_FreeCString(ctx, event);
        return throw_error(ctx, "回调必须为函数");
    }
    int id = 0;
    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        id = g_reg.next_id++;
        g_reg.subs[event].emplace_back(id, JS_DupValue(ctx, argv[1]));
    }
    JSValue data[2] = {argv[0], JS_NewInt32(ctx, id)};
    JSValue unsub = JS_NewCFunctionData(ctx, js_voice_unsub, 0, 0, 2, data);
    JS_FreeCString(ctx, event);
    return unsub;
}

// ============================================================
// guard(VM 热重启收尾)与模块初始化
// ============================================================

void voice_guard_finalizer(JSRuntime* rt, JSValueConst) {
    // 应用被替换:引擎回 idle(硬件层保持初始化)
    VoiceEngine::instance().stop();
    std::lock_guard<std::mutex> lk(g_reg.mtx);
    g_reg.alive = false;
    g_reg.ctx = nullptr;
    for (auto& kv : g_reg.subs) {
        for (auto& sub : kv.second) JS_FreeValueRT(rt, sub.second);
    }
    g_reg.subs.clear();
    for (auto& kv : g_reg.say_pending) {
        JS_FreeValueRT(rt, kv.second.first);
        JS_FreeValueRT(rt, kv.second.second);
    }
    g_reg.say_pending.clear();
}

void voice_native_init(JSContext* ctx, JSValue px) {
    JSRuntime* rt = JS_GetRuntime(ctx);
    if (g_voice_guard_cid == 0) JS_NewClassID(rt, &g_voice_guard_cid);
    static const JSClassDef guard_def = {"PxVoiceGuard", voice_guard_finalizer, nullptr, nullptr,
                                         nullptr};
    if (!JS_IsRegisteredClass(rt, g_voice_guard_cid)) {
        JS_NewClass(rt, g_voice_guard_cid, &guard_def);
    }

    {
        std::lock_guard<std::mutex> lk(g_reg.mtx);
        g_reg.alive = true;
        g_reg.ctx = ctx;
    }
    VoiceEngine::instance().set_events(make_adapter());

    JSValue voice = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, voice, "configure",
                      JS_NewCFunction(ctx, js_voice_configure, "configure", 1));
    JS_SetPropertyStr(ctx, voice, "start", JS_NewCFunction(ctx, js_voice_start, "start", 0));
    JS_SetPropertyStr(ctx, voice, "startContinuous",
                      JS_NewCFunction(ctx, js_voice_start_continuous, "startContinuous", 0));
    JS_SetPropertyStr(ctx, voice, "stop", JS_NewCFunction(ctx, js_voice_stop, "stop", 0));
    JS_SetPropertyStr(ctx, voice, "interrupt",
                      JS_NewCFunction(ctx, js_voice_interrupt, "interrupt", 0));
    JS_SetPropertyStr(ctx, voice, "sendText",
                      JS_NewCFunction(ctx, js_voice_send_text, "sendText", 1));
    JS_SetPropertyStr(ctx, voice, "say", JS_NewCFunction(ctx, js_voice_say, "say", 1));
    JS_SetPropertyStr(ctx, voice, "state", JS_NewCFunction(ctx, js_voice_state, "state", 0));
    JS_SetPropertyStr(ctx, voice, "on", JS_NewCFunction(ctx, js_voice_on, "on", 2));

    JSValue guard = JS_NewObjectClass(ctx, static_cast<int>(g_voice_guard_cid));
    JS_DefinePropertyValueStr(ctx, voice, "__pxVoiceGuard", guard, 0);

    JS_SetPropertyStr(ctx, px, "voice", voice);
    ESP_LOGD(TAG, "px.voice 就绪");
}

const jsvm::Module s_voice_module = {
    "voice",           // 模块名
    20,                // 在 audio(10) 之后初始化
    voice_native_init, // native 初始化
    nullptr,           // 无 prelude
};

}  // namespace

JSVM_REGISTER_MODULE(s_voice_module);
