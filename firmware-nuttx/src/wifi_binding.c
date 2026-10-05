/* 无线后台仅持有 C 数据；QuickJS 对象统一在调用线程创建。 */
#include "quickjs.h"
#include "pixelbox_wifi.h"
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

static JSValue wifi_error(JSContext *ctx, int error)
{
  if (error == -ENOTSUP) return JS_ThrowInternalError(ctx, "ENOTSUP");
  const char *code = error == -ENOTSUP ? "ENOTSUP" :
                     error == -EBUSY ? "EBUSY" :
                     error == -ETIMEDOUT ? "ETIMEDOUT" :
                     error == -ECANCELED ? "ECANCELED" : "EIO";
  return JS_ThrowInternalError(ctx, "%s: Wi-Fi (%d)", code, error);
}

static JSValue wifi_status_value(JSContext *ctx, const struct px_wifi_status *status)
{
  JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "connected", JS_NewBool(ctx, status->connected));
  JS_SetPropertyStr(ctx, value, "ssid", status->ssid[0] ? JS_NewString(ctx, status->ssid) : JS_NULL);
  JS_SetPropertyStr(ctx, value, "ip", status->connected ? JS_NewString(ctx, status->ip) : JS_NULL);
  JS_SetPropertyStr(ctx, value, "rssi", JS_NewInt32(ctx, status->rssi));
  JS_SetPropertyStr(ctx, value, "mac", JS_NewString(ctx, status->mac));
  return value;
}

static JSValue wifi_start(JSContext *ctx, JSValueConst self, int argc,
                          JSValueConst *argv, int connect)
{
  (void)self;
  unsigned timeout = connect ? 15000 : 10000;
  int timeout_index = connect ? 2 : 0;
  if (argc > timeout_index && !JS_IsUndefined(argv[timeout_index])) {
    double number;
    if (JS_ToFloat64(ctx, &number, argv[timeout_index])) return JS_EXCEPTION;
    if (!isfinite(number) || number < 1 || number > 120000)
      return JS_ThrowRangeError(ctx, "Wi-Fi timeout must be 1..120000 ms");
    timeout = (unsigned)number;
  }
  const char *ssid = NULL, *password = NULL;
  size_t ssid_len = 0, password_len = 0;
  if (connect) {
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
      return JS_ThrowTypeError(ctx, "Wi-Fi SSID and password must be strings");
    ssid = JS_ToCStringLen(ctx, &ssid_len, argv[0]);
    if (!ssid) return JS_EXCEPTION;
    password = JS_ToCStringLen(ctx, &password_len, argv[1]);
    if (!password) { JS_FreeCString(ctx, ssid); return JS_EXCEPTION; }
    if (!ssid_len || ssid_len > 32 || password_len > 64 ||
        memchr(ssid, 0, ssid_len) || memchr(password, 0, password_len)) {
      JS_FreeCString(ctx, ssid); JS_FreeCString(ctx, password);
      return JS_ThrowRangeError(ctx, "invalid Wi-Fi credential length or NUL");
    }
  }
  uint32_t id = 0;
  /* 真机无线由常驻boot任务初始化；JS不得在短命VM中创建替代服务线程。 */
#ifdef __NuttX__
  int result = 0;
#else
  int result = px_wifi_init("wlan0");
#endif
  if (!result) result = connect ? px_wifi_connect_start(ssid, password, timeout, &id)
                                 : px_wifi_scan_start(timeout, &id);
  JS_FreeCString(ctx, ssid); JS_FreeCString(ctx, password);
  return result < 0 ? wifi_error(ctx, result) : JS_NewUint32(ctx, id);
}

static JSValue wifi_status(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  struct px_wifi_status status = {0};
  /* 状态查询不启动无线线程；无网卡时仍保留公共 disconnected 契约。 */
  px_wifi_get_status(&status);
  return wifi_status_value(ctx, &status);
}

static JSValue wifi_disconnect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  int result = px_wifi_disconnect();
  return result < 0 && result != -ENOTSUP && result != -ENODEV
         ? wifi_error(ctx, result) : JS_UNDEFINED;
}

static JSValue wifi_abandon(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)ctx; (void)self; (void)argc; (void)argv;
  px_wifi_disconnect();
  /* 消费当前 VM 的即时取消结果；worker 的迟到结束不会再次结算同一作业。 */
  struct px_wifi_result discarded;
  px_wifi_poll(&discarded);
  return JS_UNDEFINED;
}

static JSValue wifi_poll(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  struct px_wifi_result result;
  int ret = px_wifi_poll(&result);
  if (ret == 0 || ret == -ENOTSUP || ret == -ENODEV) return JS_NULL;
  if (ret < 0) return wifi_error(ctx, ret);
  JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "id", JS_NewUint32(ctx, result.job_id));
  JS_SetPropertyStr(ctx, value, "operation", JS_NewInt32(ctx, result.operation));
  JS_SetPropertyStr(ctx, value, "error", JS_NewInt32(ctx, result.error));
  JS_SetPropertyStr(ctx, value, "events", JS_NewUint32(ctx, result.events));
  JS_SetPropertyStr(ctx, value, "status", wifi_status_value(ctx, &result.status));
  JSValue aps = JS_NewArray(ctx);
  for (size_t i = 0; i < result.ap_count && i < PX_WIFI_MAX_APS; ++i) {
    const struct px_wifi_ap *ap = &result.aps[i];
    JSValue item = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, item, "ssid", JS_NewString(ctx, ap->ssid));
    JS_SetPropertyStr(ctx, item, "rssi", JS_NewInt32(ctx, ap->rssi));
    JS_SetPropertyStr(ctx, item, "secure", JS_NewBool(ctx, ap->secure));
    JS_SetPropertyStr(ctx, item, "channel", JS_NewUint32(ctx, ap->channel));
    JS_SetPropertyUint32(ctx, aps, (uint32_t)i, item);
  }
  JS_SetPropertyStr(ctx, value, "aps", aps);
  return value;
}

void px_install_wifi(JSContext *ctx, JSValue native)
{
  JS_SetPropertyStr(ctx, native, "wifiScan", JS_NewCFunctionMagic(ctx, wifi_start, "wifiScan", 1, JS_CFUNC_generic_magic, 0));
  JS_SetPropertyStr(ctx, native, "wifiConnect", JS_NewCFunctionMagic(ctx, wifi_start, "wifiConnect", 3, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(ctx, native, "wifiStatus", JS_NewCFunction(ctx, wifi_status, "wifiStatus", 0));
  JS_SetPropertyStr(ctx, native, "wifiDisconnect", JS_NewCFunction(ctx, wifi_disconnect, "wifiDisconnect", 0));
  JS_SetPropertyStr(ctx, native, "wifiPoll", JS_NewCFunction(ctx, wifi_poll, "wifiPoll", 0));
  JS_SetPropertyStr(ctx, native, "wifiAbandon", JS_NewCFunction(ctx, wifi_abandon, "wifiAbandon", 0));
}
