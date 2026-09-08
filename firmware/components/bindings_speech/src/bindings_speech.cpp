#include "speech_engine.hpp"
#include "speech_core.hpp"

#include <algorithm>
#include <memory>
#include <string>

#include "quickjs.h"

namespace {
std::shared_ptr<speech::Engine> operation_engine;
std::shared_ptr<speech::Engine> wake_engine;
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
        size_t length = 0;
        const char* text = JS_ToCStringLen(ctx, &length, value);
        if (text) { result.assign(text, length); JS_FreeCString(ctx, text); }
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

bool ensure_engine(JSContext* ctx, std::shared_ptr<speech::Engine>& target, speech::Role role) {
    if (!hal_audio::ready() || hal_audio::device_rate() != speech::kRate) {
        error(ctx, "语音音频硬件未就绪，请重启设备");
        return false;
    }
    if (!target) target = speech::Engine::create(role);
    if (!target) error(ctx, "语音线程内存不足，请更新固件后重启");
    return static_cast<bool>(target);
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
    if (!ensure_engine(ctx, operation_engine, speech::Role::Operation)) return JS_EXCEPTION;
    // 换账号或语音配置时，两条通道的旧任务与回调都必须失效。
    operation_engine->cancel();
    if (wake_engine) wake_engine->cancel();
    std::fill(operation_engine->config.key.begin(), operation_engine->config.key.end(), '\0');
    operation_engine->config = config;
    return JS_UNDEFINED;
}

JSValue promise_job(JSContext* ctx, const std::shared_ptr<speech::Engine>& target,
                    const std::shared_ptr<speech::Job>& job) {
    JSValue functions[2];
    JSValue promise = JS_NewPromiseCapability(ctx, functions);
    if (JS_IsException(promise)) return promise;
    job->resolve = jsvm::Callback(ctx, functions[0]);
    job->reject = jsvm::Callback(ctx, functions[1]);
    JS_FreeValue(ctx, functions[0]); JS_FreeValue(ctx, functions[1]);
    target->submit(job);
    return promise;
}

JSValue wake_start(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) return error(ctx, "wakeword.start 需要 phrase、pinyin、threshold 和 onWake");
    auto job = std::make_shared<speech::Job>();
    job->kind = speech::Kind::Wake;
    job->wake_config.phrase = string_prop(ctx, argv[0], "phrase");
    job->wake_config.pinyin = string_prop(ctx, argv[0], "pinyin");
    JSValue threshold = JS_GetPropertyStr(ctx, argv[0], "threshold");
    if (JS_IsException(threshold)) return JS_EXCEPTION;
    if (JS_IsNumber(threshold)) JS_ToFloat64(ctx, &job->wake_config.threshold, threshold);
    JS_FreeValue(ctx, threshold);
    // 在启动线程或替换旧任务前校验完整配置；任务持有快照，不受后续 JS 对象修改影响。
    if (const char* message = speech::validate_wake_config(job->wake_config)) return error(ctx, message);
    JSValue callback = JS_GetPropertyStr(ctx, argv[0], "onWake");
    if (!JS_IsFunction(ctx, callback)) { JS_FreeValue(ctx, callback); return error(ctx, "onWake 必须是函数"); }
    if (!ensure_engine(ctx, wake_engine, speech::Role::Wake)) { JS_FreeValue(ctx, callback); return JS_EXCEPTION; }
    if (const char* message = speech::Engine::prepare_model_mapping()) {
        JS_FreeValue(ctx, callback);
        return error(ctx, message);
    }
    job->callback = jsvm::Callback(ctx, callback);
    JS_FreeValue(ctx, callback);
    JSValue on_error = JS_GetPropertyStr(ctx, argv[0], "onError");
    if (JS_IsFunction(ctx, on_error)) job->error_callback = jsvm::Callback(ctx, on_error);
    JS_FreeValue(ctx, on_error);
    return promise_job(ctx, wake_engine, job);
}

