/**
 * js_helpers.cpp — QuickJS 辅助工具实现
 */
#include "js_helpers.hpp"

#include <cstdio>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <unordered_set>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "hal_common/px_alloc.h"
#include "jsvm/jsvm.hpp"

namespace pxjs {

static const char* TAG = "px_netjs";

/** 定义在文件末尾的 SubRegistry 退订表 (teardown 时作废) */
static void unsub_actions_clear();

/* ------------------------------------------------------------
 * 析构与 teardown 钩子的互斥约定 (三个析构函数都依赖它, 集中说明一次)
 *
 * teardown 钩子全程持有 s_live_mtx, 且只在持锁期间把 s_in_teardown 置真。
 * 于是有不变式:**持锁读到 s_in_teardown == true ⟺ 自己就是钩子所在的 JS 线程**
 * (跨线程析构必然阻塞在锁上, 等拿到锁时钩子已经收尾, 标志已复位)。
 *
 * 所以"出表"与"读标志"必须在同一个临界区里做完 —— 中间放锁会开一个窗口:
 * 析构先把自己从存活表摘走 → 钩子拿到锁跑完 (扫不到它) → 析构再看标志已是假 →
 * 走投递路径 → vm_stale 守卫拦下 → 这条引用永远不释放 → JS_FreeRuntime 断言炸。
 * ------------------------------------------------------------ */

/* ------------------------------------------------------------
 * 存活注册表 (Promise / JsFunc / SelfRef)
 *
 * VM teardown 时必须释放所有 C++ 侧持有的 JSValue (未 settle Promise 的
 * resolve/reject、JsFunc 的函数引用、socket/server 的 self 保活引用)
 * —— 否则 JS_FreeRuntime 断言 gc_obj_list 非空直接 abort (真机 coredump
 * 实证: 在途 ntpSync/fetch 期间热重启 = "assert failed: JS_FreeRuntime
 * quickjs.c (list_empty)"; 开着 listenTcp 的应用按键1 切设置页 = 整机复位)。
 * 与 jsvm::Callback 的 live-ctrl 集合同款思路。
 * recursive_mutex: teardown 释放闭包可级联析构其他注册对象 (同线程重入)。
 * ------------------------------------------------------------ */
static std::recursive_mutex s_live_mtx;
/** 正处在 teardown 钩子里 (仅 JS 线程读写, 持 s_live_mtx): 见下方析构函数 */
static bool s_in_teardown = false;
static std::unordered_set<Promise*>& live_promises() {
  static std::unordered_set<Promise*> s;
  return s;
}
static std::unordered_set<JsFunc*>& live_funcs() {
  static std::unordered_set<JsFunc*> s;
  return s;
}
static std::unordered_set<SelfRef*>& live_selfrefs() {
  static std::unordered_set<SelfRef*> s;
  return s;
}

static void teardown_free_live(JSContext* ctx) {
  /* 全程持锁 + 每轮摘取一个: JS_FreeValue 释放闭包可能级联析构注册表里的
   * 其他对象 (同线程 recursive 重入, 自行出表), 也可能级联析构"当前"对象
   * (故先把值挪到局部、标记 settled 后再 free, free 之后不再触碰对象)。
   * 跨线程析构则阻塞在本锁上直到钩子完成, 对象内存在此期间必然有效。 */
  std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
  s_in_teardown = true;
  while (!live_promises().empty()) {
    Promise* p = *live_promises().begin();
    live_promises().erase(live_promises().begin());
    if (p->settled) continue;
    p->settled = true;
    JSValue r1 = p->resolve, r2 = p->reject;
    p->resolve = p->reject = JS_UNDEFINED;
    JS_FreeValue(ctx, r1); /* p 可能在此被级联析构, 之后不再触碰 p */
    JS_FreeValue(ctx, r2);
  }
  while (!live_funcs().empty()) {
    JsFunc* f = *live_funcs().begin();
    live_funcs().erase(live_funcs().begin());
    f->teardown_release(ctx);
  }
  /* self 放最后: 释放它常常让 JS 对象引用归零, 当场跑 finalizer 级联析构
     整个 socket 结构体 (含其中的 SubRegistry/JsFunc)。先清空 live_funcs
     才能保证那些 JsFunc 的 fn_ 已经是 UNDEFINED, 析构时直接空转。 */
  while (!live_selfrefs().empty()) {
    SelfRef* r = *live_selfrefs().begin();
    live_selfrefs().erase(live_selfrefs().begin());
    r->teardown_release(ctx);
  }
  /* Unsubscribe 动作表按 VM 生命周期作废: 里面的闭包捕获的是旧 VM 的
     SubRegistry 宿主, 留着既没用也会跨代累积 */
  unsub_actions_clear();
  s_in_teardown = false;
}

JSContext* g_ctx = nullptr;
void set_ctx(JSContext* ctx) {
  g_ctx = ctx;
  static bool s_hook_registered = false;
  if (!s_hook_registered) {
    s_hook_registered = true;
    jsvm::add_teardown_hook(teardown_free_live);
  }
}

void run_on_js(std::function<void()> fn) { jsvm::post(std::move(fn)); }

uint8_t* psram_alloc(size_t size) {
  if (size == 0) size = 1;
  /* PSRAM 优先, 无 PSRAM 目标自动落内部堆 (hal_common/px_alloc.h) */
  return static_cast<uint8_t*>(px_alloc_prefer_psram(size));
}
void psram_free(void* p) {
  if (p) heap_caps_free(p);
}

/** 打印并清除挂起的 JS 异常 */
static void log_exception(JSContext* ctx) {
  JSValue e = JS_GetException(ctx);
  const char* s = JS_ToCString(ctx, e);
  ESP_LOGE(TAG, "JS 回调异常: %s", s ? s : "(unknown)");
  if (s) JS_FreeCString(ctx, s);
  JS_FreeValue(ctx, e);
}

// ------------------------------------------------------------ Promise

PromisePtr Promise::create(JSContext* ctx, JSValue* out_promise) {
  auto p = std::make_shared<Promise>();
  JSValue funcs[2];
  JSValue prom = JS_NewPromiseCapability(ctx, funcs);
  p->ctx = ctx;
  p->gen = jsvm::vm_generation();
  p->resolve = funcs[0];
  p->reject = funcs[1];
  *out_promise = prom;
  {
    std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
    live_promises().insert(p.get());
  }
  return p;
}

bool vm_stale(uint32_t gen) {
  /* 双重判定: generation 失配 = 对象属旧 VM; context()==nullptr = VM 停机中
   * (teardown 已置空 s_ctx)。两者都在 JS 线程读写, 无竞态。 */
  return jsvm::context() == nullptr || gen != jsvm::vm_generation();
}

void Promise::resolve_now(JSValue v) {
  if (settled) {
    JS_FreeValue(ctx, v);
    return;
  }
  settled = true;
  {
    std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
    live_promises().erase(this);
  }
  JSValue ret = JS_Call(ctx, resolve, JS_UNDEFINED, 1, &v);
  if (JS_IsException(ret)) log_exception(ctx);
  JS_FreeValue(ctx, ret);
  JS_FreeValue(ctx, v);
  JS_FreeValue(ctx, resolve);
  JS_FreeValue(ctx, reject);
  resolve = reject = JS_UNDEFINED;
}

void Promise::reject_now(JSValue err) {
  if (settled) {
    JS_FreeValue(ctx, err);
    return;
  }
  settled = true;
  {
    std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
    live_promises().erase(this);
  }
  JSValue ret = JS_Call(ctx, reject, JS_UNDEFINED, 1, &err);
  if (JS_IsException(ret)) log_exception(ctx);
  JS_FreeValue(ctx, ret);
  JS_FreeValue(ctx, err);
  JS_FreeValue(ctx, resolve);
  JS_FreeValue(ctx, reject);
  resolve = reject = JS_UNDEFINED;
}

void Promise::resolve_on_js(std::function<JSValue(JSContext*)> make) {
  auto self = shared_from_this();
  run_on_js([self, make = std::move(make)]() {
    // VM 已热重启则旧 ctx 失效,直接放弃(内存随旧 runtime 回收)
    if (self->settled || vm_stale(self->gen)) {
      self->settled = true;
      return;
    }
    self->resolve_now(make(self->ctx));
  });
}

void Promise::reject_msg(std::string msg) {
  auto self = shared_from_this();
  run_on_js([self, msg = std::move(msg)]() {
    if (self->settled || vm_stale(self->gen)) {
      self->settled = true;
      return;
    }
    JSValue err = JS_NewError(self->ctx);
    JS_DefinePropertyValueStr(self->ctx, err, "message",
                              JS_NewString(self->ctx, msg.c_str()),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    self->reject_now(err);
  });
}

Promise::~Promise() {
  // 出表、settled 判读、s_in_teardown 读取必须在同一临界区(见文件头互斥约定)
  JSContext* c;
  uint32_t g;
  JSValue r1, r2;
  {
    std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
    live_promises().erase(this);
    if (settled) return;
    settled = true;
    c = ctx;
    g = gen;
    r1 = resolve;
    r2 = reject;
    resolve = reject = JS_UNDEFINED;
    if (!c) return;
    if (s_in_teardown) {  // 钩子内被级联析构:当场释放(投递出去就再也没人执行了)
      JS_FreeValue(c, r1);
      JS_FreeValue(c, r2);
      return;
    }
  }
  // 未 settle 就析构:把 resolve/reject 引用投递回 JS 线程释放
  run_on_js([c, g, r1, r2]() {
    if (vm_stale(g)) return;  // VM 已重启,旧值随旧 runtime 回收
    JS_FreeValue(c, r1);
    JS_FreeValue(c, r2);
  });
}

// ------------------------------------------------------------ JsFunc

JsFunc::JsFunc(JSContext* ctx, JSValueConst fn)
    : ctx_(ctx), gen_(jsvm::vm_generation()), fn_(JS_DupValue(ctx, fn)) {
  std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
  live_funcs().insert(this);
}

bool JsFunc::alive() const { return !vm_stale(gen_); }

void JsFunc::teardown_release(JSContext* ctx) {
  // 仅 teardown 钩子调用 (JS 线程, 持 s_live_mtx);
  // 先挪局部再 free: 释放闭包可能级联析构本对象
  JSValue f = fn_;
  fn_ = JS_UNDEFINED;
  if (!JS_IsUndefined(f)) JS_FreeValue(ctx, f);
}

JsFunc::~JsFunc() {
  JSContext* c;
  uint32_t g;
  JSValue f;
  {
    std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
    live_funcs().erase(this);
    f = fn_;
    fn_ = JS_UNDEFINED;
    c = ctx_;
    g = gen_;
    if (JS_IsUndefined(f)) return;  // teardown 已释放
    if (s_in_teardown) {            // 钩子内被级联析构:当场释放
      JS_FreeValue(c, f);
      return;
    }
  }
  run_on_js([c, g, f]() {
    if (vm_stale(g)) return;  // VM 已重启,旧值随旧 runtime 回收
    JS_FreeValue(c, f);
  });
}

// ------------------------------------------------------------ SelfRef

void SelfRef::hold(JSContext* ctx, JSValueConst obj) {
  if (!JS_IsUndefined(v_)) release(ctx);
  ctx_ = ctx;
  gen_ = jsvm::vm_generation();
  v_ = JS_DupValue(ctx, obj);
  std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
  live_selfrefs().insert(this);
}

void SelfRef::release(JSContext* ctx) {
  JSValue v;
  {
    std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
    live_selfrefs().erase(this);
    v = v_;
    v_ = JS_UNDEFINED;
  }
  if (JS_IsUndefined(v)) return;
  if (vm_stale(gen_)) return;  // VM 已重启,旧值随旧 runtime 回收
  JS_FreeValue(ctx ? ctx : ctx_, v);
}

void SelfRef::teardown_release(JSContext* ctx) {
  // 仅 teardown 钩子调用 (JS 线程, 持 s_live_mtx);
  // 先挪局部再 free: 释放常触发 finalizer 级联析构本对象所在的结构体
  JSValue v = v_;
  v_ = JS_UNDEFINED;
  if (!JS_IsUndefined(v)) JS_FreeValue(ctx, v);
}

SelfRef::~SelfRef() {
  JSContext* c;
  uint32_t g;
  JSValue v;
  {
    std::lock_guard<std::recursive_mutex> lk(s_live_mtx);
    live_selfrefs().erase(this);
    v = v_;
    v_ = JS_UNDEFINED;
    c = ctx_;
    g = gen_;
    if (JS_IsUndefined(v) || !c) return;  // 已释放 / 从未 hold 过
    if (s_in_teardown) {                  // 钩子内被级联析构:当场释放
      JS_FreeValue(c, v);
      return;
    }
  }
  run_on_js([c, g, v]() {
    if (vm_stale(g)) return;  // VM 已重启,旧值随旧 runtime 回收
    JS_FreeValue(c, v);
  });
}

void JsFunc::call_now(int argc, JSValue* argv) {
  JSValue ret = JS_Call(ctx_, fn_, JS_UNDEFINED, argc, argv);
  if (JS_IsException(ret)) log_exception(ctx_);
  JS_FreeValue(ctx_, ret);
  for (int i = 0; i < argc; i++) JS_FreeValue(ctx_, argv[i]);
}

void call_func_on_js(JsFuncPtr fn, int argc, std::function<void(JSContext*, JSValue* argv)> make) {
  run_on_js([fn, argc, make = std::move(make)]() {
    if (!fn || !fn->alive()) return;  // VM 已重启
    JSValue argv[8];
    int n = argc > 8 ? 8 : argc;
    for (int i = 0; i < n; i++) argv[i] = JS_UNDEFINED;
    make(fn->ctx(), argv);
    fn->call_now(n, argv);
  });
}

// ------------------------------------------------------------ 值转换

std::string to_std_string(JSContext* ctx, JSValueConst v) {
  size_t len = 0;
  const char* s = JS_ToCStringLen(ctx, &len, v);
  if (!s) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return {};
  }
  std::string out(s, len);
  JS_FreeCString(ctx, s);
  return out;
}

bool get_binary(JSContext* ctx, JSValueConst v, std::vector<uint8_t>& out) {
  size_t len = 0;
  uint8_t* p = JS_GetArrayBuffer(ctx, &len, v);
  if (p) {
    out.assign(p, p + len);
    return true;
  }
  JS_FreeValue(ctx, JS_GetException(ctx));  // 清掉 GetArrayBuffer 的异常
  size_t off = 0, tlen = 0, pel = 0;
  JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &tlen, &pel);
  if (JS_IsException(ab)) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return false;
  }
  p = JS_GetArrayBuffer(ctx, &len, ab);
  bool ok = false;
  if (p && off + tlen <= len) {
    out.assign(p + off, p + off + tlen);
    ok = true;
  }
  JS_FreeValue(ctx, ab);
  return ok;
}

