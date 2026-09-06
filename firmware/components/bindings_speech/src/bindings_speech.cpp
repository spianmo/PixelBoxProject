#include "speech_engine.hpp"
#include "speech_core.hpp"

#include <algorithm>
#include <memory>
#include <string>

#include "quickjs.h"

namespace {
std::shared_ptr<speech::Engine> engine;
bool teardown_registered = false;

JSValue error(JSContext* ctx, const char* message) {
    JSValue value = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, value, "message", JS_NewString(ctx, message));
    return JS_Throw(ctx, value);
}

std::string string_prop(JSContext* ctx, JSValueConst options, const char* name, const char* fallback = "") {
    JSValue value = JS_GetPropertyStr(ctx, options, name);
    std::string result = fallback;
    if (JS_IsString(value)) {
        const char* text = JS_ToCString(ctx, value);
        if (text) { result = text; JS_FreeCString(ctx, text); }
    }
    JS_FreeValue(ctx, value);
    return result;
}

int int_prop(JSContext* ctx, JSValueConst options, const char* name, int fallback, int minimum, int maximum) {
    JSValue value = JS_GetPropertyStr(ctx, options, name);
    int32_t result = fallback;
    if (JS_IsNumber(value)) JS_ToInt32(ctx, &result, value);
    JS_FreeValue(ctx, value);
    return std::max(minimum, std::min(maximum, static_cast<int>(result)));
}

bool ensure_engine(JSContext* ctx) {
    if (!hal_audio::ready() || hal_audio::device_rate() != speech::kRate) {
        error(ctx, "语音音频硬件未就绪，请重启设备");
        return false;
    }
    if (!engine) engine = speech::Engine::create();
    if (!engine) error(ctx, "语音线程内存不足，请更新固件后重启");
    return static_cast<bool>(engine);
}

JSValue available(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewBool(ctx, hal_audio::ready() && hal_audio::device_rate() == speech::kRate);
}

JSValue configure(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) return error(ctx, "speech.configure 需要区域和密钥");
    speech::Config config;
    config.region = string_prop(ctx, argv[0], "region");
    config.key = string_prop(ctx, argv[0], "key");
    config.language = string_prop(ctx, argv[0], "language", "zh-CN");
    config.voice = string_prop(ctx, argv[0], "voice", "zh-CN-XiaoxiaoNeural");
    const bool valid_key = config.key.size() >= 8 && config.key.size() <= 256
        && std::all_of(config.key.begin(), config.key.end(), [](unsigned char c) { return c > 32 && c < 127; });
    if (!speech::valid_region(config.region) || !speech::valid_name(config.language) || !speech::valid_name(config.voice) || !valid_key) return error(ctx, "Azure 区域、密钥或语言格式无效");
    if (!ensure_engine(ctx)) return JS_EXCEPTION;
    engine->cancel();
    std::fill(engine->config.key.begin(), engine->config.key.end(), '\0');
    engine->config = config;
    return JS_UNDEFINED;
}

JSValue promise_job(JSContext* ctx, const std::shared_ptr<speech::Job>& job) {
    JSValue functions[2];
    JSValue promise = JS_NewPromiseCapability(ctx, functions);
    if (JS_IsException(promise)) return promise;
    job->resolve = jsvm::Callback(ctx, functions[0]);
    job->reject = jsvm::Callback(ctx, functions[1]);
    JS_FreeValue(ctx, functions[0]); JS_FreeValue(ctx, functions[1]);
    engine->submit(job);
    return promise;
}

JSValue wake_start(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) return error(ctx, "wakeword.start 需要 onWake");
    if (string_prop(ctx, argv[0], "phrase", speech::kWakePhrase) != speech::kWakePhrase) return error(ctx, "离线唤醒词固定为你好小川");
    JSValue callback = JS_GetPropertyStr(ctx, argv[0], "onWake");
    if (!JS_IsFunction(ctx, callback)) { JS_FreeValue(ctx, callback); return error(ctx, "onWake 必须是函数"); }
    if (!ensure_engine(ctx)) { JS_FreeValue(ctx, callback); return JS_EXCEPTION; }
    if (const char* message = speech::Engine::prepare_model_mapping()) {
        JS_FreeValue(ctx, callback);
        return error(ctx, message);
    }
    auto job = std::make_shared<speech::Job>();
    job->kind = speech::Kind::Wake;
    JSValue threshold = JS_GetPropertyStr(ctx, argv[0], "threshold");
    double number = 0.8;
    if (JS_IsNumber(threshold)) JS_ToFloat64(ctx, &number, threshold);
    JS_FreeValue(ctx, threshold);
    job->threshold = std::isfinite(number) ? std::clamp(static_cast<float>(number), 0.5f, 0.99f) : 0.8f;
    job->callback = jsvm::Callback(ctx, callback);
    JS_FreeValue(ctx, callback);
    JSValue on_error = JS_GetPropertyStr(ctx, argv[0], "onError");
    if (JS_IsFunction(ctx, on_error)) job->error_callback = jsvm::Callback(ctx, on_error);
    JS_FreeValue(ctx, on_error);
    return promise_job(ctx, job);
}

