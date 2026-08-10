/**
 * jsvm.cpp — JS 运行时核心: js_task 事件循环 / VM 生命周期 / 模块注册表 / Callback
 *
 * 设计要点 (architecture.md §4):
 *   - js_task 是唯一执行 JS 的线程 (pinned core, 栈在 PSRAM);
 *   - 循环 = 取事件队列 → 执行 → 泵 Promise jobs → 检查定时器;
 *   - JS 堆走 PSRAM 自定义分配器, 上限 4MB (Kconfig 可调);
 *   - VM 支持 stop/restart (热更新), 通过中断处理器可打断 JS 死循环;
 *   - OOM 打印诊断并自动重启 VM。
 */
#include "jsvm_internal.hpp"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>
#include <unordered_set>
#include <vector>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hal_common/px_alloc.h"
#include "sdkconfig.h"

static const char *TAG = "jsvm";

namespace jsvm {

/* ------------------------------------------------------------
 * 内部状态
 * ------------------------------------------------------------ */

struct Callback::Ctrl {
    JSValue fn;
    uint32_t gen;
};

namespace {

constexpr uint32_t kInvalidGen = 0xFFFFFFFFu;

QueueHandle_t s_queue;
TaskHandle_t s_task;

JSRuntime *s_rt;
JSContext *s_ctx;

std::atomic<uint32_t> s_generation{0};
std::atomic<bool> s_vm_running{false};
std::atomic<bool> s_boot_req{false};
std::atomic<bool> s_restart_req{false};
std::atomic<bool> s_stop_req{false};
std::atomic<bool> s_interrupt_req{false};
std::atomic<size_t> s_mem_used{0};

VmStateListener s_state_listener;
EntryProvider s_entry_provider;

std::mutex s_hook_mutex;
std::vector<void (*)(JSContext *)> s_teardown_hooks;

std::vector<Module> &module_registry()
{
    /* Meyers 单例: 规避静态初始化顺序问题 (JSVM_REGISTER_MODULE 在静态构造期调用)。
     * 不设互斥: 写入全部在全局构造期 (单线程, 调度器未启动), 读取在 VM 启动后,
     * 天然串行; 且该阶段锁 std::mutex 会因 pthread 不可用抛异常直接 abort。 */
    static std::vector<Module> v;
    return v;
}

std::mutex s_cb_mutex;
std::unordered_set<Callback::Ctrl *> s_live_ctrls;

/* OOM 追踪 */
int s_oom_count = 0;
int64_t s_oom_first_us = 0;

/* ------------------------------------------------------------
 * PSRAM 自定义分配器 (JS 堆)
 * ------------------------------------------------------------ */

void *qjs_malloc(void *opaque, size_t size)
{
    (void)opaque;
    /* PSRAM 优先, 无 PSRAM 目标 (C6) 自动落内部堆 (hal_common/px_alloc.h) */
    void *p = px_alloc_prefer_psram(size);
    if (p) {
        s_mem_used += heap_caps_get_allocated_size(p);
    }
    return p;
}

void *qjs_calloc(void *opaque, size_t count, size_t size)
{
    (void)opaque;
    void *p = px_calloc_prefer_psram(count, size);
    if (p) {
        s_mem_used += heap_caps_get_allocated_size(p);
    }
    return p;
}

void qjs_free(void *opaque, void *ptr)
{
    (void)opaque;
    if (!ptr) {
        return;
    }
    s_mem_used -= heap_caps_get_allocated_size(ptr);
    heap_caps_free(ptr);
}

void *qjs_realloc(void *opaque, void *ptr, size_t size)
{
    if (!ptr) {
        return qjs_malloc(opaque, size);
    }
    if (size == 0) {
        qjs_free(opaque, ptr);
        return nullptr;
    }
    size_t old = heap_caps_get_allocated_size(ptr);
    void *p = px_realloc_prefer_psram(ptr, size);
    if (p) {
        s_mem_used -= old;
        s_mem_used += heap_caps_get_allocated_size(p);
    }
    return p;
}

size_t qjs_usable_size(const void *ptr)
{
    return heap_caps_get_allocated_size(const_cast<void *>(ptr));
}

/* ------------------------------------------------------------
 * 异常格式化 / OOM 诊断
 * ------------------------------------------------------------ */

void notify_state(VmState st, const char *err = nullptr)
{
    if (s_state_listener) {
        s_state_listener(st, err);
    }
}

void handle_possible_oom(const std::string &msg)
{
    if (msg.find("out of memory") == std::string::npos) {
        return;
    }
    int64_t now = esp_timer_get_time();
    if (s_oom_first_us == 0 || now - s_oom_first_us > 10 * 1000 * 1000) {
        s_oom_first_us = now;
        s_oom_count = 0;
    }
    s_oom_count++;
    if (s_rt) {
        JSMemoryUsage mu;
        JS_ComputeMemoryUsage(s_rt, &mu);
        ESP_LOGE(TAG,
                 "JS 堆 OOM 诊断: used=%lld B (limit=%u B), malloc_count=%lld, obj=%lld, "
                 "内部堆剩余=%u B, PSRAM 剩余=%u B",
                 (long long)mu.memory_used_size, (unsigned)js_heap_limit(),
                 (long long)mu.malloc_count, (long long)mu.obj_count,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
    if (s_oom_count >= 3) {
        ESP_LOGE(TAG, "JS 堆 OOM 连续发生 %d 次, 自动重启 VM", s_oom_count);
        s_oom_count = 0;
        s_restart_req = true;
    }
}

/** 把任意 JSValue (通常是异常) 变成可读字符串 (Error 附带栈) */
std::string value_error_string(JSContext *ctx, JSValueConst v)
{
    std::string out;
    const char *cs = JS_ToCString(ctx, v);
    if (cs) {
        out = cs;
        JS_FreeCString(ctx, cs);
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx)); /* 清掉 ToCString 的次生异常 */
        out = "(异常无法字符串化)";
    }
    if (JS_IsError(ctx, v)) {
        JSValue stack = JS_GetPropertyStr(ctx, v, "stack");
        if (JS_IsString(stack)) {
            const char *ss = JS_ToCString(ctx, stack);
            if (ss && *ss) {
                out += "\n";
                out += ss;
            }
            if (ss) {
                JS_FreeCString(ctx, ss);
            }
        }
        JS_FreeValue(ctx, stack);
    }
    return out;
}

/** 取出并格式化当前挂起异常 */
std::string format_exception(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);
    std::string out = value_error_string(ctx, exc);
    JS_FreeValue(ctx, exc);
    handle_possible_oom(out);
    return out;
}

/** eval 结果字符串化 (对象走 JSON.stringify, 失败回退 toString) */
std::string value_to_display_string(JSContext *ctx, JSValueConst v)
{
    if (JS_IsUndefined(v)) {
        return "undefined";
    }
    if (JS_IsObject(v) && !JS_IsFunction(ctx, v)) {
        JSValue json = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
        if (JS_IsString(json)) {
            const char *cs = JS_ToCString(ctx, json);
            std::string out = cs ? cs : "";
            if (cs) {
                JS_FreeCString(ctx, cs);
            }
            JS_FreeValue(ctx, json);
            return out;
        }
        JS_FreeValue(ctx, json);
        JS_FreeValue(ctx, JS_GetException(ctx)); /* 清掉 stringify 异常 (循环引用等) */
    }
    const char *cs = JS_ToCString(ctx, v);
    std::string out = cs ? cs : "(无法字符串化)";
    if (cs) {
        JS_FreeCString(ctx, cs);
    }
    return out;
}

/* ------------------------------------------------------------
 * QuickJS 回调
 * ------------------------------------------------------------ */

int interrupt_handler(JSRuntime *rt, void *opaque)
{
    (void)rt;
    (void)opaque;
    /* devd app.stop / 热更新可打断正在执行的 JS 死循环 */
    if (s_restart_req.load() || s_stop_req.load()) {
        return 1;
    }
    return s_interrupt_req.exchange(false) ? 1 : 0;
}

void promise_rejection_tracker(JSContext *ctx, JSValueConst promise,
                               JSValueConst reason, bool is_handled, void *opaque)
{
    (void)promise;
    (void)opaque;
    if (is_handled) {
        return;
    }
    std::string msg = "未处理的 Promise 拒绝: " + value_error_string(ctx, reason);
    internal::dispatch_log(3, "js", msg.c_str());
    handle_possible_oom(msg);
}

/* ------------------------------------------------------------
 * VM 生命周期 (仅 js_task 内调用)
 * ------------------------------------------------------------ */

void pump_jobs()
{
    if (!s_rt) {
        return;
    }
    JSContext *jctx = nullptr;
    int guard = 0;
    for (;;) {
        int r = JS_ExecutePendingJob(s_rt, &jctx);
        if (r == 0) {
            break;
        }
        if (r < 0) {
            std::string msg = "微任务异常: " + format_exception(jctx ? jctx : s_ctx);
            internal::dispatch_log(3, "js", msg.c_str());
        }
        if (++guard > 1024) {
            ESP_LOGW(TAG, "Promise job 连续执行超过 1024 次, 让出事件循环");
            break;
        }
    }
}

void teardown_vm(bool notify_stopped)
{
    if (!s_rt) {
        return;
    }
    ESP_LOGI(TAG, "停止 JS VM (generation %u)...", (unsigned)s_generation.load());
    /* 立即递增 generation: VM 停机期间 (stop/crash 后不 boot) 事件循环仍在
     * 消费队列, 旧 VM 在途任务的 gen 守卫必须即刻失效 —— 只在 boot 递增的话,
     * 停机窗口里 vm_generation() 仍等于旧代, 守卫被击穿后照样触碰已释放 runtime */
    s_generation++;

    /* 1. JS 收尾钩子 (app.onExit 等) */
    {
        std::vector<void (*)(JSContext *)> hooks;
        {
            std::lock_guard<std::mutex> lk(s_hook_mutex);
            hooks = s_teardown_hooks;
        }
        for (auto hook : hooks) {
            hook(s_ctx);
            if (JS_HasException(s_ctx)) {
                std::string msg = "onExit 收尾异常: " + format_exception(s_ctx);
                internal::dispatch_log(3, "js", msg.c_str());
            }
        }
    }

    /* 2. 释放定时器等标准全局资源 */
    internal::reset_std_state(s_ctx);

    /* 3. 释放所有存活 Callback 持有的 JS 函数, 并标记失效 */
    {
        std::lock_guard<std::mutex> lk(s_cb_mutex);
        for (auto *c : s_live_ctrls) {
            JS_FreeValue(s_ctx, c->fn);
            c->gen = kInvalidGen;
        }
        s_live_ctrls.clear();
    }

    s_vm_running = false;
    JSContext *ctx = s_ctx;
    JSRuntime *rt = s_rt;
    s_ctx = nullptr;
    s_rt = nullptr;
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    s_oom_count = 0;
    s_oom_first_us = 0;

    if (notify_stopped) {
        notify_state(VmState::Stopped);
    }
    ESP_LOGI(TAG, "JS VM 已停止 (分配器残留 %u 字节)", (unsigned)s_mem_used.load());
}

bool boot_vm()
{
    ESP_LOGI(TAG, "启动 JS VM (generation %u), 内部堆 %u B / PSRAM %u B 空闲",
             (unsigned)(s_generation.load() + 1),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));

