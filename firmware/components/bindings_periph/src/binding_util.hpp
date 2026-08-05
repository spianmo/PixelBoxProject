/**
 * binding_util.hpp — bindings_periph 内部共用小工具
 *
 * 约定:
 *   - 所有 JSValue 操作只发生在 JS 线程(jsvm::post / jsvm::Callback 保证)
 *   - 订阅回调统一走 CallbackRegistry, 返回的 Unsubscribe 闭包幂等
 *   - Promise 统一用 PromisePair(内部为 jsvm::Callback, VM 重启自动失效)
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "jsvm/jsvm.hpp"
#include "quickjs.h"

namespace pxb {

// ---------------------------------------------------------------
// 订阅回调注册表
// ---------------------------------------------------------------

/**
 * 线程安全的订阅回调表。
 * add/remove 在 JS 线程调用;invoke_all 可从任意任务调用
 * (jsvm::Callback 内部投递到 JS 线程)。
 */
class CallbackRegistry {
public:
    /** JS 线程:登记回调, 返回订阅 id */
    uint64_t add(JSContext* ctx, JSValueConst fn) {
        std::lock_guard<std::mutex> lk(mtx_);
        uint64_t id = next_id_++;
        entries_.emplace_back(id, jsvm::Callback(ctx, fn));
        count_.store(static_cast<int>(entries_.size()), std::memory_order_relaxed);
        return id;
    }

    /** 移除订阅(幂等) */
    void remove(uint64_t id) {
        std::lock_guard<std::mutex> lk(mtx_);
        for (auto it = entries_.begin(); it != entries_.end(); ++it) {
            if (it->first == id) {
                entries_.erase(it);
                break;
            }
        }
        count_.store(static_cast<int>(entries_.size()), std::memory_order_relaxed);
    }

    /** 清空(模块 init 时清掉上一代 VM 的残留订阅) */
    void clear() {
        std::lock_guard<std::mutex> lk(mtx_);
        entries_.clear();
        count_.store(0, std::memory_order_relaxed);
    }

    /** 驱动任务用的快速判断:有无订阅者 */
    bool active() const { return count_.load(std::memory_order_relaxed) > 0; }

    /** 任意线程:向全部订阅者投递一次调用 */
    void invoke_all(const jsvm::Callback::ArgBuilder& builder) {
        std::vector<jsvm::Callback> snapshot;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            snapshot.reserve(entries_.size());
            for (auto& e : entries_) snapshot.push_back(e.second);
        }
        for (auto& cb : snapshot) cb.invoke_with(builder);
    }

private:
    mutable std::mutex mtx_;
    std::vector<std::pair<uint64_t, jsvm::Callback>> entries_;
    uint64_t next_id_ = 1;
    std::atomic<int> count_{0};
};

/**
 * 生成 Unsubscribe 闭包:调用即从 reg 移除 id。
 * reg 必须是静态生命周期对象(本组件的注册表均为文件级 static)。
 */
JSValue make_unsubscribe(JSContext* ctx, CallbackRegistry* reg, uint64_t id);

// ---------------------------------------------------------------
// Promise
// ---------------------------------------------------------------

/** 线程安全的 promise 决议句柄(VM 重启后 invoke 自动失效) */
struct PromisePair {
    jsvm::Callback resolve;
    jsvm::Callback reject;

    /** 任意线程:以 Error(msg) 拒绝 */
    void reject_error(std::string msg) const;
    /** 任意线程:以 undefined 完成 */
    void resolve_undefined() const;
    /** 任意线程:以 builder 构造的首个参数完成 */
    void resolve_with(jsvm::Callback::ArgBuilder builder) const { resolve.invoke_with(std::move(builder)); }
};

/** JS 线程:创建 promise 并填充决议句柄 */
JSValue make_promise(JSContext* ctx, PromisePair& out);

// ---------------------------------------------------------------
// 参数/属性工具(JS 线程)
// ---------------------------------------------------------------

/** 读对象字符串属性;不存在/非串返回 false */
bool opt_string(JSContext* ctx, JSValueConst obj, const char* prop, std::string& out);

/** 读对象数值属性, 缺省返回 defv */
double opt_number(JSContext* ctx, JSValueConst obj, const char* prop, double defv);

/** 读对象布尔属性, 缺省返回 defv */
bool opt_bool(JSContext* ctx, JSValueConst obj, const char* prop, bool defv);

/** 读对象函数属性(dup 为 Callback);非函数返回无效 Callback */
jsvm::Callback opt_callback(JSContext* ctx, JSValueConst obj, const char* prop);

/** 任意 JSValue → std::string(内部 JS_ToCString) */
bool to_string(JSContext* ctx, JSValueConst v, std::string& out);

/** BinaryLike → 拷贝到 vector(失败已抛 TypeError) */
bool get_binary_copy(JSContext* ctx, JSValueConst v, std::vector<uint8_t>& out);

/** vector → ArrayBuffer(拷贝) */
JSValue ab_from_vec(JSContext* ctx, const std::vector<uint8_t>& v);

/** 在 obj 上定义方法 */
void def_fn(JSContext* ctx, JSValueConst obj, const char* name, JSCFunction* fn, int nargs);

}  // namespace pxb
