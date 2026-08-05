/**
 * mod_websocket.cpp — 全局 WebSocket 类(对齐 d.ts declare class WebSocket)
 *
 * 实现要点:
 *   - esp_websocket_client 包装:构造即连,禁用自动重连(浏览器语义)
 *   - 事件(open/message/close/error)从 WS 事件任务经 jsvm 事件循环投递 JS
 *   - 文本消息递交 string,二进制递交 ArrayBuffer(PSRAM);支持分片重组
 *   - 连接活动期间 dup 持有 JS 对象,防止有回调挂着时对象被 GC
 *   - readyState 静态常量 CONNECTING/OPEN/CLOSING/CLOSED 挂在构造器上
 */
#include <atomic>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "js_helpers.hpp"
#include "jsvm/jsvm.hpp"
#include "net_worker.hpp"

static const char* TAG = "px_ws";

// ------------------------------------------------------------ 数据结构

struct WsClient {
  esp_websocket_client_handle_t handle = nullptr;
  JSContext* ctx = nullptr;
  JSValue self = JS_UNDEFINED;  ///< 连接活动期间持有的 JS 对象引用
  std::atomic<int> state{0};    ///< 0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED
  std::string url;
  bool terminal_sent = false;   ///< onclose 已派发(仅 JS 线程)
  bool destroy_scheduled = false;
  void* handler_ref = nullptr;  ///< 事件处理器持有的 WsPtr*,destroy 后回收

  // 以下仅 WS 事件任务访问(分片重组)
  std::vector<uint8_t> frag;
  int cur_op = 0;
  int close_code = 1005;  ///< 1005 = 无 close 帧
  std::string close_reason;
};
using WsPtr = std::shared_ptr<WsClient>;

static JSClassID g_ws_class_id;

// ------------------------------------------------------------ 工具

static WsPtr ws_from_this(JSContext* ctx, JSValueConst this_val) {
  auto* sp = static_cast<WsPtr*>(JS_GetOpaque(this_val, g_ws_class_id));
  return sp ? *sp : nullptr;
}

/** 惰性销毁底层客户端(阻塞操作丢给 worker);destroy 后回收事件处理器引用 */
static void ws_schedule_destroy(const WsPtr& ws) {
  if (ws->destroy_scheduled || !ws->handle) return;
  ws->destroy_scheduled = true;
  esp_websocket_client_handle_t h = ws->handle;
  void* href = ws->handler_ref;
  ws->handle = nullptr;
  ws->handler_ref = nullptr;
  pxjs::worker_submit([h, href]() {
    esp_websocket_client_destroy(h);  // 内部先 stop 事件任务,之后不会再有事件回调
    delete static_cast<WsPtr*>(href);
  });
}

/** JS 线程:取 obj.<prop> 若为函数则以 ev 为参调用(消费 ev) */
static void ws_call_handler(const WsPtr& ws, const char* prop, JSValue ev) {
  JSContext* ctx = ws->ctx;
  if (ctx != pxjs::g_ctx || JS_IsUndefined(ws->self)) {
    if (ctx == pxjs::g_ctx) JS_FreeValue(ctx, ev);
    return;
  }
  JSValue fn = JS_GetPropertyStr(ctx, ws->self, prop);
  if (JS_IsFunction(ctx, fn)) {
    JSValue ret = JS_Call(ctx, fn, ws->self, 1, &ev);
    if (JS_IsException(ret)) {
      JSValue e = JS_GetException(ctx);
      const char* s = JS_ToCString(ctx, e);
      ESP_LOGE(TAG, "WebSocket.%s 回调异常: %s", prop, s ? s : "?");
      if (s) JS_FreeCString(ctx, s);
      JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, ret);
  }
  JS_FreeValue(ctx, fn);
  JS_FreeValue(ctx, ev);
}

/** JS 线程:派发终态 onclose 并释放对 JS 对象的持有 */
static void ws_dispatch_terminal(const WsPtr& ws, int code, std::string reason) {
  if (ws->terminal_sent) return;
  ws->terminal_sent = true;
  ws->state.store(3);
  JSContext* ctx = ws->ctx;
  if (ctx == pxjs::g_ctx && !JS_IsUndefined(ws->self)) {
    JSValue ev = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, ev, "type", JS_NewString(ctx, "close"));
    JS_SetPropertyStr(ctx, ev, "code", JS_NewInt32(ctx, code));
    JS_SetPropertyStr(ctx, ev, "reason", JS_NewString(ctx, reason.c_str()));
    ws_call_handler(ws, "onclose", ev);
    JS_FreeValue(ctx, ws->self);
  }
  ws->self = JS_UNDEFINED;
  ws_schedule_destroy(ws);
}

