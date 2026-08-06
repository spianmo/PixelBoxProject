/**
 * mod_net_stub.cpp — 无片上网络目标 (ESP32-P4) 的网络绑定桩
 *
 * 与其余 mod_*.cpp 互斥编译 (CMakeLists 按 CONFIG_SOC_WIFI_SUPPORTED 选择)。
 * 按 d.ts 契约注册完整 API 表面, 行为如实降级 (d.ts 第 16 行约定:
 * 硬件不存在/未启用时方法抛 Error("ENOTSUP")):
 *
 *   - px.wifi: scan/connect → reject(ENOTSUP); status() 如实返回未连接
 *     快照 (mac = eFuse 基础 MAC); on() 可订阅但永不触发;
 *   - px.net: connectTcp → reject; listenTcp/createUdp/mdns.* → 抛 ENOTSUP;
 *     hostname() 返回默认主机名;
 *   - 全局 fetch → reject(ENOTSUP); 全局 WebSocket 构造即抛 ENOTSUP
 *     (静态常量 CONNECTING/OPEN/CLOSING/CLOSED 按 d.ts 保留);
 *   - px.system.ntpSync/otaCheck/otaApply → reject(ENOTSUP)。
 *
 * P4 联网需 esp_hosted (P4 + C6 组合, esp_wifi_remote), 接入后本桩
 * 整体切回真实实现, 见 docs/hardware/multi-target.md 的 TODO。
 */
#include <cstdio>

#include "esp_log.h"
#include "esp_mac.h"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"
#include "sdkconfig.h"

namespace {

constexpr const char* TAG = "px_net_stub";

/* ------------------------------------------------------------ 小工具 */

/** 返回一个已被 Error("ENOTSUP") 拒绝的 Promise */
JSValue rejected_enotsup(JSContext* ctx)
{
    JSValue funcs[2];
    JSValue prom = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(prom)) return prom;
    JSValue err = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, "ENOTSUP"));
    JSValue r = JS_Call(ctx, funcs[1], JS_UNDEFINED, 1, &err);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, err);
    JS_FreeValue(ctx, funcs[0]);
    JS_FreeValue(ctx, funcs[1]);
    return prom;
}

JSValue js_reject_enotsup(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return rejected_enotsup(ctx);
}

JSValue js_throw_enotsup(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return jsvm::throw_enotsup(ctx);
}

JSValue js_noop(JSContext*, JSValueConst, int, JSValueConst*)
{
    return JS_UNDEFINED;
}

/** on(event, cb): 可订阅但永不触发, 返回 noop unsubscribe */
JSValue js_on_noop(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return JS_NewCFunction(ctx, js_noop, "unsubscribe", 0);
}

void set_method(JSContext* ctx, JSValue obj, const char* name, JSCFunction* fn, int len)
{
    JS_SetPropertyStr(ctx, obj, name, JS_NewCFunction(ctx, fn, name, len));
}

/* ------------------------------------------------------------ px.wifi */

/** status(): 如实返回未连接快照 (无 WiFi MAC, 用 eFuse 基础 MAC) */
JSValue js_wifi_status(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "connected", JS_NewBool(ctx, false));
    JS_SetPropertyStr(ctx, o, "ssid", JS_NULL);
    JS_SetPropertyStr(ctx, o, "ip", JS_NULL);
    JS_SetPropertyStr(ctx, o, "rssi", JS_NewInt32(ctx, 0));
    uint8_t mac[6] = {};
    esp_read_mac(mac, ESP_MAC_BASE);
    char buf[18];
    snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    JS_SetPropertyStr(ctx, o, "mac", JS_NewString(ctx, buf));
    return o;
}

void wifi_module_init(JSContext* ctx, JSValue px)
{
    JSValue wifi = JS_NewObject(ctx);
    set_method(ctx, wifi, "scan", js_reject_enotsup, 0);
    set_method(ctx, wifi, "connect", js_reject_enotsup, 3);
    set_method(ctx, wifi, "disconnect", js_noop, 0);
    set_method(ctx, wifi, "status", js_wifi_status, 0);
    set_method(ctx, wifi, "on", js_on_noop, 2);
    set_method(ctx, wifi, "startAP", js_throw_enotsup, 2);
    set_method(ctx, wifi, "stopAP", js_noop, 0);
    JS_SetPropertyStr(ctx, px, "wifi", wifi);
    ESP_LOGI(TAG, "px.wifi 已注册 (无片上 WiFi, ENOTSUP 桩)");
}

