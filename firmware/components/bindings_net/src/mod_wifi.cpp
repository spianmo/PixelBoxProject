/**
 * mod_wifi.cpp — px.wifi 绑定(对齐 sdk/types/pixelbox.d.ts PxWifi)
 *
 *   scan(): Promise<PxWifiAp[]>
 *   connect(ssid, password?, opts?): Promise<PxWifiStatus>   // 拿到 IP 才 resolve
 *   disconnect(): void
 *   status(): PxWifiStatus
 *   on('connected'|'disconnected'|'gotIp', cb): Unsubscribe
 *   startAP(ssid, password?): void
 *   stopAP(): void
 *
 * HAL 事件在 esp_event 任务触发,这里一律经 jsvm 事件循环投递到 JS 线程。
 */
#include <memory>
#include <vector>

#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi_types.h"
#include "hal_net/wifi_manager.hpp"
#include "js_helpers.hpp"
#include "jsvm/jsvm.hpp"

using hal_net::WifiEvent;
using hal_net::WifiManager;
using hal_net::WifiStatus;
using pxjs::PromisePtr;

static const char* TAG = "px_wifi_js";

// ------------------------------------------------------------ 模块级状态(仅 JS 线程访问)

static pxjs::SubRegistry g_sub_connected;
static pxjs::SubRegistry g_sub_disconnected;
static pxjs::SubRegistry g_sub_gotip;

/** 等待 connect() 结果的挂起项 */
struct ConnectWait {
  PromisePtr promise;
  esp_timer_handle_t timer = nullptr;
  bool done = false;
};
static std::vector<std::shared_ptr<ConnectWait>>* g_connect_waits = nullptr;

static int g_hal_listener_id = -1;

// ------------------------------------------------------------ 工具

/** WifiStatus → JS 对象 */
static JSValue status_to_js(JSContext* ctx, const WifiStatus& st) {
  JSValue o = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, o, "connected", JS_NewBool(ctx, st.connected));
  JS_SetPropertyStr(ctx, o, "ssid",
                    st.ssid.empty() ? JS_NULL : JS_NewString(ctx, st.ssid.c_str()));
  JS_SetPropertyStr(ctx, o, "ip", st.ip.empty() ? JS_NULL : JS_NewString(ctx, st.ip.c_str()));
  JS_SetPropertyStr(ctx, o, "rssi", JS_NewInt32(ctx, st.rssi));
  JS_SetPropertyStr(ctx, o, "mac", JS_NewString(ctx, st.mac.c_str()));
  return o;
}

static void settle_wait(std::shared_ptr<ConnectWait> w) {
  // JS 线程:清理定时器
  w->done = true;
  if (w->timer) {
    esp_timer_stop(w->timer);
    esp_timer_delete(w->timer);
    w->timer = nullptr;
  }
}

/** 断开原因是否属于「本次连接注定失败」,用于提前 reject connect() */
static bool reason_is_fatal(int reason) {
  switch (reason) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_NO_AP_FOUND:
      return true;
    default:
      return false;
  }
}

/** HAL 事件 → JS 线程分发(在 JS 线程执行) */
static void dispatch_event_js(WifiEvent ev, WifiStatus st, int reason) {
  JSContext* ctx = pxjs::g_ctx;
  if (!ctx) return;
  JSValue stv = status_to_js(ctx, st);

  switch (ev) {
    case WifiEvent::Connected:
      g_sub_connected.dispatch(ctx, 1, &stv);
      break;
    case WifiEvent::GotIp: {
      g_sub_gotip.dispatch(ctx, 1, &stv);
      // 同时也是 connect() 成功的时刻
      if (g_connect_waits) {
        auto waits = *g_connect_waits;
        g_connect_waits->clear();
        for (auto& w : waits) {
          if (w->done) continue;
          settle_wait(w);
          w->promise->resolve_now(status_to_js(ctx, st));
        }
      }
      break;
    }
    case WifiEvent::Disconnected: {
      g_sub_disconnected.dispatch(ctx, 1, &stv);
      if (g_connect_waits && reason_is_fatal(reason)) {
        auto waits = *g_connect_waits;
        g_connect_waits->clear();
        for (auto& w : waits) {
          if (w->done) continue;
          settle_wait(w);
          char msg[64];
          snprintf(msg, sizeof(msg), "WiFi 连接失败 (reason=%d)", reason);
          JSValue err = JS_NewError(ctx);
          JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, msg),
                                    JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
          w->promise->reject_now(err);
        }
      }
      break;
    }
  }
  JS_FreeValue(ctx, stv);
}

