/**
 * js_std.cpp — 标准全局: console / setTimeout 族 / queueMicrotask / performance 钩子
 *
 * console 输出同时:
 *   1) 走 ESP_LOG (串口可见);
 *   2) 转发给已注册 LogSink (devd 转发到 IDE/CLI)。
 *
 * 另注册 "core" 模块 (priority -10), 其 prelude (prelude_core.js) 提供
 * TextEncoder/TextDecoder/atob/btoa/performance.now/px.util 纯 JS 部分/px.color。
 */
#include "jsvm_internal.hpp"

#include <cmath>
#include <cstring>
#include <climits>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "js";

/* EMBED_TXTFILES 注入的 prelude (NUL 结尾) */
extern const char _binary_prelude_core_js_start[];

namespace jsvm {
namespace internal {

/* ------------------------------------------------------------
 * 日志分发
 * ------------------------------------------------------------ */

namespace {
std::mutex s_sink_mutex;
std::vector<LogSink> s_sinks;
} // namespace

void dispatch_log(int level, const char *tag, const char *msg)
{
    switch (level) {
    case 0:
        ESP_LOGD(TAG, "%s", msg);
        break;
    case 2:
        ESP_LOGW(TAG, "%s", msg);
        break;
    case 3:
        ESP_LOGE(TAG, "%s", msg);
        break;
    default:
        ESP_LOGI(TAG, "%s", msg);
        break;
    }
    std::lock_guard<std::mutex> lk(s_sink_mutex);
    for (auto sink : s_sinks) {
        sink(level, tag, msg);
    }
}

} // namespace internal

void add_log_sink(LogSink sink)
{
    std::lock_guard<std::mutex> lk(internal::s_sink_mutex);
    internal::s_sinks.push_back(sink);
}

namespace internal {

/* ------------------------------------------------------------
 * console
 * ------------------------------------------------------------ */

namespace {

std::string format_args(JSContext *ctx, int argc, JSValueConst *argv)
{
    std::string out;
    for (int i = 0; i < argc; i++) {
        if (i) {
            out += ' ';
        }
        JSValueConst v = argv[i];
        if (JS_IsObject(v) && !JS_IsFunction(ctx, v)) {
            JSValue json = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
            if (JS_IsString(json)) {
                const char *cs = JS_ToCString(ctx, json);
                if (cs) {
                    out += cs;
                    JS_FreeCString(ctx, cs);
                }
                JS_FreeValue(ctx, json);
                continue;
            }
            JS_FreeValue(ctx, json);
            JS_FreeValue(ctx, JS_GetException(ctx)); /* 循环引用等: 回退 toString */
        }
        const char *cs = JS_ToCString(ctx, v);
        if (cs) {
            out += cs;
            JS_FreeCString(ctx, cs);
        } else {
            JS_FreeValue(ctx, JS_GetException(ctx));
            out += "(?)";
        }
    }
    return out;
}

JSValue js_console_write(JSContext *ctx, JSValueConst this_val, int argc,
                         JSValueConst *argv, int magic)
{
    (void)this_val;
    std::string msg = format_args(ctx, argc, argv);
    dispatch_log(magic, "js", msg.c_str());
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------
 * 定时器 (仅 JS 线程访问)
 * ------------------------------------------------------------ */

using TimerSchedule = std::multimap<int64_t, int32_t>;
struct TimerRec {
    JSValue fn;
    std::vector<JSValue> args;
    int64_t deadline_us;
    int64_t interval_us;
    bool repeat;
    TimerSchedule::iterator scheduled;
};

std::map<int32_t, TimerRec> s_timers;
TimerSchedule s_timer_schedule;
int32_t s_next_timer_id = 1;

JSValue js_set_timer(JSContext *ctx, JSValueConst this_val, int argc,
                     JSValueConst *argv, int magic /* 0=timeout 1=interval */)
{
    (void)this_val;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "定时器回调必须是函数");
    }
    double ms = 0;
    if (argc >= 2 && JS_ToFloat64(ctx, &ms, argv[1])) {
        return JS_EXCEPTION;
    }
    if (!std::isfinite(ms) || ms < 0) ms = 0;
    if (ms > INT32_MAX) ms = INT32_MAX;

