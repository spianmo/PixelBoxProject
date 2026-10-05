/* 绑定只排队 service 动作。VM 回收不拥有门户，也不会停止下一代会话。 */
#include "quickjs.h"
#include "pixelbox_portal.h"
#include <errno.h>

static JSValue portal_error(JSContext *ctx, int error)
{
  const char *code = error == -ENODEV ? "ENODEV" : error == -EBUSY ? "EBUSY" :
    error == -ECANCELED ? "ECANCELED" : error == -ENOTSUP ? "ENOTSUP" : "EIO";
  return JS_ThrowInternalError(ctx, "%s: Wi-Fi portal (%d)", code, error);
}
static int property(JSContext *ctx, JSValue object, const char *name, JSValue value)
{ return JS_IsException(value) ? -1 : JS_DefinePropertyValueStr(ctx, object, name, value, JS_PROP_C_W_E); }
static JSValue portal_call(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic)
{
  (void)self; (void)argc; (void)argv;
  if (magic != 2) {
    int error = magic ? px_portal_stop() : px_portal_request_start();
    return error ? portal_error(ctx, error) : JS_UNDEFINED;
  }
  struct px_portal_status status;
  int error = px_portal_get_status(&status);
  if (error) return portal_error(ctx, error);
  JSValue value = JS_NewObject(ctx);
  if (JS_IsException(value)) return value;
  if (property(ctx, value, "phase", JS_NewString(ctx, px_portal_phase_name(status.phase))) < 0 ||
      property(ctx, value, "active", JS_NewBool(ctx, status.active)) < 0 ||
      property(ctx, value, "wifiOwned", JS_NewBool(ctx, status.wifi_owned)) < 0 ||
      property(ctx, value, "generation", JS_NewUint32(ctx, status.generation)) < 0 ||
      property(ctx, value, "error", JS_NewInt32(ctx, status.error)) < 0 ||
      property(ctx, value, "ssid", JS_NewString(ctx, status.ssid)) < 0 ||
      property(ctx, value, "ip", JS_NewString(ctx, status.ip)) < 0 ||
      property(ctx, value, "apSsid", JS_NewString(ctx, status.ap_ssid)) < 0 ||
      property(ctx, value, "message", JS_NewString(ctx, status.message)) < 0) {
    JS_FreeValue(ctx, value); return JS_EXCEPTION;
  }
  return value;
}
void px_install_portal(JSContext *ctx, JSValue native)
{
  JSValue api = JS_NewObject(ctx);
  if (JS_IsException(api)) return;
  const char *names[] = {"start", "stop", "status"};
  for (int i = 0; i < 3; ++i)
    if (property(ctx, api, names[i], JS_NewCFunctionMagic(ctx, portal_call, names[i], 0, JS_CFUNC_generic_magic, i)) < 0) {
      JS_FreeValue(ctx, api); return;
    }
  property(ctx, native, "wifiPortal", api);
}