// ------------------------------------------------------------ 方法实现

static JSValue js_scan(JSContext* ctx, JSValueConst, int, JSValueConst*) {
  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);
  esp_err_t err = WifiManager::instance().scan(
      [prom](esp_err_t e, std::vector<hal_net::WifiApInfo> aps) {
        // esp_event 任务上下文 → 投递 JS
        if (e != ESP_OK) {
          prom->reject_msg("WiFi 扫描失败");
          return;
        }
        prom->resolve_on_js([aps = std::move(aps)](JSContext* c) {
          JSValue arr = JS_NewArray(c);
          uint32_t i = 0;
          for (const auto& a : aps) {
            JSValue o = JS_NewObject(c);
            JS_SetPropertyStr(c, o, "ssid", JS_NewString(c, a.ssid.c_str()));
            JS_SetPropertyStr(c, o, "rssi", JS_NewInt32(c, a.rssi));
            JS_SetPropertyStr(c, o, "secure", JS_NewBool(c, a.secure));
            JS_SetPropertyStr(c, o, "channel", JS_NewInt32(c, a.channel));
            JS_SetPropertyUint32(c, arr, i++, o);
          }
          return arr;
        });
      });
  if (err != ESP_OK) {
    prom->reject_msg(err == ESP_ERR_INVALID_STATE ? "已有扫描进行中" : "WiFi 扫描启动失败");
  }
  return promv;
}

static void connect_timeout_cb(void* arg) {
  // esp_timer 任务上下文
  auto* wp = static_cast<std::shared_ptr<ConnectWait>*>(arg);
  std::shared_ptr<ConnectWait> w = *wp;
  delete wp;
  pxjs::run_on_js([w]() {
    if (w->done) return;
    w->done = true;
    if (w->timer) {
      // 此处在 JS 线程执行,已不在 esp_timer 回调上下文,可安全删除
      esp_timer_delete(w->timer);
      w->timer = nullptr;
    }
    if (g_connect_waits) {
      for (auto it = g_connect_waits->begin(); it != g_connect_waits->end(); ++it) {
        if (*it == w) {
          g_connect_waits->erase(it);
          break;
        }
      }
    }
    w->promise->reject_msg("WiFi 连接超时");
  });
}

static JSValue js_connect(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1) return pxjs::throw_msg(ctx, "connect(ssid, password?, opts?) 缺少 ssid");
  std::string ssid = pxjs::to_std_string(ctx, argv[0]);
  std::string pass;
  if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]))
    pass = pxjs::to_std_string(ctx, argv[1]);
  JSValueConst opts = argc >= 3 ? argv[2] : JS_UNDEFINED;
  int timeout_ms = pxjs::opt_int_prop(ctx, opts, "timeoutMs", 15000);
  bool save = pxjs::opt_bool_prop(ctx, opts, "save", true);

  JSValue promv;
  auto prom = pxjs::Promise::create(ctx, &promv);

  esp_err_t err = WifiManager::instance().connect(ssid, pass, save);
  if (err != ESP_OK) {
    prom->reject_msg(std::string("WiFi 连接发起失败: ") + esp_err_to_name(err));
    return promv;
  }

  auto w = std::make_shared<ConnectWait>();
  w->promise = prom;

  // 超时定时器(esp_timer 任务回调 → 投递 JS reject)
  auto* arg = new std::shared_ptr<ConnectWait>(w);
  esp_timer_create_args_t targs = {};
  targs.callback = &connect_timeout_cb;
  targs.arg = arg;
  targs.name = "px_wifi_cto";
  if (esp_timer_create(&targs, &w->timer) == ESP_OK) {
    esp_timer_start_once(w->timer, (uint64_t)timeout_ms * 1000);
  } else {
    delete arg;
    w->timer = nullptr;
  }

  if (!g_connect_waits) g_connect_waits = new std::vector<std::shared_ptr<ConnectWait>>();
  g_connect_waits->push_back(w);
  return promv;
}