static void ab_free_cb(JSRuntime*, void*, void* ptr) { psram_free(ptr); }

JSValue new_ab_copy(JSContext* ctx, const void* data, size_t len) {
  uint8_t* buf = psram_alloc(len);
  if (!buf) return throw_msg(ctx, "内存不足 (%u 字节)", (unsigned)len);
  if (len) std::memcpy(buf, data, len);
  return JS_NewArrayBuffer(ctx, buf, len, ab_free_cb, nullptr, false);
}

JSValue new_ab_take(JSContext* ctx, uint8_t* buf, size_t len) {
  return JS_NewArrayBuffer(ctx, buf, len, ab_free_cb, nullptr, false);
}

// ------------------------------------------------------------ 对象属性

void set_method(JSContext* ctx, JSValueConst obj, const char* name, JSCFunction* fn, int len) {
  JS_SetPropertyStr(ctx, obj, name, JS_NewCFunction(ctx, fn, name, len));
}

int32_t opt_int_prop(JSContext* ctx, JSValueConst obj, const char* name, int32_t defv) {
  if (!JS_IsObject(obj)) return defv;
  JSValue v = JS_GetPropertyStr(ctx, obj, name);
  int32_t out = defv;
  if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
    if (JS_ToInt32(ctx, &out, v) != 0) {
      JS_FreeValue(ctx, JS_GetException(ctx));
      out = defv;
    }
  }
  JS_FreeValue(ctx, v);
  return out;
}