JSValue recognize(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!ensure_engine(ctx)) return JS_EXCEPTION;
    if (engine->config.key.empty()) return error(ctx, "请先配置 Azure 语音区域和密钥");
    JSValue options = argc && JS_IsObject(argv[0]) ? JS_DupValue(ctx, argv[0]) : JS_NewObject(ctx);
    auto job = std::make_shared<speech::Job>();
    job->kind = speech::Kind::Recognize;
    job->config = engine->config;
    job->max_ms = int_prop(ctx, options, "maxMs", 15000, 1000, 30000);
    job->silence_ms = int_prop(ctx, options, "silenceMs", 800, 300, 3000);
    job->timeout_ms = int_prop(ctx, options, "timeoutMs", 20000, 5000, 60000);
    JSValue callback = JS_GetPropertyStr(ctx, options, "onLevel");
    if (JS_IsFunction(ctx, callback)) job->callback = jsvm::Callback(ctx, callback);
    JS_FreeValue(ctx, callback); JS_FreeValue(ctx, options);
    return promise_job(ctx, job);
}

JSValue speak(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!ensure_engine(ctx)) return JS_EXCEPTION;
    if (engine->config.key.empty()) return error(ctx, "请先配置 Azure 语音区域和密钥");
    if (argc < 1 || !JS_IsString(argv[0])) return error(ctx, "speak 需要文本");
    const char* text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    auto job = std::make_shared<speech::Job>();
    job->kind = speech::Kind::Speak;
    job->text = text;
    JS_FreeCString(ctx, text);
    if (job->text.empty() || job->text.size() > 6000) return error(ctx, "播报文本须为 1 至 6000 字节");
    job->config = engine->config;
    return promise_job(ctx, job);
}

JSValue cancel(JSContext*, JSValueConst, int, JSValueConst*) { if (engine) engine->cancel(); return JS_UNDEFINED; }
JSValue wake_stop(JSContext*, JSValueConst, int, JSValueConst*) { if (engine) engine->cancel(true); return JS_UNDEFINED; }

void teardown(JSContext*) { if (engine) engine->shutdown(); engine.reset(); }
void method(JSContext* ctx, JSValue object, const char* name, JSCFunction* function, int length) {
    JS_SetPropertyStr(ctx, object, name, JS_NewCFunction(ctx, function, name, length));
}
void init(JSContext* ctx, JSValue root) {
    if (!teardown_registered) { jsvm::add_teardown_hook(teardown); teardown_registered = true; }
    JSValue speech = JS_NewObject(ctx);
    method(ctx, speech, "available", available, 0); method(ctx, speech, "configure", configure, 1);
    method(ctx, speech, "recognize", recognize, 1); method(ctx, speech, "speak", speak, 1); method(ctx, speech, "cancel", cancel, 0);
    JSValue wakeword = JS_NewObject(ctx);
    method(ctx, wakeword, "start", wake_start, 1); method(ctx, wakeword, "stop", wake_stop, 0);
    JS_SetPropertyStr(ctx, speech, "wakeword", wakeword);
    JS_SetPropertyStr(ctx, root, "speech", speech);
}

// JS代数门确保已经排入JS队列的旧唤醒/音量回调在停止或换账号后不会再执行。
const char* prelude = R"JS(
(() => {
    const speech = px.speech;
    const configure = speech.configure, recognize = speech.recognize, speak = speech.speak;
    const cancel = speech.cancel, start = speech.wakeword.start, stop = speech.wakeword.stop;
    let epoch = 0;
    speech.configure = (options) => { ++epoch; return configure(options); };
    speech.cancel = () => { ++epoch; return cancel(); };
    speech.wakeword.stop = () => { ++epoch; return stop(); };
    speech.wakeword.start = (options) => {
        const ticket = ++epoch;
        return start({ ...options,
            onWake: () => { if (ticket === epoch) options.onWake(); },
            onError: (message) => { if (ticket === epoch && options.onError) options.onError(message); }
        });
    };
    speech.recognize = (options = {}) => {
        const ticket = ++epoch;
        return recognize({ ...options, onLevel: (level) => { if (ticket === epoch && options.onLevel) options.onLevel(level); } }).then((text) => {
            if (ticket !== epoch) throw new Error('语音操作已取消');
            return text;
        });
    };
    speech.speak = (text) => {
        const ticket = ++epoch;
        return speak(text).then(() => { if (ticket !== epoch) throw new Error('语音操作已取消'); });
    };
})();
)JS";
const jsvm::Module module{"speech", 12, init, prelude};
JSVM_REGISTER_MODULE(module);
}  // namespace