    JSMallocFunctions mf = {};
    mf.js_calloc = qjs_calloc;
    mf.js_malloc = qjs_malloc;
    mf.js_free = qjs_free;
    mf.js_realloc = qjs_realloc;
    mf.js_malloc_usable_size = qjs_usable_size;

    s_rt = JS_NewRuntime2(&mf, nullptr);
    if (!s_rt) {
        ESP_LOGE(TAG, "JS 运行时创建失败");
        notify_state(VmState::Crashed, "JS 运行时创建失败");
        return false;
    }
    s_generation++;

    JS_SetMemoryLimit(s_rt, js_heap_limit());
    /* 栈检查阈值: 任务栈减去 12KB 原生余量 */
    size_t stack_bytes = (size_t)CONFIG_JSVM_TASK_STACK_KB * 1024;
    size_t js_stack = stack_bytes > 16 * 1024 ? stack_bytes - 12 * 1024 : stack_bytes / 2;
    JS_SetMaxStackSize(s_rt, js_stack);
    JS_UpdateStackTop(s_rt);
    JS_SetHostPromiseRejectionTracker(s_rt, promise_rejection_tracker, nullptr);
    JS_SetInterruptHandler(s_rt, interrupt_handler, nullptr);

    s_ctx = JS_NewContext(s_rt);
    if (!s_ctx) {
        ESP_LOGE(TAG, "JS 上下文创建失败");
        JS_FreeRuntime(s_rt);
        s_rt = nullptr;
        notify_state(VmState::Crashed, "JS 上下文创建失败");
        return false;
    }