// ------------------------------------------------------------ WS 事件(esp_websocket 任务)

static void ws_event_handler(void* arg, esp_event_base_t, int32_t event_id, void* event_data) {
  auto* spp = static_cast<WsPtr*>(arg);
  WsPtr ws = *spp;
  auto* data = static_cast<esp_websocket_event_data_t*>(event_data);

  switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED: {
      ws->state.store(1);
      pxjs::run_on_js([ws]() {
        if (ws->ctx != pxjs::g_ctx) return;
        JSValue ev = JS_NewObject(ws->ctx);
        JS_SetPropertyStr(ws->ctx, ev, "type", JS_NewString(ws->ctx, "open"));
        ws_call_handler(ws, "onopen", ev);
      });
      break;
    }
    case WEBSOCKET_EVENT_DATA: {
      if (!data) break;
      int op = data->op_code;
      if (op == 0x09 || op == 0x0A) break;  // ping/pong 忽略
      if (op == 0x08) {                     // close 帧:记录 code/reason
        if (data->data_len >= 2) {
          const uint8_t* p = reinterpret_cast<const uint8_t*>(data->data_ptr);
          ws->close_code = (p[0] << 8) | p[1];
          ws->close_reason.assign(reinterpret_cast<const char*>(p) + 2, data->data_len - 2);
        }
        break;
      }
      if (op == 0x01 || op == 0x02) ws->cur_op = op;  // 0x00 为延续帧,沿用 cur_op
      if (data->payload_offset == 0) ws->frag.clear();
      if (data->data_len > 0) {
        ws->frag.insert(ws->frag.end(),
                        reinterpret_cast<const uint8_t*>(data->data_ptr),
                        reinterpret_cast<const uint8_t*>(data->data_ptr) + data->data_len);
      }
      if (data->payload_offset + data->data_len >= data->payload_len) {
        // 消息完整,投递 JS
        bool is_text = ws->cur_op == 0x01;
        auto payload = std::make_shared<std::vector<uint8_t>>(std::move(ws->frag));
        ws->frag = {};
        pxjs::run_on_js([ws, payload, is_text]() {
          if (ws->ctx != pxjs::g_ctx) return;
          JSContext* ctx = ws->ctx;
          JSValue dv;
          if (is_text) {
            dv = JS_NewStringLen(ctx, reinterpret_cast<const char*>(payload->data()),
                                 payload->size());
          } else {
            dv = pxjs::new_ab_copy(ctx, payload->data(), payload->size());
          }
          if (JS_IsException(dv)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            return;
          }
          JSValue ev = JS_NewObject(ctx);
          JS_SetPropertyStr(ctx, ev, "type", JS_NewString(ctx, "message"));
          JS_SetPropertyStr(ctx, ev, "data", dv);
          ws_call_handler(ws, "onmessage", ev);
        });
      }
      break;
    }
    case WEBSOCKET_EVENT_ERROR: {
      pxjs::run_on_js([ws]() {
        if (ws->ctx != pxjs::g_ctx) return;
        JSValue ev = JS_NewObject(ws->ctx);
        JS_SetPropertyStr(ws->ctx, ev, "type", JS_NewString(ws->ctx, "error"));
        JS_SetPropertyStr(ws->ctx, ev, "message", JS_NewString(ws->ctx, "WebSocket 传输错误"));
        ws_call_handler(ws, "onerror", ev);
      });
      break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED: {
      ws->state.store(3);
      int code = ws->close_code;
      std::string reason = ws->close_reason;
      pxjs::run_on_js([ws, code, reason]() { ws_dispatch_terminal(ws, code, reason); });
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------ 方法

static JSValue js_ws_send(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  WsPtr ws = ws_from_this(ctx, this_val);
  if (!ws) return pxjs::throw_msg(ctx, "非法的 WebSocket 对象");
  if (ws->state.load() != 1) return pxjs::throw_msg(ctx, "WebSocket 未处于 OPEN 状态");
  if (argc < 1) return pxjs::throw_msg(ctx, "send(data) 缺少参数");

  int sent;
  if (JS_IsString(argv[0])) {
    std::string s = pxjs::to_std_string(ctx, argv[0]);
    sent = esp_websocket_client_send_text(ws->handle, s.c_str(), (int)s.size(),
                                          pdMS_TO_TICKS(10000));
  } else {
    std::vector<uint8_t> bin;
    if (!pxjs::get_binary(ctx, argv[0], bin))
      return pxjs::throw_msg(ctx, "send 仅支持 string / ArrayBuffer / Uint8Array");
    sent = esp_websocket_client_send_bin(ws->handle,
                                         reinterpret_cast<const char*>(bin.data()),
                                         (int)bin.size(), pdMS_TO_TICKS(10000));
  }
  if (sent < 0) return pxjs::throw_msg(ctx, "WebSocket 发送失败");
  return JS_UNDEFINED;
}

static JSValue js_ws_close(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  WsPtr ws = ws_from_this(ctx, this_val);
  if (!ws) return pxjs::throw_msg(ctx, "非法的 WebSocket 对象");
  int st = ws->state.load();
  if (st == 2 || st == 3) return JS_UNDEFINED;  // 幂等
  ws->state.store(2);

  int32_t code = 1000;
  bool has_code = false;
  if (argc >= 1 && !JS_IsUndefined(argv[0])) {
    JS_ToInt32(ctx, &code, argv[0]);
    has_code = true;
  }
  std::string reason;
  if (argc >= 2 && !JS_IsUndefined(argv[1])) reason = pxjs::to_std_string(ctx, argv[1]);

  esp_websocket_client_handle_t h = ws->handle;
  pxjs::worker_submit([h, code, reason, has_code, ws]() {
    if (!h) return;
    if (has_code || !reason.empty()) {
      esp_websocket_client_close_with_code(h, code, reason.c_str(), (int)reason.size(),
                                           pdMS_TO_TICKS(3000));
    } else {
      esp_websocket_client_close(h, pdMS_TO_TICKS(3000));
    }
    // close 超时/失败也要保证终态派发(正常路径由 CLOSED/DISCONNECTED 事件触发,这里兜底)
    pxjs::run_on_js([ws]() { ws_dispatch_terminal(ws, ws->close_code, ws->close_reason); });
  });
  return JS_UNDEFINED;
}

static JSValue js_ws_get_ready_state(JSContext* ctx, JSValueConst this_val, int, JSValueConst*) {
  WsPtr ws = ws_from_this(ctx, this_val);
  if (!ws) return JS_NewInt32(ctx, 3);
  return JS_NewInt32(ctx, ws->state.load());
}

// ------------------------------------------------------------ 构造 / 析构

static JSValue js_ws_ctor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst* argv) {
  if (argc < 1) return pxjs::throw_msg(ctx, "new WebSocket(url, protocols?) 缺少 url");
  std::string url = pxjs::to_std_string(ctx, argv[0]);
  if (url.rfind("ws://", 0) != 0 && url.rfind("wss://", 0) != 0) {
    return pxjs::throw_msg(ctx, "WebSocket 仅支持 ws:// 或 wss:// URL");
  }

  // protocols: string | string[]
  std::string subprotocol;
  if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
    if (JS_IsString(argv[1])) {
      subprotocol = pxjs::to_std_string(ctx, argv[1]);
    } else {
      JSValue lenv = JS_GetPropertyStr(ctx, argv[1], "length");
      uint32_t n = 0;
      JS_ToUint32(ctx, &n, lenv);
      JS_FreeValue(ctx, lenv);
      for (uint32_t i = 0; i < n; i++) {
        JSValue it = JS_GetPropertyUint32(ctx, argv[1], i);
        if (!subprotocol.empty()) subprotocol += ", ";
        subprotocol += pxjs::to_std_string(ctx, it);
        JS_FreeValue(ctx, it);
      }
    }
  }

  JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  JSValue obj = JS_NewObjectProtoClass(ctx, proto, g_ws_class_id);
  JS_FreeValue(ctx, proto);
  if (JS_IsException(obj)) return obj;

  auto ws = std::make_shared<WsClient>();
  ws->ctx = ctx;
  ws->url = url;

  esp_websocket_client_config_t cfg = {};
  cfg.uri = url.c_str();
  if (!subprotocol.empty()) cfg.subprotocol = subprotocol.c_str();
  cfg.disable_auto_reconnect = true;  // 浏览器语义:断了就是断了
  cfg.buffer_size = 4096;
  cfg.network_timeout_ms = 10000;
  cfg.task_stack = 6144;
  if (url.rfind("wss://", 0) == 0) cfg.crt_bundle_attach = esp_crt_bundle_attach;

  ws->handle = esp_websocket_client_init(&cfg);
  if (!ws->handle) {
    JS_FreeValue(ctx, obj);
    return pxjs::throw_msg(ctx, "WebSocket 初始化失败");
  }

  // 事件处理器持有一份独立的 shared_ptr,销毁时机与 JS 对象解耦
  auto* handler_ref = new WsPtr(ws);
  ws->handler_ref = handler_ref;
  esp_websocket_register_events(ws->handle, WEBSOCKET_EVENT_ANY, ws_event_handler, handler_ref);

  // 实例属性(对齐 d.ts)
  JS_DefinePropertyValueStr(ctx, obj, "url", JS_NewString(ctx, url.c_str()), 0);  // 只读
  JS_SetPropertyStr(ctx, obj, "binaryType", JS_NewString(ctx, "arraybuffer"));
  JS_SetPropertyStr(ctx, obj, "onopen", JS_NULL);
  JS_SetPropertyStr(ctx, obj, "onmessage", JS_NULL);
  JS_SetPropertyStr(ctx, obj, "onclose", JS_NULL);
  JS_SetPropertyStr(ctx, obj, "onerror", JS_NULL);

  JS_SetOpaque(obj, new WsPtr(ws));
  ws->self = JS_DupValue(ctx, obj);  // 连接期间保活

  if (esp_websocket_client_start(ws->handle) != ESP_OK) {
    JS_FreeValue(ctx, ws->self);
    ws->self = JS_UNDEFINED;
    ws->state.store(3);
    ws_schedule_destroy(ws);  // 同时回收 handler_ref
    JS_FreeValue(ctx, obj);
    return pxjs::throw_msg(ctx, "WebSocket 连接启动失败");
  }
  return obj;
}

static void js_ws_finalizer(JSRuntime*, JSValue val) {
  auto* sp = static_cast<WsPtr*>(JS_GetOpaque(val, g_ws_class_id));
  if (!sp) return;
  WsPtr ws = *sp;
  delete sp;
  // 对象被 GC:若连接还活着(理论上不会,因为活动连接持有 self),兜底销毁
  ws->state.store(3);
  ws_schedule_destroy(ws);
}

// ------------------------------------------------------------ 模块注册

static void ws_module_init(JSContext* ctx, JSValue) {
  pxjs::set_ctx(ctx);
  JSRuntime* rt = JS_GetRuntime(ctx);
  static bool class_done = false;
  if (!class_done) {
    JS_NewClassID(rt, &g_ws_class_id);
    class_done = true;
  }
  static const JSClassDef ws_class_def = {
      .class_name = "WebSocket",
      .finalizer = js_ws_finalizer,
  };
  JS_NewClass(rt, g_ws_class_id, &ws_class_def);

  JSValue proto = JS_NewObject(ctx);
  pxjs::set_method(ctx, proto, "send", js_ws_send, 1);
  pxjs::set_method(ctx, proto, "close", js_ws_close, 2);
  // readyState 动态 getter
  JSAtom atom = JS_NewAtom(ctx, "readyState");
  JSValue getter = JS_NewCFunction(ctx, js_ws_get_ready_state, "get readyState", 0);
  JS_DefinePropertyGetSet(ctx, proto, atom, getter, JS_UNDEFINED, JS_PROP_ENUMERABLE);
  JS_FreeAtom(ctx, atom);
  JS_SetClassProto(ctx, g_ws_class_id, proto);

  JSValue ctor = JS_NewCFunction2(ctx, js_ws_ctor, "WebSocket", 2, JS_CFUNC_constructor, 0);
  JSValue proto2 = JS_GetClassProto(ctx, g_ws_class_id);
  JS_SetConstructor(ctx, ctor, proto2);
  JS_FreeValue(ctx, proto2);
  // 静态常量(对齐 d.ts)
  JS_DefinePropertyValueStr(ctx, ctor, "CONNECTING", JS_NewInt32(ctx, 0), 0);
  JS_DefinePropertyValueStr(ctx, ctor, "OPEN", JS_NewInt32(ctx, 1), 0);
  JS_DefinePropertyValueStr(ctx, ctor, "CLOSING", JS_NewInt32(ctx, 2), 0);
  JS_DefinePropertyValueStr(ctx, ctor, "CLOSED", JS_NewInt32(ctx, 3), 0);

  JSValue global = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, global, "WebSocket", ctor);
  JS_FreeValue(ctx, global);
  ESP_LOGI(TAG, "全局 WebSocket 已注册");
}

static const jsvm::Module k_ws_module = {
    .name = "websocket",
    .priority = 10,
    .init = ws_module_init,
    .prelude = nullptr,
};
JSVM_REGISTER_MODULE(k_ws_module);