    TimerRec rec;
    rec.fn = JS_DupValue(ctx, argv[0]);
    for (int i = 2; i < argc; i++) {
        rec.args.push_back(JS_DupValue(ctx, argv[i]));
    }
    rec.interval_us = (int64_t)(ms * 1000.0);
    rec.deadline_us = esp_timer_get_time() + rec.interval_us;
    rec.repeat = (magic == 1);

    while (s_timers.count(s_next_timer_id))
        s_next_timer_id = s_next_timer_id == INT32_MAX ? 1 : s_next_timer_id + 1;
    const int32_t id = s_next_timer_id;
    s_next_timer_id = id == INT32_MAX ? 1 : id + 1;
    rec.scheduled = s_timer_schedule.emplace(rec.deadline_us, id);
    s_timers.emplace(id, std::move(rec));
    return JS_NewInt32(ctx, id);
}

JSValue js_clear_timer(JSContext *ctx, JSValueConst this_val, int argc,
                       JSValueConst *argv, int magic)
{
    (void)this_val;
    (void)magic;
    if (argc < 1) {
        return JS_UNDEFINED;
    }
    int32_t id = 0;
    if (JS_ToInt32(ctx, &id, argv[0])) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    auto it = s_timers.find(id);
    if (it != s_timers.end()) {
        s_timer_schedule.erase(it->second.scheduled);
        JS_FreeValue(ctx, it->second.fn);
        for (auto &a : it->second.args) {
            JS_FreeValue(ctx, a);
        }
        s_timers.erase(it);
    }
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------
 * queueMicrotask / performance
 * ------------------------------------------------------------ */

JSValue microtask_job(JSContext *ctx, int argc, JSValueConst *argv)
{
    (void)argc;
    return JS_Call(ctx, argv[0], JS_UNDEFINED, 0, nullptr);
}

JSValue js_queue_microtask(JSContext *ctx, JSValueConst this_val, int argc,
                           JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "queueMicrotask 需要函数参数");
    }
    JSValueConst fn = argv[0];
    if (JS_EnqueueJob(ctx, microtask_job, 1, &fn) < 0) {
        return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

JSValue js_perf_now_ms(JSContext *ctx, JSValueConst this_val, int argc,
                       JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_NewFloat64(ctx, (double)esp_timer_get_time() / 1000.0);
}

JSValue js_runtime_stats(JSContext *ctx, JSValueConst, int, JSValueConst *)
{
    const auto stats = runtime_stats();
    JSValue value = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, value, "queueDepth", JS_NewUint32(ctx, stats.queue_depth));
    JS_SetPropertyStr(ctx, value, "queuePeak", JS_NewUint32(ctx, stats.queue_peak));
    JS_SetPropertyStr(ctx, value, "droppedJobs", JS_NewUint32(ctx, stats.dropped_jobs));
    JS_SetPropertyStr(ctx, value, "executionTimeouts", JS_NewUint32(ctx, stats.execution_timeouts));
    JS_SetPropertyStr(ctx, value, "maxTurnMs", JS_NewFloat64(ctx, stats.max_turn_us / 1000.0));
    JS_SetPropertyStr(ctx, value, "maxSourceMs", JS_NewFloat64(ctx, stats.max_source_us / 1000.0));
    JS_SetPropertyStr(ctx, value, "maxJobMs", JS_NewFloat64(ctx, stats.max_job_us / 1000.0));
    return value;
}

} // namespace

/* ------------------------------------------------------------
 * 内部接口实现
 * ------------------------------------------------------------ */

void install_std_globals(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);

