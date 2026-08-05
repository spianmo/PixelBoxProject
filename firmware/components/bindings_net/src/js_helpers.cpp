/**
 * js_helpers.cpp — QuickJS 辅助工具实现
 */
#include "js_helpers.hpp"

#include <cstdio>
#include <cstring>
#include <unordered_map>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "jsvm/jsvm.hpp"

namespace pxjs {

static const char* TAG = "px_netjs";

JSContext* g_ctx = nullptr;
void set_ctx(JSContext* ctx) { g_ctx = ctx; }

void run_on_js(std::function<void()> fn) { jsvm::post(std::move(fn)); }

uint8_t* psram_alloc(size_t size) {
  if (size == 0) size = 1;
  uint8_t* p = static_cast<uint8_t*>(
      heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!p) p = static_cast<uint8_t*>(heap_caps_malloc(size, MALLOC_CAP_8BIT));
  return p;
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
  p->resolve = funcs[0];
  p->reject = funcs[1];
  *out_promise = prom;
  return p;
}

void Promise::resolve_now(JSValue v) {
  if (settled) {
    JS_FreeValue(ctx, v);
    return;
  }
  settled = true;
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
    if (self->settled || self->ctx != g_ctx) {
      self->settled = true;
      return;
    }
    self->resolve_now(make(self->ctx));
  });
}

void Promise::reject_msg(std::string msg) {
  auto self = shared_from_this();
  run_on_js([self, msg = std::move(msg)]() {
    if (self->settled || self->ctx != g_ctx) {
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
  if (settled) return;
  // 未 settle 就析构:把 resolve/reject 引用投递回 JS 线程释放
  JSContext* c = ctx;
  JSValue r1 = resolve, r2 = reject;
  if (c) {
    run_on_js([c, r1, r2]() {
      if (c != g_ctx) return;  // VM 已重启,旧值随旧 runtime 回收
      JS_FreeValue(c, r1);
      JS_FreeValue(c, r2);
    });
  }
}

// ------------------------------------------------------------ JsFunc

JsFunc::JsFunc(JSContext* ctx, JSValueConst fn) : ctx_(ctx), fn_(JS_DupValue(ctx, fn)) {}

JsFunc::~JsFunc() {
  JSContext* c = ctx_;
  JSValue f = fn_;
  run_on_js([c, f]() {
    if (c != g_ctx) return;  // VM 已重启,旧值随旧 runtime 回收
    JS_FreeValue(c, f);
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
    if (!fn || fn->ctx() != g_ctx) return;  // VM 已重启
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