    /* 标准全局 + px 根对象 + 模块 init/prelude */
    internal::install_std_globals(s_ctx);

    JSValue global = JS_GetGlobalObject(s_ctx);
    JSValue px = JS_NewObject(s_ctx);
    JS_SetPropertyStr(s_ctx, global, "px", JS_DupValue(s_ctx, px));
    JS_SetPropertyStr(s_ctx, global, "pixelbox", JS_DupValue(s_ctx, px));

    std::vector<Module> mods = module_registry();
    std::stable_sort(mods.begin(), mods.end(),
                     [](const Module &a, const Module &b) { return a.priority < b.priority; });

    for (const auto &m : mods) {
        if (m.init) {
            m.init(s_ctx, px);
            if (JS_HasException(s_ctx)) {
                std::string msg = std::string("模块 ") + m.name + " 初始化异常: " + format_exception(s_ctx);
                internal::dispatch_log(3, "js", msg.c_str());
            }
        }
    }
    for (const auto &m : mods) {
        if (m.prelude && m.prelude[0]) {
            std::string fname = std::string("<prelude:") + m.name + ">";
            JSValue r = JS_Eval(s_ctx, m.prelude, strlen(m.prelude), fname.c_str(), JS_EVAL_TYPE_GLOBAL);
            if (JS_IsException(r)) {
                std::string msg = std::string("模块 ") + m.name + " prelude 异常: " + format_exception(s_ctx);
                internal::dispatch_log(3, "js", msg.c_str());
            }
            JS_FreeValue(s_ctx, r);
        }
    }
    JS_FreeValue(s_ctx, px);
    JS_FreeValue(s_ctx, global);