    /* console */
    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "debug",
                      JS_NewCFunctionMagic(ctx, js_console_write, "debug", 0, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, console, "log",
                      JS_NewCFunctionMagic(ctx, js_console_write, "log", 0, JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, console, "info",
                      JS_NewCFunctionMagic(ctx, js_console_write, "info", 0, JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, console, "warn",
                      JS_NewCFunctionMagic(ctx, js_console_write, "warn", 0, JS_CFUNC_generic_magic, 2));
    JS_SetPropertyStr(ctx, console, "error",
                      JS_NewCFunctionMagic(ctx, js_console_write, "error", 0, JS_CFUNC_generic_magic, 3));
    JS_SetPropertyStr(ctx, global, "console", console);

    /* 定时器 */
    JS_SetPropertyStr(ctx, global, "setTimeout",
                      JS_NewCFunctionMagic(ctx, js_set_timer, "setTimeout", 2, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, global, "setInterval",
                      JS_NewCFunctionMagic(ctx, js_set_timer, "setInterval", 2, JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, global, "clearTimeout",
                      JS_NewCFunctionMagic(ctx, js_clear_timer, "clearTimeout", 1, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, global, "clearInterval",
                      JS_NewCFunctionMagic(ctx, js_clear_timer, "clearInterval", 1, JS_CFUNC_generic_magic, 1));

    /* 微任务 + 高精度时钟钩子 (prelude 中包装为 performance.now) */
    JS_SetPropertyStr(ctx, global, "queueMicrotask",
                      JS_NewCFunction(ctx, js_queue_microtask, "queueMicrotask", 1));
    JS_SetPropertyStr(ctx, global, "__pxPerfNowMs",
                      JS_NewCFunction(ctx, js_perf_now_ms, "__pxPerfNowMs", 0));
    JS_DefinePropertyValueStr(ctx, global, "__pxRuntimeStats",
        JS_NewCFunction(ctx, js_runtime_stats, "__pxRuntimeStats", 0), 0);

    JS_FreeValue(ctx, global);
}

void reset_std_state(JSContext *ctx)
{
    for (auto &kv : s_timers) {
        JS_FreeValue(ctx, kv.second.fn);
        for (auto &a : kv.second.args) {
            JS_FreeValue(ctx, a);
        }
    }
    s_timers.clear();
    s_timer_schedule.clear();
    s_next_timer_id = 1;
}

int64_t next_timer_deadline_us()
{
    return s_timer_schedule.empty() ? -1 : s_timer_schedule.begin()->first;
}

void run_due_timers(JSContext *ctx)
{
    if (s_timers.empty()) {
        return;
    }
    int64_t now = esp_timer_get_time();

    // Deadline order prevents short intervals with low IDs starving older timers.
    // Bound both work and elapsed time; callbacks may schedule/cancel timers.
    for (int fired = 0; fired < 8 && !stopping(); ++fired) {
        if (s_timer_schedule.empty() || s_timer_schedule.begin()->first > now) break;
        const int32_t id = s_timer_schedule.begin()->second;
        auto it = s_timers.find(id);
        TimerRec &t = it->second;
        s_timer_schedule.erase(t.scheduled);

        /* dup 后调用, 防止回调中 clearTimeout 自身导致提前释放 */
        JSValue fn = JS_DupValue(ctx, t.fn);
        std::vector<JSValue> args;
        args.reserve(t.args.size());
        for (auto &a : t.args) {
            args.push_back(JS_DupValue(ctx, a));
        }

        if (t.repeat) {
            int64_t iv = t.interval_us < 1000 ? 1000 : t.interval_us; /* interval 最小 1ms */
            const int64_t current = esp_timer_get_time();
            t.deadline_us += ((current - t.deadline_us) / iv + 1) * iv;
            t.scheduled = s_timer_schedule.emplace(t.deadline_us, id);
        } else {
            JS_FreeValue(ctx, t.fn);
            for (auto &a : t.args) {
                JS_FreeValue(ctx, a);
            }
            s_timers.erase(it);
        }

        JSValue ret = call(ctx, fn, JS_UNDEFINED, (int)args.size(), args.data());
        if (JS_IsException(ret)) {
            dump_error(ctx);
        }
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, fn);
        for (auto &a : args) {
            JS_FreeValue(ctx, a);
        }
        if (esp_timer_get_time() - now >= 2000) break;
    }
}

} // namespace internal
} // namespace jsvm

/* ------------------------------------------------------------
 * core 模块: 无 native init, prelude 提供纯 JS 标准全局与工具
 * ------------------------------------------------------------ */

JSVM_REGISTER_MODULE((jsvm::Module{
    .name = "core",
    .priority = -10,
    .init = nullptr,
    .prelude = _binary_prelude_core_js_start,
}));