static JSValue js_disconnect(JSContext* ctx, JSValueConst, int, JSValueConst*) {
  WifiManager::instance().disconnect();
  return JS_UNDEFINED;
}

static JSValue js_status(JSContext* ctx, JSValueConst, int, JSValueConst*) {
  return status_to_js(ctx, WifiManager::instance().status());
}

static JSValue js_on(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 2 || !JS_IsFunction(ctx, argv[1]))
    return pxjs::throw_msg(ctx, "on(event, cb) 参数错误");
  std::string ev = pxjs::to_std_string(ctx, argv[0]);
  if (ev == "connected") return g_sub_connected.add(ctx, argv[1]);
  if (ev == "disconnected") return g_sub_disconnected.add(ctx, argv[1]);
  if (ev == "gotIp") return g_sub_gotip.add(ctx, argv[1]);
  return pxjs::throw_msg(ctx, "未知 wifi 事件: %s", ev.c_str());
}

static JSValue js_start_ap(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  if (argc < 1) return pxjs::throw_msg(ctx, "startAP(ssid, password?) 缺少 ssid");
  std::string ssid = pxjs::to_std_string(ctx, argv[0]);
  std::string pass;
  if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1]))
    pass = pxjs::to_std_string(ctx, argv[1]);
  esp_err_t err = WifiManager::instance().start_ap(ssid, pass);
  if (err != ESP_OK) return pxjs::throw_msg(ctx, "SoftAP 启动失败: %s", esp_err_to_name(err));
  return JS_UNDEFINED;
}

static JSValue js_stop_ap(JSContext* ctx, JSValueConst, int, JSValueConst*) {
  WifiManager::instance().stop_ap();
  return JS_UNDEFINED;
}

// ------------------------------------------------------------ 模块注册

static void wifi_module_init(JSContext* ctx, JSValue px) {
  pxjs::set_ctx(ctx);

  // VM 热重启:丢弃旧订阅与挂起 connect(旧 JSValue 随旧 runtime 回收)
  g_sub_connected.clear();
  g_sub_disconnected.clear();
  g_sub_gotip.clear();
  if (g_connect_waits) g_connect_waits->clear();

  WifiManager::instance().ensure_init();

  // HAL 监听只装一次(跨 VM 重启复用);回调经 jsvm 事件循环投递
  if (g_hal_listener_id < 0) {
    g_hal_listener_id = WifiManager::instance().add_listener(
        [](WifiEvent ev, const WifiStatus& st, int reason) {
          pxjs::run_on_js([ev, st, reason]() { dispatch_event_js(ev, st, reason); });
        });
  }

  JSValue wifi = JS_NewObject(ctx);
  pxjs::set_method(ctx, wifi, "scan", js_scan, 0);
  pxjs::set_method(ctx, wifi, "connect", js_connect, 3);
  pxjs::set_method(ctx, wifi, "disconnect", js_disconnect, 0);
  pxjs::set_method(ctx, wifi, "status", js_status, 0);
  pxjs::set_method(ctx, wifi, "on", js_on, 2);
  pxjs::set_method(ctx, wifi, "startAP", js_start_ap, 2);
  pxjs::set_method(ctx, wifi, "stopAP", js_stop_ap, 0);
  JS_SetPropertyStr(ctx, px, "wifi", wifi);

  ESP_LOGI(TAG, "px.wifi 已注册");
}

static const jsvm::Module k_wifi_module = {
    .name = "wifi",
    .priority = 10,
    .init = wifi_module_init,
    .prelude = nullptr,
};
JSVM_REGISTER_MODULE(k_wifi_module);