bool opt_bool_prop(JSContext* ctx, JSValueConst obj, const char* name, bool defv) {
  if (!JS_IsObject(obj)) return defv;
  JSValue v = JS_GetPropertyStr(ctx, obj, name);
  bool out = defv;
  if (!JS_IsUndefined(v) && !JS_IsNull(v)) out = JS_ToBool(ctx, v) != 0;
  JS_FreeValue(ctx, v);
  return out;
}

std::string opt_str_prop(JSContext* ctx, JSValueConst obj, const char* name, const char* defv) {
  if (!JS_IsObject(obj)) return defv;
  JSValue v = JS_GetPropertyStr(ctx, obj, name);
  std::string out = defv;
  if (!JS_IsUndefined(v) && !JS_IsNull(v)) out = to_std_string(ctx, v);
  JS_FreeValue(ctx, v);
  return out;
}

JSValue throw_msg(JSContext* ctx, const char* fmt, ...) {
  char buf[256];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  JSValue err = JS_NewError(ctx);
  JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, buf),
                            JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
  return JS_Throw(ctx, err);
}

// ------------------------------------------------------------ SubRegistry

/** 全局 Unsubscribe 动作表(仅 JS 线程访问) */
static std::unordered_map<int, std::function<void()>>& unsub_actions() {
  static std::unordered_map<int, std::function<void()>> m;
  return m;
}
static int g_unsub_next_id = 1;