JSValue recognize(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!ensure_engine(ctx, operation_engine, speech::Role::Operation)) return JS_EXCEPTION;
    if (operation_engine->config.key.empty()) return error(ctx, "请先配置 Azure 语音区域和密钥");
    JSValue options = argc && JS_IsObject(argv[0]) ? JS_DupValue(ctx, argv[0]) : JS_NewObject(ctx);
    auto job = std::make_shared<speech::Job>();
    job->kind = speech::Kind::Recognize;
    job->config = operation_engine->config;
    job->max_ms = int_prop(ctx, options, "maxMs", 15000, 1000, 30000);
    job->silence_ms = int_prop(ctx, options, "silenceMs", 800, 300, 3000);
    job->timeout_ms = int_prop(ctx, options, "timeoutMs", 20000, 5000, 60000);
    JSValue callback = JS_GetPropertyStr(ctx, options, "onLevel");
    if (JS_IsFunction(ctx, callback)) job->callback = jsvm::Callback(ctx, callback);
    JS_FreeValue(ctx, callback);
    JSValue partial = JS_GetPropertyStr(ctx, options, "onPartial");
    if (JS_IsFunction(ctx, partial)) job->partial_callback = jsvm::Callback(ctx, partial);
    JS_FreeValue(ctx, partial); JS_FreeValue(ctx, options);
    return promise_job(ctx, operation_engine, job);
}

JSValue speak(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!ensure_engine(ctx, operation_engine, speech::Role::Operation)) return JS_EXCEPTION;
    if (operation_engine->config.key.empty()) return error(ctx, "请先配置 Azure 语音区域和密钥");
    if (argc < 1 || !JS_IsString(argv[0])) return error(ctx, "speak 需要文本");
    const char* text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    auto job = std::make_shared<speech::Job>();
    job->kind = speech::Kind::Speak;
    job->text = text;
    JS_FreeCString(ctx, text);
    if (job->text.empty() || job->text.size() > 6000) return error(ctx, "播报文本须为 1 至 6000 字节");
    job->config = operation_engine->config;
    return promise_job(ctx, operation_engine, job);
}

JSValue cancel(JSContext*, JSValueConst, int, JSValueConst*) {
    if (operation_engine) operation_engine->cancel();
    if (wake_engine) wake_engine->cancel();
    return JS_UNDEFINED;
}
JSValue wake_stop(JSContext*, JSValueConst, int, JSValueConst*) {
    if (wake_engine) wake_engine->cancel();
    return JS_UNDEFINED;
}

void teardown(JSContext*) {
    if (wake_engine) wake_engine->shutdown();
    if (operation_engine) operation_engine->shutdown();
    wake_engine.reset();
    operation_engine.reset();
}
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

// 唤醒和前台语音使用独立代数；识别或播报开始时不能使并行唤醒回调失效。
const char* prelude = R"JS(
(() => {
    const speech = px.speech;
    const configure = speech.configure, recognize = speech.recognize, speak = speech.speak;
    const cancel = speech.cancel, start = speech.wakeword.start, stop = speech.wakeword.stop;
    let wakeEpoch = 0, operationEpoch = 0;
    speech.configure = (options) => { ++wakeEpoch; ++operationEpoch; return configure(options); };
    speech.cancel = () => { ++wakeEpoch; ++operationEpoch; return cancel(); };
    speech.wakeword.stop = () => { ++wakeEpoch; return stop(); };
    speech.wakeword.start = (options) => {
        if (!options || typeof options.onWake !== 'function') throw new TypeError('onWake 必须是函数');
        const { onWake, onError } = options;
        if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError 必须是函数');
        const ticket = wakeEpoch + 1;
        const ready = start({ ...options,
            onWake: () => { if (ticket === wakeEpoch) onWake(); },
            onError: (message) => { if (ticket === wakeEpoch && onError) onError(message); }
        });
        wakeEpoch = ticket;
        return ready;
    };
    speech.recognize = (options = {}) => {
        const ticket = ++operationEpoch;
        return recognize({ ...options,
            onLevel: (level) => { if (ticket === operationEpoch && options.onLevel) options.onLevel(level); },
            onPartial: (text) => { if (ticket === operationEpoch && options.onPartial) options.onPartial(text); }
        }).then((text) => {
            if (ticket !== operationEpoch) throw new Error('语音操作已取消');
            return text;
        });
    };
    speech.speak = (text) => {
        const ticket = ++operationEpoch;
        return speak(text).then(() => { if (ticket !== operationEpoch) throw new Error('语音操作已取消'); });
    };
})();
)JS";
const jsvm::Module module{"speech", 12, init, prelude};
JSVM_REGISTER_MODULE(module);
}  // namespace
