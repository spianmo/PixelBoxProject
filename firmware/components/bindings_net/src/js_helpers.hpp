/**
 * js_helpers.hpp — bindings_net 内部共享的 QuickJS 辅助工具
 *
 * 核心纪律(architecture.md §4.1 / §10):
 *   - 只有 JS 线程可以调用 JS_* API
 *   - 任意线程想触碰 JS,必须经 pxjs::run_on_js()(封装 jsvm::post)
 */
#pragma once

#include <cstdarg>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "quickjs.h"

namespace pxjs {

/** 当前 VM 的 JSContext(由本组件任一模块 init 时记录;VM 重启会刷新) */
extern JSContext* g_ctx;
void set_ctx(JSContext* ctx);

/** 把闭包投递到 JS 线程执行(封装 jsvm::post,可从任意任务调用) */
void run_on_js(std::function<void()> fn);

/**
 * VM 是否已热重启(gen = 对象创建时记下的 jsvm::vm_generation())。
 * 判断"投递回 JS 线程的旧对象是否失效"必须用它,不能比较 ctx 指针:
 * 新 VM 的 JSContext 大概率复用旧堆地址,指针守卫会放行对已释放
 * runtime 的 JS_Call → 堆损坏。
 */
bool vm_stale(uint32_t gen);

/** PSRAM 优先分配(失败回落内部 RAM);配套 psram_free */
uint8_t* psram_alloc(size_t size);
void psram_free(void* p);

// ------------------------------------------------------------ Promise

/**
 * 跨线程可 settle 的 Promise 包装。
 * create() 仅 JS 线程调用;resolve_on_js/reject_msg 可从任意线程调用,
 * 内部经事件循环投递。settle 一次后再次调用为空操作。
 *
 * 失效判定用 VM generation 号,不能用 ctx 指针相等:VM 热重启后新 JSContext
 * 大概率复用旧堆地址(teardown 后紧接 boot 的同尺寸首分配),指针守卫会放行
 * 旧 VM 的 settle,对已释放 runtime 调 JS_Call → 堆损坏(真机"切设置页黑屏"元凶)。
 */
struct Promise : std::enable_shared_from_this<Promise> {
  JSContext* ctx = nullptr;
  uint32_t gen = 0;  /* 创建时的 jsvm::vm_generation() */
  JSValue resolve = JS_UNDEFINED;
  JSValue reject = JS_UNDEFINED;
  bool settled = false;

  /** 创建 Promise,*out_promise 为要返回给 JS 的 promise 值 */
  static std::shared_ptr<Promise> create(JSContext* ctx, JSValue* out_promise);

  /** JS 线程:立刻 resolve(消费 v) */
  void resolve_now(JSValue v);
  /** JS 线程:立刻 reject(消费 err) */
  void reject_now(JSValue err);
  /** 任意线程:投递到 JS 线程后用 make(ctx) 的返回值 resolve */
  void resolve_on_js(std::function<JSValue(JSContext*)> make);
  /** 任意线程:以 Error(msg) reject */
  void reject_msg(std::string msg);

  ~Promise();
};
using PromisePtr = std::shared_ptr<Promise>;

// ------------------------------------------------------------ JS 回调持有器

/**
 * 持有一个 dup 过的 JS 函数,只允许在 JS 线程调用;
 * 析构时经 run_on_js 释放引用(可在任意线程析构)。
 */
class JsFunc {
 public:
  /** 仅 JS 线程构造;内部 dup */
  JsFunc(JSContext* ctx, JSValueConst fn);
  ~JsFunc();
  JsFunc(const JsFunc&) = delete;
  JsFunc& operator=(const JsFunc&) = delete;

  /** JS 线程:调用并消费 args;返回值被忽略,异常打印 */
  void call_now(int argc, JSValue* argv);

  JSContext* ctx() const { return ctx_; }
  /** 仍属于当前 VM(generation 比对,见 Promise 注释) */
  bool alive() const;
  /** 仅 VM teardown 钩子调用:立刻释放持有的函数引用 */
  void teardown_release(JSContext* ctx);

 private:
  JSContext* ctx_;
  uint32_t gen_;
  JSValue fn_;
};
using JsFuncPtr = std::shared_ptr<JsFunc>;

/**
 * 任意线程:把 fn 的调用投递到 JS 线程;argv 由 make(ctx, argv) 在 JS 线程填充。
 * shared_ptr 保证投递期间 JsFunc 存活。
 */
void call_func_on_js(JsFuncPtr fn, int argc, std::function<void(JSContext*, JSValue* argv)> make);

// ------------------------------------------------------------ 值转换

/** JSValue → std::string(非 string 会被 ToString) */
std::string to_std_string(JSContext* ctx, JSValueConst v);

/** 读取 ArrayBuffer / TypedArray 内容(拷贝);非二进制返回 false */
bool get_binary(JSContext* ctx, JSValueConst v, std::vector<uint8_t>& out);

/** 拷贝 data 到新 ArrayBuffer(PSRAM 优先) */
JSValue new_ab_copy(JSContext* ctx, const void* data, size_t len);
/** 接管 psram_alloc 出来的缓冲为 ArrayBuffer(零拷贝,GC 时 psram_free) */
JSValue new_ab_take(JSContext* ctx, uint8_t* buf, size_t len);

// ------------------------------------------------------------ 对象属性

void set_method(JSContext* ctx, JSValueConst obj, const char* name, JSCFunction* fn, int len);
int32_t opt_int_prop(JSContext* ctx, JSValueConst obj, const char* name, int32_t defv);
bool opt_bool_prop(JSContext* ctx, JSValueConst obj, const char* name, bool defv);
/** 属性缺失/undefined/null 时返回 defv */
std::string opt_str_prop(JSContext* ctx, JSValueConst obj, const char* name, const char* defv);

/** printf 风格抛 JS Error */
JSValue throw_msg(JSContext* ctx, const char* fmt, ...);

// ------------------------------------------------------------ 订阅注册表

/**
 * 事件订阅注册表:add 返回一个 JS Unsubscribe 函数(调用即移除)。
 * 仅 JS 线程使用。
 */
class SubRegistry {
 public:
  /**
   * 添加订阅,返回 Unsubscribe JS 函数(所有权交给调用方)。
   * guard:宿主对象的弱引用;宿主析构后 Unsubscribe 变为空操作,
   *        防止闭包访问悬垂的注册表(静态注册表可不传)。
   */
  JSValue add(JSContext* ctx, JSValueConst fn, std::weak_ptr<void> guard = {});
  /** 依次调用全部订阅(不消费 argv) */
  void dispatch(JSContext* ctx, int argc, JSValueConst* argv);
  bool empty() const { return subs_.empty(); }
  /** 释放全部订阅(VM 销毁前) */
  void clear();

 private:
  struct Entry {
    int id;
    JsFuncPtr fn;
  };
  std::vector<Entry> subs_;
  int next_id_ = 1;
};

}  // namespace pxjs