    s_vm_running = true;
    notify_state(VmState::Running);

    /* 入口脚本 */
    EntrySource es;
    if (s_entry_provider && s_entry_provider(es)) {
        ESP_LOGI(TAG, "执行入口: %s (%u 字节)", es.filename.c_str(), (unsigned)es.source.size());
        JSValue r = JS_Eval(s_ctx, es.source.c_str(), es.source.size(),
                            es.filename.c_str(), JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(r)) {
            std::string err = "应用入口异常: " + format_exception(s_ctx);
            internal::dispatch_log(3, "js", err.c_str());
            JS_FreeValue(s_ctx, r);
            notify_state(VmState::Crashed, err.c_str());
            teardown_vm(false);
            return false;
        }
        JS_FreeValue(s_ctx, r);
    } else {
        ESP_LOGW(TAG, "无入口脚本, VM 空转等待推送");
    }
    pump_jobs();
    return true;
}

void run_one_job(std::function<void()> *job)
{
    (*job)();
    delete job;
    if (s_ctx && JS_HasException(s_ctx)) {
        std::string msg = "事件回调异常: " + format_exception(s_ctx);
        internal::dispatch_log(3, "js", msg.c_str());
    }
}

void js_task_main(void *arg)
{
    (void)arg;
    s_boot_req = true;
    for (;;) {
        if (s_boot_req.exchange(false) && !s_rt) {
            boot_vm();
        }

        /* 等待事件: 上限 50ms; 有更近的定时器/待执行 job 则相应缩短 */
        TickType_t wait = pdMS_TO_TICKS(50);
        if (s_rt) {
            int64_t dl = internal::next_timer_deadline_us();
            if (dl >= 0) {
                int64_t ms = (dl - esp_timer_get_time()) / 1000;
                if (ms < 0) {
                    ms = 0;
                } else if (ms > 50) {
                    ms = 50;
                }
                wait = pdMS_TO_TICKS(ms);
            }
            if (JS_IsJobPending(s_rt)) {
                wait = 0;
            }
        }

        /* 每次迭代只处理一个投递任务: 不做"排空式"批量消费 —— 生产速度
         * 高于消费时(如大屏帧 tick 渲染慢于投递周期)队列恒非空, 无界排水
         * 会永久跳过下方的微任务/定时器轮转, Promise 与 setTimeout 全部饿死 */
        std::function<void()> *job = nullptr;
        if (xQueueReceive(s_queue, &job, wait) == pdTRUE) {
            run_one_job(job);
        }

        if (s_rt) {
            pump_jobs();
            internal::run_due_timers(s_ctx);
            pump_jobs();
        }

        if (s_restart_req.exchange(false)) {
            s_stop_req = false;
            teardown_vm(false);
            s_boot_req = true;
        } else if (s_stop_req.exchange(false)) {
            teardown_vm(true);
        }
    }
}

