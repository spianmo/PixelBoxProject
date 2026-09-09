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
#include <algorithm>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_websocket_client.h"
#include "esp_transport_tcp.h"
#include "esp_transport_ssl.h"
#include "esp_transport_ws.h"
#include "esp_timer.h"
#include "http_parser.h"
#include "lwip/sockets.h"
#include "mbedtls/base64.h"
#include "hal_net/ws_message.hpp"
#include "js_helpers.hpp"
#include "jsvm/jsvm.hpp"
#include "net_worker.hpp"
#include "ws_frame_transport.hpp"

static const char* TAG = "px_ws";
static constexpr int kNetworkTimeoutMs = 10000;

// ------------------------------------------------------------ 数据结构

struct WsClient {
  esp_websocket_client_handle_t handle = nullptr;
  JSContext* ctx = nullptr;
  uint32_t gen = 0;    ///< 创建时的 jsvm::vm_generation(),VM 热重启失效判定用
  pxjs::SelfRef self;  ///< 连接活动期间持有的 JS 对象引用(VM 拆除时同步释放)
  std::atomic<int> state{0};    ///< 0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED
  std::string url;
  bool terminal_sent = false;   ///< onclose 已派发(仅 JS 线程)
  bool destroy_scheduled = false;
  void* handler_ref = nullptr;  ///< 事件处理器持有的 WsPtr*,destroy 后回收
  std::mutex work_mutex, close_mutex;
  std::deque<std::function<void()>> work;
  bool work_running = false;
  size_t queued_bytes = 0, queued_messages = 0;
  int64_t queue_report_us = 0, queue_delay_max_ms = 0;
  size_t received_messages = 0;
  esp_transport_handle_t stream_transport = nullptr, ws_transport = nullptr;
  uint64_t sent_bytes = 0;
  int64_t send_max_ms = 0, send_report_us = 0;
  int64_t diagnostic_us = 0;

  ~WsClient() {
    // ext_transport 由调用方拥有，必须等客户端任务销毁后再释放。
    if (ws_transport) {
      ws_frame_transport_unregister(ws_transport);
      esp_transport_destroy(ws_transport);
    }
    if (stream_transport) esp_transport_destroy(stream_transport);
  }

  // 以下仅 WS 事件任务访问(分片重组)
  hal_net::WsMessage message;
  int close_code = 1005;  ///< 1005 = 无 close 帧
  std::string close_reason;
};
using WsPtr = std::shared_ptr<WsClient>;

// 显式持有标准 transport，握手完成后可以配置真实 TCP socket；TLS 仍校验证书包。
static bool ws_create_transport(const WsPtr& ws, const std::string& subprotocol) {
  http_parser_url parsed{};
  http_parser_url_init(&parsed);
  if (http_parser_parse_url(ws->url.c_str(), ws->url.size(), 0, &parsed) != 0) return false;
  auto field = [&](http_parser_url_fields id) {
    return ws->url.substr(parsed.field_data[id].off, parsed.field_data[id].len);
  };
  const bool secure = ws->url.rfind("wss://", 0) == 0;
  ws->stream_transport = secure ? esp_transport_ssl_init() : esp_transport_tcp_init();
  if (!ws->stream_transport) return false;
  if (secure) esp_transport_ssl_crt_bundle_attach(ws->stream_transport, esp_crt_bundle_attach);
  ws->ws_transport = esp_transport_ws_init(ws->stream_transport);
  if (!ws->ws_transport) return false;
  ws_frame_transport_register(ws->ws_transport, ws->stream_transport);
  esp_transport_set_default_port(ws->ws_transport, secure ? 443 : 80);
  std::string path = field(UF_PATH);
  if (path.empty()) path = "/";
  if (parsed.field_data[UF_QUERY].len) path += "?" + field(UF_QUERY);
  std::string auth;
  if (parsed.field_data[UF_USERINFO].len) {
    std::string user = field(UF_USERINFO);
    if (user.find(':') == std::string::npos) user += ':';
    std::vector<unsigned char> encoded(4 * ((user.size() + 2) / 3) + 1);
    size_t length = 0;
    if (mbedtls_base64_encode(encoded.data(), encoded.size(), &length,
        reinterpret_cast<const unsigned char*>(user.data()), user.size()) != 0) return false;
    auth = "Basic " + std::string(reinterpret_cast<const char*>(encoded.data()), length);
  }
  esp_transport_ws_config_t config{};
  config.ws_path = path.c_str();
  config.sub_protocol = subprotocol.empty() ? nullptr : subprotocol.c_str();
  config.auth = auth.empty() ? nullptr : auth.c_str();
  config.propagate_control_frames = true;
  return esp_transport_ws_set_config(ws->ws_transport, &config) == ESP_OK;
}

