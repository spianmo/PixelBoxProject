/**
 * jsvm/jsvm.hpp — PixelBox JS 运行时公开接口 (architecture.md §4.1)
 *
 * 线程模型:
 *   - js_task (pinned core 1) 是唯一执行 JS 的线程;
 *   - 其他任务通过 jsvm::post() / jsvm::Callback 与 JS 交互,
 *     禁止跨线程直接调用 JS_* API。
 *
 * 模块注册:
 *   - 每个 bindings_* 组件用 JSVM_REGISTER_MODULE 静态自注册;
 *   - 组件需在 idf_component_register 加 WHOLE_ARCHIVE 防止链接器裁剪;
 *   - native init 直接在 px 根对象上挂域对象与最终公开方法 (与 d.ts 对齐);
 *   - prelude 片段在所有 native init 之后按 priority 顺序执行 (纯 JS 糖)。
 */
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "esp_err.h"
#include "quickjs.h"

namespace jsvm {

/* ------------------------------------------------------------
 * 生命周期
 * ------------------------------------------------------------ */

/** 创建 js_task 并启动 VM (入口脚本由 entry provider 提供, 见下) */
esp_err_t start();

/** 热重启 VM (异步; 可从任意线程调用; 能打断正在执行的 JS 死循环) */
void request_restart();

/** 停止 VM (异步; 固件保持运行等待新应用推送) */
void request_stop();

/** VM 是否运行中 */
bool vm_running();

/** VM 状态 (appmgr 映射为 devd 的 app.state 事件) */
enum class VmState {
    Stopped,  /*!< 已停止 */
    Running,  /*!< 运行中 */
    Crashed,  /*!< 入口异常 / OOM 等致命错误 */
};
using VmStateListener = void (*)(VmState state, const char *error_msg /*可为 NULL*/);
void set_vm_state_listener(VmStateListener l);

/** 入口脚本提供者 (appmgr 设置): 返回 false 表示无入口 (VM 空转等待) */
struct EntrySource {
    std::string source;
    std::string filename;
};
using EntryProvider = bool (*)(EntrySource &out);
void set_entry_provider(EntryProvider p);

/* ------------------------------------------------------------
 * 线程模型
 * ------------------------------------------------------------ */

/** 线程安全: 把 fn 投递到 JS 线程执行 (队列满时丢弃并打印错误) */
void post(std::function<void()> fn);

/** 当前是否处于 JS 线程 */
bool is_js_thread();

/** 当前 JSContext — 仅限 JS 线程内使用; VM 未运行时为 nullptr */
JSContext *context();

/** VM 代数 (每次 boot 自增; 用于判定跨重启的陈旧句柄) */
uint32_t vm_generation();

/* ------------------------------------------------------------
 * Callback — JS 回调句柄
 *
 * 构造时 (JS 线程) dup 持有 JS 函数; 可从任意线程 invoke,
 * 内部经 post() 投递到 JS 线程; VM 重启后自动失效 (静默跳过)。
 * ------------------------------------------------------------ */

class Callback {
public:
    /** 单次调用最多传入的参数个数 */
    static constexpr int kMaxArgs = 4;

    /**
     * 参数构造器: 在 JS 线程执行, 向 argv (容量 kMaxArgs) 填参数并返回 argc。
     * 填入的 JSValue 调用后由框架释放。
     */
    using ArgBuilder = std::function<int(JSContext *ctx, JSValue *argv)>;

    Callback() = default;
    /** 仅 JS 线程: 持有 (dup) fn; fn 必须可调用 */
    Callback(JSContext *ctx, JSValueConst fn);

    /** 任意线程: 投递调用, builder 在 JS 线程内构造参数 (可为空 = 无参) */
    void invoke_with(ArgBuilder builder) const;
    /** 任意线程: 无参调用 */
    void invoke() const { invoke_with(nullptr); }

    /** 是否持有有效回调 */
    explicit operator bool() const { return static_cast<bool>(ctrl_); }
    /** 释放引用 (任意线程; 实际 JSValue 释放会投递回 JS 线程) */
    void reset() { ctrl_.reset(); }

    struct Ctrl; /* 内部控制块 */

private:
    std::shared_ptr<Ctrl> ctrl_;
};

/* ------------------------------------------------------------
 * 模块注册表
 * ------------------------------------------------------------ */

/** native 初始化: 在 px 根对象上挂域对象与方法 */
using NativeInit = void (*)(JSContext *ctx, JSValue px);

struct Module {
    const char *name;     /*!< 域名, 如 "screen" */
    int priority;         /*!< 小者先初始化; core=0, hal 域=10 */
    NativeInit init;      /*!< native 初始化 (可为 nullptr, 仅 prelude) */
    const char *prelude;  /*!< 可选 JS 增强片段 (所有 native init 后按 priority 执行) */
};

/** 静态构造期调用 (JSVM_REGISTER_MODULE 宏内部使用) */
void register_module(const Module &m);

namespace detail {
struct ModuleRegistrar {
    explicit ModuleRegistrar(const Module &m) { register_module(m); }
};
} // namespace detail

#define JSVM_CONCAT_INNER_(a, b) a##b
#define JSVM_CONCAT_(a, b) JSVM_CONCAT_INNER_(a, b)
/** 组件内静态自注册一个模块 (组件需 WHOLE_ARCHIVE) */
#define JSVM_REGISTER_MODULE(mod) \
    static ::jsvm::detail::ModuleRegistrar JSVM_CONCAT_(s_jsvm_module_reg_, __COUNTER__)((mod))

/* ------------------------------------------------------------
 * 钩子 / 观测
 * ------------------------------------------------------------ */

/**
 * VM 拆除前钩子 (JS 线程内调用, ctx 仍有效):
 * 供 app 模块执行 onExit 回调等 JS 收尾。全局注册一次, 每次热重启都会触发。
 */
void add_teardown_hook(void (*hook)(JSContext *ctx));

/**
 * console 结构化日志 sink (devd 转发用)。
 * level: 0=debug 1=info/log 2=warn 3=error; 在 JS 线程回调。
 */
using LogSink = void (*)(int level, const char *tag, const char *msg);
void add_log_sink(LogSink sink);

/**
 * 线程安全求值 (devd js.eval): done 在 JS 线程回调,
 * ok=false 时 result 为异常描述 (含栈)。
 */
void eval(std::string code, std::function<void(bool ok, std::string result)> done);

/** JS 堆已用字节数 (自定义分配器统计, px.system.memory().jsHeapUsed) */
size_t js_heap_used();
/** JS 堆上限字节数 */
size_t js_heap_limit();

/* ------------------------------------------------------------
 * JS 线程内工具 (供各 bindings 组件复用)
 * ------------------------------------------------------------ */

/** 抛出 Error("ENOTSUP") (硬件未启用时的契约行为) */
JSValue throw_enotsup(JSContext *ctx);

/**
 * 解析 BinaryLike (ArrayBuffer | Uint8Array) → 指针+长度。
 * 失败时抛 TypeError 并返回 false。返回的指针仅在当次调用内有效。
 */
bool get_binary(JSContext *ctx, JSValueConst v, const uint8_t **data, size_t *len);

/** 打印并清除当前挂起的 JS 异常 (含栈, 输出到 console/devd) */
void dump_error(JSContext *ctx);

} // namespace jsvm