static void unsub_actions_clear() { unsub_actions().clear(); }

static JSValue unsub_trampoline(JSContext* ctx, JSValueConst, int, JSValueConst*, int,
                                JSValue* data) {
  int32_t id = 0;
  JS_ToInt32(ctx, &id, data[0]);
  auto& m = unsub_actions();
  auto it = m.find(id);
  if (it != m.end()) {
    auto fn = std::move(it->second);
    m.erase(it);
    fn();
  }
  return JS_UNDEFINED;
}

JSValue SubRegistry::add(JSContext* ctx, JSValueConst fn, std::weak_ptr<void> guard) {
  Entry e;
  e.id = next_id_++;
  e.fn = std::make_shared<JsFunc>(ctx, fn);
  subs_.push_back(e);

  int gid = g_unsub_next_id++;
  int local_id = e.id;
  bool has_guard = guard.owner_before(std::weak_ptr<void>{}) ||
                   std::weak_ptr<void>{}.owner_before(guard);  // 非空 weak_ptr 判定
  unsub_actions()[gid] = [this, local_id, guard = std::move(guard), has_guard]() {
    if (has_guard && guard.expired()) return;  // 宿主已析构,注册表悬垂,跳过
    for (auto it = subs_.begin(); it != subs_.end(); ++it) {
      if (it->id == local_id) {
        subs_.erase(it);
        break;
      }
    }
  };
  JSValue data = JS_NewInt32(ctx, gid);
  JSValue unsub = JS_NewCFunctionData(ctx, unsub_trampoline, 0, 0, 1, &data);
  JS_FreeValue(ctx, data);
  return unsub;
}

void SubRegistry::dispatch(JSContext* ctx, int argc, JSValueConst* argv) {
  auto copy = subs_;  // 回调里可能退订
  for (auto& e : copy) {
    JSValue args[8];
    int n = argc > 8 ? 8 : argc;
    for (int i = 0; i < n; i++) args[i] = JS_DupValue(ctx, argv[i]);
    e.fn->call_now(n, args);
  }
}

void SubRegistry::clear() { subs_.clear(); }

}  // namespace pxjs