static JSClassID g_ws_class_id;

// ------------------------------------------------------------ 工具

static WsPtr ws_from_this(JSContext* ctx, JSValueConst this_val) {
  auto* sp = static_cast<WsPtr*>(JS_GetOpaque(this_val, g_ws_class_id));
  return sp ? *sp : nullptr;
}

// 每个连接只安排一个消费者，send/close/destroy 严格有序；TLS 等待不会阻塞 JS 绘制。
static bool ws_submit_work(const WsPtr& ws, std::function<void()> action) {
  std::lock_guard<std::mutex> lock(ws->work_mutex);
  ws->work.push_back(std::move(action));
  if (ws->work_running) return true;
  ws->work_running = true;
  if (pxjs::worker_submit([ws]() {
    const UBaseType_t previous = uxTaskPriorityGet(nullptr);
    vTaskPrioritySet(nullptr, std::max(previous,
        std::min<UBaseType_t>(CONFIG_JSVM_TASK_PRIORITY + 1, configMAX_PRIORITIES - 1)));
    for (;;) {
      std::function<void()> next;
      {
        std::lock_guard<std::mutex> lock(ws->work_mutex);
        if (ws->work.empty()) { ws->work_running = false; break; }
        next = std::move(ws->work.front()); ws->work.pop_front();
      }
      next();
    }
    vTaskPrioritySet(nullptr, previous);
  }, true)) return true;
  ws->work.clear(); ws->work_running = false;
  return false;
}

/** 惰性销毁底层客户端(阻塞操作丢给 worker);destroy 后回收事件处理器引用 */
static void ws_schedule_destroy(const WsPtr& ws) {
  if (ws->destroy_scheduled || !ws->handle) return;
  ws->destroy_scheduled = true;
  esp_websocket_client_handle_t h = ws->handle;
  void* href = ws->handler_ref;
  ws->handle = nullptr;
  ws->handler_ref = nullptr;
  ws_submit_work(ws, [h, href]() {
    esp_websocket_client_destroy(h);  // 内部先 stop 事件任务,之后不会再有事件回调
    delete static_cast<WsPtr*>(href);
  });
}

/** JS 线程:取 obj.<prop> 若为函数则以 ev 为参调用(消费 ev) */
static void ws_call_handler(const WsPtr& ws, const char* prop, JSValue ev) {
  JSContext* ctx = ws->ctx;
  // VM 热重启后 ctx 地址可能被复用,不可比较指针;gen 失配即 self/ev 属旧 runtime,不可再触碰
  if (pxjs::vm_stale(ws->gen)) return;
  if (ws->self.empty()) {
    JS_FreeValue(ctx, ev);
    return;
  }
  JSValue fn = JS_GetPropertyStr(ctx, ws->self.get(), prop);
  if (JS_IsFunction(ctx, fn)) {
    JSValue ret = JS_Call(ctx, fn, ws->self.get(), 1, &ev);
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
  if (!pxjs::vm_stale(ws->gen) && !ws->self.empty()) {
    JSValue ev = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, ev, "type", JS_NewString(ctx, "close"));
    JS_SetPropertyStr(ctx, ev, "code", JS_NewInt32(ctx, code));
    JS_SetPropertyStr(ctx, ev, "reason", JS_NewString(ctx, reason.c_str()));
    ws_call_handler(ws, "onclose", ev);
  }
  ws->self.release(ctx);  // VM 已重启时内部只注销, 不碰旧 runtime
  ws_schedule_destroy(ws);
}

// ------------------------------------------------------------ WS 事件(esp_websocket 任务)

