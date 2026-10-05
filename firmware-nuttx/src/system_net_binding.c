/* 每个VM独立拥有NTP生命周期；native闭包固定owner，参数转换后再检查关闭状态。 */
#include "quickjs.h"
#include "pixelbox_system_net.h"
#include <errno.h>
#include <math.h>
#include <string.h>

struct system_net_owner { struct px_system_net *context; };
static void finalize_system_net(JSRuntime *runtime, JSValue value)
{
  struct system_net_owner *owner = JS_GetOpaque(value, JS_GetClassID(value));
  if (owner) { px_system_net_destroy(owner->context); js_free_rt(runtime, owner); }
}
static const JSClassDef system_net_definition = {
  .class_name = "PixelBoxSystemNet", .finalizer = finalize_system_net
};
static struct system_net_owner *system_owner(JSContext *ctx, JSValueConst self, int require_open)
{
  struct system_net_owner *owner = JS_GetOpaque2(ctx, self, JS_GetClassID(self));
  if (owner && require_open && !owner->context) {
    JS_ThrowInternalError(ctx, "ECANCELED: system network context is closed"); return NULL;
  }
  return owner;
}
static const char *system_error_code(int error)
{
  switch (error) {
    case 0: return "";
    case -ENOMEM: return "ENOMEM";
    case -EINVAL: return "EINVAL";
    case -EBUSY: return "EBUSY";
    case -ETIMEDOUT: return "ETIMEDOUT";
    case -ECANCELED: return "ECANCELED";
    case -EHOSTUNREACH: return "EHOSTUNREACH";
    case -EACCES: return "EACCES";
    case -EPERM: return "EPERM";
    case -ENOTSUP: return "ENOTSUP";
    case -ERANGE: return "ERANGE";
    case -EOVERFLOW: return "EOVERFLOW";
    default: return "SYSTEM_ERROR";
  }
}
static JSValue system_error(JSContext *ctx, int error)
{
  if (error == -ENOMEM) return JS_ThrowOutOfMemory(ctx);
  return JS_ThrowInternalError(ctx, "%s: system operation (%d)", system_error_code(error), error);
}
static int system_uint(JSContext *ctx, JSValueConst value, unsigned max, unsigned *output)
{
  double number;
  if (JS_ToFloat64(ctx, &number, value)) return -1;
  if (!isfinite(number) || number < 1 || number > max || number != floor(number)) {
    JS_ThrowRangeError(ctx, "system numeric argument out of range"); return -1;
  }
  *output = (unsigned)number; return 0;
}
static int system_property(JSContext *ctx, JSValue object, const char *name, JSValue value)
{
  return JS_IsException(value) ? -1 : JS_DefinePropertyValueStr(ctx, object, name, value, JS_PROP_C_W_E);
}
static JSValue start_ntp(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  if (!system_owner(ctx, self, 1)) return JS_EXCEPTION;
  unsigned timeout = PX_SYSTEM_NTP_TIMEOUT_MS;
  if (argc > 1 && !JS_IsUndefined(argv[1]) && system_uint(ctx, argv[1], 120000, &timeout)) return JS_EXCEPTION;
  const char *server = NULL; size_t length = 0;
  if (argc && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
    /* 与旧SDK一致，非null参数通过ToString转换；转换可重入shutdown。 */
    server = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!server) return JS_EXCEPTION;
    if (!length || length >= PX_SYSTEM_NTP_HOST_BYTES || memchr(server, 0, length)) {
      JS_FreeCString(ctx, server); return JS_ThrowRangeError(ctx, "invalid NTP server length or NUL");
    }
  }
  struct system_net_owner *owner = system_owner(ctx, self, 1);
  if (!owner) { JS_FreeCString(ctx, server); return JS_EXCEPTION; }
  uint32_t id;
  int result = px_system_ntp_start(owner->context, server, timeout, &id);
  JS_FreeCString(ctx, server);
  return result ? system_error(ctx, result) : JS_NewUint32(ctx, id);
}
static JSValue cancel_ntp(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  if (!system_owner(ctx, self, 1)) return JS_EXCEPTION;
  unsigned id;
  if (!argc) return JS_ThrowTypeError(ctx, "cancel needs a request id");
  if (system_uint(ctx, argv[0], UINT32_MAX, &id)) return JS_EXCEPTION;
  struct system_net_owner *owner = system_owner(ctx, self, 1);
  if (!owner) return JS_EXCEPTION;
  int result = px_system_ntp_cancel(owner->context, id);
  return result ? system_error(ctx, result) : JS_UNDEFINED;
}
static JSValue poll_system_net(JSContext *ctx, JSValueConst self)
{
  struct system_net_owner *owner = system_owner(ctx, self, 1);
  if (!owner) return JS_EXCEPTION;
  struct px_system_net_result event;
  int result = px_system_net_poll(owner->context, &event);
  if (result <= 0) return result ? system_error(ctx, result) : JS_NULL;
  JSValue object = JS_NewObject(ctx);
  if (JS_IsException(object) || system_property(ctx, object, "id", JS_NewUint32(ctx, event.id)) < 0 ||
      system_property(ctx, object, "error", JS_NewInt32(ctx, event.error)) < 0 ||
      system_property(ctx, object, "code", JS_NewString(ctx, system_error_code(event.error))) < 0) {
    JS_FreeValue(ctx, object); return JS_EXCEPTION;
  }
  return object;
}
static JSValue system_net_call(JSContext *ctx, JSValueConst self, int argc,
                               JSValueConst *argv, int magic, JSValue *data)
{
  (void)self;
  if (magic == 0) return start_ntp(ctx, data[0], argc, argv);
  if (magic == 1) return cancel_ntp(ctx, data[0], argc, argv);
  if (magic == 2) return poll_system_net(ctx, data[0]);
  struct system_net_owner *owner = system_owner(ctx, data[0], magic != 4);
  if (!owner) return JS_EXCEPTION;
  if (magic == 4) {
    px_system_net_destroy(owner->context); owner->context = NULL; return JS_UNDEFINED;
  }
  double celsius; int result = px_system_temperature(&celsius);
  return result ? system_error(ctx, result) : JS_NewFloat64(ctx, celsius);
}
void px_install_system_net(JSContext *ctx, JSValue native)
{
  JSClassID id = 0; JS_NewClassID(JS_GetRuntime(ctx), &id);
  if (JS_NewClass(JS_GetRuntime(ctx), id, &system_net_definition) < 0) return;
  struct system_net_owner *owner = js_mallocz(ctx, sizeof(*owner));
  if (!owner) return;
  owner->context = px_system_net_create();
  if (!owner->context) { js_free(ctx, owner); JS_ThrowOutOfMemory(ctx); return; }
  JSValue object = JS_NewObjectClass(ctx, id);
  if (JS_IsException(object)) { px_system_net_destroy(owner->context); js_free(ctx, owner); return; }
  JS_SetOpaque(object, owner);
  const char *names[] = {"start", "cancel", "poll", "temperature", "shutdown"};
  const int lengths[] = {2, 1, 0, 0, 0};
  for (unsigned i = 0; i < sizeof(names) / sizeof(*names); ++i)
    if (system_property(ctx, object, names[i], JS_NewCFunctionData(ctx, system_net_call, lengths[i], (int)i, 1, &object)) < 0) {
      JS_FreeValue(ctx, object); return;
    }
  system_property(ctx, native, "systemNet", object);
}
