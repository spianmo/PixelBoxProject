/**
 * jsvm.cpp — JS 运行时核心: js_task 事件循环 / VM 生命周期 / 模块注册表 / Callback
 *
 * 设计要点 (architecture.md §4):
 *   - js_task is the only JS thread; its stack defaults to internal RAM;
 *   - loop: latest input / due frames / bounded events, timers and Promise jobs;
 *   - JS 堆走 PSRAM 自定义分配器, 上限 4MB (Kconfig 可调);
 *   - VM 支持 stop/restart (热更新), 通过中断处理器可打断 JS 死循环;
 *   - OOM 打印诊断并自动重启 VM。
 */
#include "jsvm_internal.hpp"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>
#include <new>
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

struct Value::Ctrl {
    JSValue fn;
    uint32_t gen;
    Ctrl *release_next = nullptr;
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

std::mutex s_release_mutex;
std::unordered_set<Callback::Ctrl *> s_live_ctrls;
Callback::Ctrl *s_pending_releases = nullptr;
std::vector<LoopSource> s_loop_sources;
int64_t s_execution_deadline_us = 0;
bool s_timeout_counted = false;
uint32_t s_execution_timeouts = 0;
std::atomic<uint32_t> s_dropped_jobs{0};
std::atomic<uint32_t> s_queue_peak{0};
int64_t s_max_turn_us = 0, s_max_source_us = 0, s_max_job_us = 0;

class ExecutionScope {
public:
    explicit ExecutionScope(int multiplier = 1) : outer_(s_execution_deadline_us == 0) {
        if (outer_) {
            s_timeout_counted = false;
            s_execution_deadline_us = esp_timer_get_time() +
                int64_t(CONFIG_JSVM_EXECUTION_TIMEOUT_MS) * 1000 * multiplier;
        }
    }
    ~ExecutionScope() { if (outer_) s_execution_deadline_us = 0; }
private:
    bool outer_;
};

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

std::mutex s_err_sink_mutex;
std::vector<ErrorSink> s_err_sinks;

/**
 * 未捕获异常的统一出口: 照旧打 E 级日志 (文案不变, devd/探针按文案匹配),
 * 再通知 sink —— 屏幕上的报错卡片就挂在这里。
 */
void report_js_error(const char *origin, const std::string &msg, bool fatal = false)
{
    internal::dispatch_log(3, "js", msg.c_str());
    std::vector<ErrorSink> sinks;
    {
        std::lock_guard<std::mutex> lk(s_err_sink_mutex);
        sinks = s_err_sinks;
    }
    for (auto sink : sinks) {
        sink(origin, msg.c_str(), fatal);
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
    if (s_execution_deadline_us && esp_timer_get_time() >= s_execution_deadline_us) {
        if (!s_timeout_counted) { ++s_execution_timeouts; s_timeout_counted = true; }
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
    report_js_error("Promise 拒绝", msg);
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
    const int64_t deadline = esp_timer_get_time() + 2000;
    for (int guard = 0; guard < 32 && !stopping(); ++guard) {
        ExecutionScope execution;
        int r = JS_ExecutePendingJob(s_rt, &jctx);
        if (r == 0) {
            break;
        }
        if (r < 0) {
            std::string msg = "微任务异常: " + format_exception(jctx ? jctx : s_ctx);
            report_js_error("微任务", msg);
        }
        if (esp_timer_get_time() >= deadline) break;
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
            ExecutionScope execution;
            hook(s_ctx);
            if (JS_HasException(s_ctx)) {
                std::string msg = "onExit 收尾异常: " + format_exception(s_ctx);
                report_js_error("onExit", msg);
            }
        }
    }

    /* 2. 释放定时器等标准全局资源 */
    internal::reset_std_state(s_ctx);

    /* 3. 释放所有存活 Callback 持有的 JS 函数, 并标记失效 */
    {
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
                report_js_error("模块初始化", msg);
            }
        }
    }
    for (const auto &m : mods) {
        if (m.prelude && m.prelude[0]) {
            std::string fname = std::string("<prelude:") + m.name + ">";
            JSValue r = JS_Eval(s_ctx, m.prelude, strlen(m.prelude), fname.c_str(), JS_EVAL_TYPE_GLOBAL);
            if (JS_IsException(r)) {
                std::string msg = std::string("模块 ") + m.name + " prelude 异常: " + format_exception(s_ctx);
                report_js_error("模块 prelude", msg);
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
        ExecutionScope execution(10);
        JSValue r = JS_Eval(s_ctx, es.source.c_str(), es.source.size(),
                            es.filename.c_str(), JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(r)) {
            std::string err = "应用入口异常: " + format_exception(s_ctx);
            report_js_error("应用入口", err, true);
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
    const int64_t start = esp_timer_get_time();
    ExecutionScope execution;
    (*job)();
    delete job;
    if (s_ctx && JS_HasException(s_ctx)) {
        std::string msg = "事件回调异常: " + format_exception(s_ctx);
        report_js_error("事件回调", msg);
    }
    s_max_job_us = std::max(s_max_job_us, esp_timer_get_time() - start);
}

void drain_callback_releases()
{
    Callback::Ctrl *pending;
    {
        std::lock_guard<std::mutex> lk(s_release_mutex);
        pending = s_pending_releases;
        s_pending_releases = nullptr;
    }
    while (pending) {
        auto *c = pending;
        pending = c->release_next;
        if (s_live_ctrls.erase(c) && s_ctx && c->gen == s_generation.load()) {
            JS_FreeValue(s_ctx, c->fn);
        }
        delete c;
    }
}

void run_loop_turn()
{
    const int64_t start = esp_timer_get_time();
    drain_callback_releases();
    if (s_ctx && !stopping()) {
        for (const auto &source : s_loop_sources) {
            if (stopping()) break;
            const int64_t due = source.deadline();
            if (due >= 0 && due <= esp_timer_get_time()) {
                const int64_t source_start = esp_timer_get_time();
                ExecutionScope execution;
                source.run(s_ctx);
                dump_error(s_ctx);
                s_max_source_us = std::max(s_max_source_us, esp_timer_get_time() - source_start);
            }
        }
    }
    const int64_t deadline = esp_timer_get_time() + 2000;
    for (int i = 0; i < 4 && !stopping(); ++i) {
        std::function<void()> *job = nullptr;
        if (xQueueReceive(s_queue, &job, 0) != pdTRUE) break;
        run_one_job(job);
        pump_jobs();
        if (esp_timer_get_time() >= deadline) break;
    }
    if (s_ctx && !stopping()) {
        internal::run_due_timers(s_ctx);
        pump_jobs();
    }
    s_max_turn_us = std::max(s_max_turn_us, esp_timer_get_time() - start);
}

TickType_t loop_wait_ticks()
{
    if (stopping() || s_boot_req.load() || uxQueueMessagesWaiting(s_queue)) return 0;
    int64_t deadline = esp_timer_get_time() + 50000;
    if (s_rt) {
        if (JS_IsJobPending(s_rt)) return 0;
        const int64_t timer = internal::next_timer_deadline_us();
        if (timer >= 0) deadline = std::min(deadline, timer);
        for (const auto &source : s_loop_sources) {
            const int64_t due = source.deadline();
            if (due >= 0) deadline = std::min(deadline, due);
        }
    }
    const int64_t remaining = deadline - esp_timer_get_time();
    // Round up: sub-tick waits must not turn into a busy loop.
    return remaining <= 0 ? 0 : (remaining * configTICK_RATE_HZ + 999999) / 1000000;
}

void js_task_main(void *arg)
{
    (void)arg;
    s_boot_req = true;
    int64_t last_yield = esp_timer_get_time();
    for (;;) {
        if (s_restart_req.exchange(false)) {
            s_stop_req = false;
            teardown_vm(false);
            s_boot_req = true;
        } else if (s_stop_req.exchange(false)) {
            s_boot_req = false;
            teardown_vm(true);
        }
        if (s_boot_req.exchange(false) && !s_rt) boot_vm();
        run_loop_turn();
        // A continuously busy app must still let the idle task feed its watchdog.
        if (esp_timer_get_time() - last_yield >= 10000) {
            vTaskDelay(1);
            last_yield = esp_timer_get_time();
        }
        ulTaskNotifyTake(pdTRUE, loop_wait_ticks());
    }
}

void callback_ctrl_release(Callback::Ctrl *c)
{
    // Intrusive retire list: releasing a callback must never allocate, block on
    // its own event queue, or leak when that queue is full.
    {
        std::lock_guard<std::mutex> lk(s_release_mutex);
        c->release_next = s_pending_releases;
        s_pending_releases = c;
    }
    wake();
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
    wake();
}

void request_stop()
{
    s_stop_req = true;
    wake();
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

bool post(std::function<void()> fn, uint32_t timeout_ms)
{
    if (!s_queue) {
        ESP_LOGE(TAG, "post: jsvm 尚未启动, 丢弃投递");
        return false;
    }
    auto *job = new (std::nothrow) std::function<void()>(std::move(fn));
    if (!job) { s_dropped_jobs.fetch_add(1, std::memory_order_relaxed); return false; }
    // The consumer cannot make room while blocked inside its own producer call.
    const TickType_t wait = is_js_thread() ? 0 : pdMS_TO_TICKS(timeout_ms);
    if (xQueueSend(s_queue, &job, wait) != pdTRUE) {
        s_dropped_jobs.fetch_add(1, std::memory_order_relaxed);
        if (timeout_ms) ESP_LOGE(TAG, "事件队列已满, 丢弃投递");
        delete job;
        return false;
    }
    const uint32_t depth = uxQueueMessagesWaiting(s_queue);
    uint32_t peak = s_queue_peak.load(std::memory_order_relaxed);
    while (depth > peak && !s_queue_peak.compare_exchange_weak(peak, depth, std::memory_order_relaxed)) {}
    wake();
    return true;
}

void wake()
{
    if (s_task) xTaskNotifyGive(s_task);
}

bool stopping() { return s_restart_req.load() || s_stop_req.load(); }

RuntimeStats runtime_stats()
{
    return {s_queue ? uint32_t(uxQueueMessagesWaiting(s_queue)) : 0,
        s_queue_peak.load(std::memory_order_relaxed), s_dropped_jobs.load(std::memory_order_relaxed),
        s_execution_timeouts, s_max_turn_us, s_max_source_us, s_max_job_us};
}

void add_loop_source(const LoopSource &source)
{
    for (const auto &existing : s_loop_sources) {
        if (existing.run == source.run) return;
    }
    s_loop_sources.push_back(source);
    std::stable_sort(s_loop_sources.begin(), s_loop_sources.end(),
        [](const LoopSource &a, const LoopSource &b) { return a.priority < b.priority; });
}

JSValue call(JSContext *ctx, JSValueConst fn, JSValueConst this_val,
             int argc, JSValueConst *argv)
{
    ExecutionScope execution;
    return JS_Call(ctx, fn, this_val, argc, argv);
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
    /* 调用方遍布 onFrame / 定时器 / BLE / voice 等原生回调点, 统称"回调" */
    report_js_error("回调", msg);
}

void add_error_sink(ErrorSink sink)
{
    if (!sink) {
        return;
    }
    std::lock_guard<std::mutex> lk(s_err_sink_mutex);
    s_err_sinks.push_back(sink);
}

/* ------------------------------------------------------------
 * Callback
 * ------------------------------------------------------------ */

Value::Value(JSContext *ctx, JSValueConst fn)
{
    auto *c = new Ctrl{JS_DupValue(ctx, fn), s_generation.load()};
    s_live_ctrls.insert(c);
    ctrl_ = std::shared_ptr<Ctrl>(c, callback_ctrl_release);
}

JSValueConst Value::get() const
{
    return s_ctx && ctrl_ && ctrl_->gen == s_generation.load() ? ctrl_->fn : JS_UNDEFINED;
}

Callback::Callback(JSContext *ctx, JSValueConst fn)
{
    if (JS_IsFunction(ctx, fn)) ctrl_ = Value(ctx, fn).ctrl_;
}

void Callback::invoke_with(ArgBuilder builder) const
{
    invoke_with_timeout(std::move(builder), 200);
}

bool Callback::try_invoke_with(ArgBuilder builder) const
{
    return invoke_with_timeout(std::move(builder), 0);
}

bool Callback::invoke_with_timeout(ArgBuilder builder, uint32_t timeout_ms) const
{
    if (!ctrl_) {
        return false;
    }
    return post([cb = *this, builder = std::move(builder)] {
        cb.invoke_now(builder);
    }, timeout_ms);
}

void Callback::invoke_now(const ArgBuilder &builder) const
{
    auto c = ctrl_; // Keep the function alive if the callback unsubscribes itself.
    if (!s_ctx || !c || c->gen != s_generation.load()) return;
    JSValue argv[kMaxArgs] = {JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED};
    int argc = builder ? std::clamp(builder(s_ctx, argv), 0, kMaxArgs) : 0;
    JSValue ret = JS_HasException(s_ctx) ? JS_EXCEPTION :
        call(s_ctx, c->fn, JS_UNDEFINED, argc, argv);
    for (auto &arg : argv) JS_FreeValue(s_ctx, arg);
    if (JS_IsException(ret)) dump_error(s_ctx);
    JS_FreeValue(s_ctx, ret);
}

} // namespace jsvm