void callback_ctrl_release(Callback::Ctrl *c)
{
    /* 可能在任意线程触发 (shared_ptr 归零), 投递到 JS 线程释放 JSValue */
    post([c] {
        bool owned;
        {
            std::lock_guard<std::mutex> lk(s_cb_mutex);
            owned = s_live_ctrls.erase(c) > 0;
        }
        if (owned && s_ctx && c->gen == s_generation.load()) {
            JS_FreeValue(s_ctx, c->fn);
        }
        delete c;
    });
}

} // namespace

/* ------------------------------------------------------------
 * 公开接口实现
 * ------------------------------------------------------------ */

esp_err_t start()
{
    if (s_task) {
        return ESP_OK;
    }
    s_queue = xQueueCreate(CONFIG_JSVM_QUEUE_DEPTH, sizeof(void *));
    if (!s_queue) {
        return ESP_ERR_NO_MEM;
    }

    size_t stack_bytes = (size_t)CONFIG_JSVM_TASK_STACK_KB * 1024;
    static StaticTask_t s_tcb; /* TCB 必须在内部 RAM (静态区) */
    /* 栈默认放内部 RAM: js_task 直接执行 littlefs 读写 (应用加载/readAsset/
     * px.storage.fs), flash 操作期间 cache 关闭, PSRAM 栈会崩溃 (见 Kconfig) */
    StackType_t *stack = nullptr;
#if CONFIG_JSVM_TASK_STACK_IN_PSRAM
    stack = static_cast<StackType_t *>(
        heap_caps_malloc(stack_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!stack) {
        ESP_LOGW(TAG, "js_task 栈 PSRAM 分配失败, 回退内部 RAM");
    }
#endif
    if (!stack) {
        stack = static_cast<StackType_t *>(
            heap_caps_malloc(stack_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    }
    if (!stack) {
        vQueueDelete(s_queue);
        s_queue = nullptr;
        return ESP_ERR_NO_MEM;
    }

    s_task = xTaskCreateStaticPinnedToCore(js_task_main, "js_task",
                                           stack_bytes / sizeof(StackType_t), nullptr,
                                           CONFIG_JSVM_TASK_PRIORITY, stack, &s_tcb,
                                           CONFIG_JSVM_TASK_CORE);
    if (!s_task) {
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "js_task 已启动 (core %d, 栈 %dKB, JS 堆上限 %dKB)",
             CONFIG_JSVM_TASK_CORE, CONFIG_JSVM_TASK_STACK_KB, CONFIG_JSVM_MEM_LIMIT_KB);
    return ESP_OK;
}

void request_restart()
{
    s_restart_req = true;
    post([] {}); /* 唤醒事件循环 */
}

void request_stop()
{
    s_stop_req = true;
    post([] {});
}

bool vm_running()
{
    return s_vm_running.load();
}

void set_vm_state_listener(VmStateListener l)
{
    s_state_listener = l;
}

void set_entry_provider(EntryProvider p)
{
    s_entry_provider = p;
}

void post(std::function<void()> fn)
{
    if (!s_queue) {
        ESP_LOGE(TAG, "post: jsvm 尚未启动, 丢弃投递");
        return;
    }
    auto *job = new std::function<void()>(std::move(fn));
    if (xQueueSend(s_queue, &job, pdMS_TO_TICKS(200)) != pdTRUE) {
        ESP_LOGE(TAG, "事件队列已满, 丢弃投递");
        delete job;
    }
}

bool is_js_thread()
{
    return s_task && xTaskGetCurrentTaskHandle() == s_task;
}

JSContext *context()
{
    return s_ctx;
}

uint32_t vm_generation()
{
    return s_generation.load();
}

void register_module(const Module &m)
{
    /* 仅限静态构造期调用 (见 jsvm.hpp 声明处约定), 此阶段禁止加锁 */
    module_registry().push_back(m);
}

void add_teardown_hook(void (*hook)(JSContext *))
{
    std::lock_guard<std::mutex> lk(s_hook_mutex);
    s_teardown_hooks.push_back(hook);
}

void eval(std::string code, std::function<void(bool, std::string)> done)
{
    post([code = std::move(code), done = std::move(done)] {
        if (!s_ctx) {
            if (done) {
                done(false, "VM 未运行");
            }
            return;
        }
        JSValue r = JS_Eval(s_ctx, code.c_str(), code.size(), "<devd:eval>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(r)) {
            std::string err = format_exception(s_ctx);
            JS_FreeValue(s_ctx, r);
            if (done) {
                done(false, err);
            }
            return;
        }
        std::string out = value_to_display_string(s_ctx, r);
        JS_FreeValue(s_ctx, r);
        if (done) {
            done(true, out);
        }
    });
}

size_t js_heap_used()
{
    return s_mem_used.load();
}

size_t js_heap_limit()
{
    return (size_t)CONFIG_JSVM_MEM_LIMIT_KB * 1024;
}

JSValue throw_enotsup(JSContext *ctx)
{
    JSValue e = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, "ENOTSUP"),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw(ctx, e);
}

bool get_binary(JSContext *ctx, JSValueConst v, const uint8_t **data, size_t *len)
{
    size_t sz = 0;
    uint8_t *p = JS_GetArrayBuffer(ctx, &sz, v);
    if (p) {
        *data = p;
        *len = sz;
        return true;
    }
    JS_FreeValue(ctx, JS_GetException(ctx)); /* 清掉 GetArrayBuffer 的异常 */
    p = JS_GetUint8Array(ctx, &sz, v);
    if (p) {
        *data = p;
        *len = sz;
        return true;
    }
    JS_FreeValue(ctx, JS_GetException(ctx));
    JS_ThrowTypeError(ctx, "参数需要 ArrayBuffer 或 Uint8Array");
    return false;
}

void dump_error(JSContext *ctx)
{
    if (!JS_HasException(ctx)) {
        return;
    }
    std::string msg = "未捕获异常: " + format_exception(ctx);
    internal::dispatch_log(3, "js", msg.c_str());
}

/* ------------------------------------------------------------
 * Callback
 * ------------------------------------------------------------ */

Callback::Callback(JSContext *ctx, JSValueConst fn)
{
    if (!JS_IsFunction(ctx, fn)) {
        return;
    }
    auto *c = new Ctrl{JS_DupValue(ctx, fn), s_generation.load()};
    {
        std::lock_guard<std::mutex> lk(s_cb_mutex);
        s_live_ctrls.insert(c);
    }
    ctrl_ = std::shared_ptr<Ctrl>(c, callback_ctrl_release);
}

void Callback::invoke_with(ArgBuilder builder) const
{
    if (!ctrl_) {
        return;
    }
    auto c = ctrl_;
    post([c, builder = std::move(builder)] {
        if (!s_ctx) {
            return;
        }
        {
            std::lock_guard<std::mutex> lk(s_cb_mutex);
            if (s_live_ctrls.count(c.get()) == 0) {
                return; /* VM 已重启, 回调失效 */
            }
        }
        if (c->gen != s_generation.load()) {
            return;
        }
        JSValue argv[kMaxArgs];
        int argc = 0;
        if (builder) {
            argc = builder(s_ctx, argv);
            if (argc < 0) {
                argc = 0;
            }
            if (argc > kMaxArgs) {
                argc = kMaxArgs;
            }
        }
        JSValue ret = JS_Call(s_ctx, c->fn, JS_UNDEFINED, argc, argv);
        for (int i = 0; i < argc; i++) {
            JS_FreeValue(s_ctx, argv[i]);
        }
        if (JS_IsException(ret)) {
            dump_error(s_ctx);
        }
        JS_FreeValue(s_ctx, ret);
    });
}

} // namespace jsvm