static void ws_event_handler(void* arg, esp_event_base_t, int32_t event_id, void* event_data) {
  auto* spp = static_cast<WsPtr*>(arg);
  WsPtr ws = *spp;
  auto* data = static_cast<esp_websocket_event_data_t*>(event_data);

  switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED: {
      if (ws->state.load() >= 2) break;
      // WebSocket 头和 PCM 分两次 write；Nagle 等待手机延迟 ACK 时会持续压住尾包。
      // 手机端的 TCP_NODELAY 只影响下行，设备上行必须在自己的 socket 上设置。
      const int fd = esp_transport_get_socket(ws->ws_transport);
      const int enabled = 1;
      if (fd < 0 || setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled)) != 0) {
        ESP_LOGE(TAG, "TCP_NODELAY setup failed");
        pxjs::run_on_js([ws]() { ws_dispatch_terminal(ws, 1011, "TCP setup failed"); });
        break;
      }
      ws->state.store(1);
      pxjs::run_on_js([ws]() {
        if (pxjs::vm_stale(ws->gen)) return;
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
          std::lock_guard<std::mutex> lock(ws->close_mutex);
          const uint8_t* p = reinterpret_cast<const uint8_t*>(data->data_ptr);
          ws->close_code = (p[0] << 8) | p[1];
          ws->close_reason.assign(reinterpret_cast<const char*>(p) + 2, data->data_len - 2);
        }
        break;
      }
      if (ws->state.load() >= 2) break;
      const auto result = ws->message.feed(op, data->fin, data->payload_offset,
          data->payload_len, data->data_ptr, data->data_len);
      if (result == hal_net::WsMessage::Result::Invalid) {
        ws->state.store(3);
        pxjs::run_on_js([ws]() { ws_dispatch_terminal(ws, 1002, "Invalid or oversized message"); });
        break;
      }
      if (result == hal_net::WsMessage::Result::Complete) {
        // 消息完整,投递 JS
        bool is_text = ws->message.type == 0x01;
        auto payload = std::make_shared<std::vector<uint8_t>>(std::move(ws->message.bytes));
        const int64_t received = esp_timer_get_time();
        pxjs::run_on_js([ws, payload, is_text, received]() {
          if (pxjs::vm_stale(ws->gen)) return;
          const int64_t now = esp_timer_get_time();
          const int64_t delay = (now - received) / 1000;
          ws->queue_delay_max_ms = std::max(ws->queue_delay_max_ms, delay);
          ws->received_messages++;
          // USB 串口日志也会等待；逐条打印延迟会反过来放大增量消息积压。
          if (now - ws->queue_report_us >= 5000000) {
            const auto stats = jsvm::runtime_stats();
            ESP_LOGI(TAG, "message JS queue: max=%lld ms messages=%u pending=%lu source-max=%lld job-max=%lld ms",
                (long long)ws->queue_delay_max_ms, unsigned(ws->received_messages), (unsigned long)stats.queue_depth,
                (long long)(stats.max_source_us / 1000), (long long)(stats.max_job_us / 1000));
            ws->queue_report_us = now;
          }
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
      if (data) ESP_LOGW(TAG, "transport error: type=%d errno=%d tls=%d free=%u largest=%u",
          int(data->error_handle.error_type),
          data->error_handle.error_type == WEBSOCKET_ERROR_TYPE_TCP_TRANSPORT ? data->error_handle.esp_transport_sock_errno : 0,
          data->error_handle.error_type == WEBSOCKET_ERROR_TYPE_TCP_TRANSPORT ? data->error_handle.esp_tls_stack_err : 0,
          unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
          unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
      pxjs::run_on_js([ws]() {
        if (pxjs::vm_stale(ws->gen)) return;
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
      std::lock_guard<std::mutex> lock(ws->close_mutex);
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

  const bool is_text = JS_IsString(argv[0]);
  std::vector<uint8_t> bytes;
  if (JS_IsString(argv[0])) {
    std::string s = pxjs::to_std_string(ctx, argv[0]);
    bytes.assign(s.begin(), s.end());
  } else {
    if (!pxjs::get_binary(ctx, argv[0], bytes))
      return pxjs::throw_msg(ctx, "send 仅支持 string / ArrayBuffer / Uint8Array");
  }
  const size_t size = bytes.size();
  {
    std::lock_guard<std::mutex> lock(ws->work_mutex);
    if (size > 65536 - ws->queued_bytes || ws->queued_messages >= 16)
      return pxjs::throw_msg(ctx, "WebSocket 发送队列已满");
    ws->queued_bytes += size; ws->queued_messages++;
  }
  const auto handle = ws->handle;
  const bool queued = ws_submit_work(ws, [ws, handle, bytes = std::move(bytes), is_text]() {
    int sent = int(bytes.size());
    const int64_t started = esp_timer_get_time();
    int64_t ready_us = started;
    if (!pxjs::vm_stale(ws->gen) && ws->state.load() != 3) {
      // ESP 客户端把 poll_write 超时也当作传输错误并销毁 TCP。尚未写帧时先在
      // worker 等待可写，让 TCP 重传和 JS 背压恢复有机会完成，不占住收发锁。
      int writable = 0;
      while (!pxjs::vm_stale(ws->gen) && ws->state.load() != 3
          && esp_timer_get_time() - started < kNetworkTimeoutMs * 1000LL) {
        writable = esp_transport_poll_write(ws->stream_transport, 100);
        if (writable != 0) break;
      }
      ready_us = esp_timer_get_time();
      if (writable > 0 && ws->state.load() != 3) {
        const char* data = bytes.empty() ? "" : reinterpret_cast<const char*>(bytes.data());
        // 一旦开始写帧便不能重发整包，否则会破坏帧边界；沿用完整网络操作的超时。
        sent = is_text ? esp_websocket_client_send_text(handle, data, bytes.size(), pdMS_TO_TICKS(kNetworkTimeoutMs))
                       : esp_websocket_client_send_bin(handle, data, bytes.size(), pdMS_TO_TICKS(kNetworkTimeoutMs));
      } else if (ws->state.load() != 3 && !pxjs::vm_stale(ws->gen)) {
        sent = -1;
      }
    }
    const int64_t completed_us = esp_timer_get_time();
    if (completed_us - started >= 1000000 && completed_us - ws->diagnostic_us >= 15000000) {
      ws->diagnostic_us = completed_us;
      ESP_LOGW(TAG, "slow send: wait=%lld write=%lld ms internal=%u largest=%u",
          (long long)((ready_us - started) / 1000), (long long)((completed_us - ready_us) / 1000),
          unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
          unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    }
    {
      std::lock_guard<std::mutex> lock(ws->work_mutex);
      ws->queued_bytes -= bytes.size(); ws->queued_messages--;
      ws->send_max_ms = std::max(ws->send_max_ms, (esp_timer_get_time() - started) / 1000);
      if (sent > 0) ws->sent_bytes += sent;
      if (started - ws->send_report_us >= 5000000) {
        ESP_LOGI(TAG, "send: bytes=%llu pending=%u/%u max=%lld ms",
            (unsigned long long)ws->sent_bytes, unsigned(ws->queued_bytes),
            unsigned(ws->queued_messages), (long long)ws->send_max_ms);
        ws->send_report_us = started;
        ws->send_max_ms = 0;
      }
    }
    if (sent == int(bytes.size())) return;
    // 错误回调异步投递给 JS；先停止后续写入，避免回调尚未执行时继续发送排队帧。
    ws->state.store(3);
    pxjs::run_on_js([ws]() {
      if (!pxjs::vm_stale(ws->gen)) {
        JSValue ev = JS_NewObject(ws->ctx);
        JS_SetPropertyStr(ws->ctx, ev, "type", JS_NewString(ws->ctx, "error"));
        JS_SetPropertyStr(ws->ctx, ev, "message", JS_NewString(ws->ctx, "WebSocket 发送失败"));
        ws_call_handler(ws, "onerror", ev);
      }
      ws_dispatch_terminal(ws, 1006, "Send failed");
    });
  });
  if (!queued) {
    std::lock_guard<std::mutex> lock(ws->work_mutex);
    ws->queued_bytes -= size; ws->queued_messages--;
    return pxjs::throw_msg(ctx, "WebSocket 发送任务创建失败");
  }
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
  ws_submit_work(ws, [h, code, reason, has_code, ws]() {
    if (!h) return;
    if (has_code || !reason.empty()) {
      esp_websocket_client_close_with_code(h, code, reason.c_str(), (int)reason.size(),
                                           pdMS_TO_TICKS(3000));
    } else {
      esp_websocket_client_close(h, pdMS_TO_TICKS(3000));
    }
    // close 超时/失败也要保证终态派发(正常路径由 CLOSED/DISCONNECTED 事件触发,这里兜底)
    int code;
    std::string reason;
    { std::lock_guard<std::mutex> lock(ws->close_mutex); code = ws->close_code; reason = ws->close_reason; }
    pxjs::run_on_js([ws, code, reason]() { ws_dispatch_terminal(ws, code, reason); });
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
  // Reserve a consumer before owning a client that needs asynchronous close/destroy.
  if (!pxjs::worker_submit([] {})) return pxjs::throw_msg(ctx, "NETWORK_WORKER_ALLOC_FAILED");

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
  ws->gen = jsvm::vm_generation();
  ws->url = url;
  if (!ws_create_transport(ws, subprotocol)) {
    JS_FreeValue(ctx, obj);
    return pxjs::throw_msg(ctx, "WebSocket transport 初始化失败");
  }

  esp_websocket_client_config_t cfg = {};
  cfg.uri = url.c_str();
  cfg.ext_transport = ws->ws_transport;
  if (!subprotocol.empty()) cfg.subprotocol = subprotocol.c_str();
  cfg.disable_auto_reconnect = true;  // 浏览器语义:断了就是断了
  cfg.buffer_size = 4096;
  cfg.network_timeout_ms = kNetworkTimeoutMs;
  cfg.task_stack = 6144;
  cfg.task_prio = std::min(CONFIG_JSVM_TASK_PRIORITY + 1, configMAX_PRIORITIES - 1);
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
  ws->self.hold(ctx, obj);  // 连接期间保活

  if (esp_websocket_client_start(ws->handle) != ESP_OK) {
    ws->self.release(ctx);
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