/* ------------------------------------------------------------ px.net */

JSValue js_hostname(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return JS_NewString(ctx, "pixelbox");
}

void net_module_init(JSContext* ctx, JSValue px)
{
    JSValue net = JS_NewObject(ctx);
    set_method(ctx, net, "connectTcp", js_reject_enotsup, 1);
    set_method(ctx, net, "listenTcp", js_throw_enotsup, 1);
    set_method(ctx, net, "createUdp", js_throw_enotsup, 1);
    set_method(ctx, net, "hostname", js_hostname, 0);
    JSValue mdns_obj = JS_NewObject(ctx);
    set_method(ctx, mdns_obj, "discover", js_reject_enotsup, 2);
    set_method(ctx, mdns_obj, "advertise", js_throw_enotsup, 1);
    JS_SetPropertyStr(ctx, net, "mdns", mdns_obj);
    JS_SetPropertyStr(ctx, px, "net", net);
    ESP_LOGI(TAG, "px.net 已注册 (无片上网络, ENOTSUP 桩)");
}

/* ------------------------------------------------------------ 全局 fetch / WebSocket */

void fetch_module_init(JSContext* ctx, JSValue)
{
    JSValue global = JS_GetGlobalObject(ctx);
    set_method(ctx, global, "fetch", js_reject_enotsup, 2);
    JS_FreeValue(ctx, global);
    ESP_LOGI(TAG, "全局 fetch 已注册 (ENOTSUP 桩)");
}

JSValue js_ws_ctor(JSContext* ctx, JSValueConst, int, JSValueConst*)
{
    return jsvm::throw_enotsup(ctx);
}

void ws_module_init(JSContext* ctx, JSValue)
{
    JSValue ctor = JS_NewCFunction2(ctx, js_ws_ctor, "WebSocket", 2, JS_CFUNC_constructor, 0);
    // 静态常量对齐 d.ts (构造即抛 ENOTSUP, 常量仍可读)
    JS_DefinePropertyValueStr(ctx, ctor, "CONNECTING", JS_NewInt32(ctx, 0), 0);
    JS_DefinePropertyValueStr(ctx, ctor, "OPEN", JS_NewInt32(ctx, 1), 0);
    JS_DefinePropertyValueStr(ctx, ctor, "CLOSING", JS_NewInt32(ctx, 2), 0);
    JS_DefinePropertyValueStr(ctx, ctor, "CLOSED", JS_NewInt32(ctx, 3), 0);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "WebSocket", ctor);
    JS_FreeValue(ctx, global);
    ESP_LOGI(TAG, "全局 WebSocket 已注册 (ENOTSUP 桩)");
}

/* ------------------------------------------------------------ px.system 网络子功能 */

void system_net_module_init(JSContext* ctx, JSValue px)
{
    JSValue sys = JS_GetPropertyStr(ctx, px, "system");
    if (!JS_IsObject(sys)) {
        JS_FreeValue(ctx, sys);
        sys = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, px, "system", JS_DupValue(ctx, sys));
    }
    set_method(ctx, sys, "ntpSync", js_reject_enotsup, 1);
    set_method(ctx, sys, "otaCheck", js_reject_enotsup, 1);
    set_method(ctx, sys, "otaApply", js_reject_enotsup, 2);
    JS_FreeValue(ctx, sys);
    ESP_LOGI(TAG, "px.system 网络子功能已注册 (ENOTSUP 桩)");
}

/* ------------------------------------------------------------ 模块注册 (priority 与真实实现一致) */

const jsvm::Module k_wifi_module = {"wifi", 10, wifi_module_init, nullptr};
const jsvm::Module k_net_module = {"net", 10, net_module_init, nullptr};
const jsvm::Module k_fetch_module = {"fetch", 10, fetch_module_init, nullptr};
const jsvm::Module k_ws_module = {"websocket", 10, ws_module_init, nullptr};
const jsvm::Module k_system_net_module = {"system_net", 20, system_net_module_init, nullptr};

}  // namespace

JSVM_REGISTER_MODULE(k_wifi_module);
JSVM_REGISTER_MODULE(k_net_module);
JSVM_REGISTER_MODULE(k_fetch_module);
JSVM_REGISTER_MODULE(k_ws_module);
JSVM_REGISTER_MODULE(k_system_net_module);
