#include "pixelbox_sleep.h"
#include "pixelbox_service.h"
#include "quickjs.h"
#include <errno.h>

static JSValue deep_sleep(JSContext *ctx, JSValueConst self,
                          int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc || JS_IsUndefined(argv[0]))
    return JS_ThrowInternalError(ctx, "ENOTSUP: deepSleep requires a timer duration");
  if (!JS_IsNumber(argv[0]))
    return JS_ThrowTypeError(ctx, "deepSleep requires a numeric duration");
  double value;
  uint32_t duration;
  if (JS_ToFloat64(ctx, &value, argv[0])) return JS_EXCEPTION;
  if (px_sleep_validate(value, &duration))
    return JS_ThrowRangeError(ctx, "deepSleep duration must be an integer in 1..86400000 ms");
  /* VM 只提交协作退出请求；这里绝不调用芯片睡眠或跨线程操作 JS。 */
  int result = px_service_vm_request_sleep(px_service_vm_current(), duration);
  if (result) {
    const char *name = result == -ENODEV ? "ENODEV" : result == -ENOTSUP ? "ENOTSUP" :
                       result == -EBUSY ? "EBUSY" : result == -ECANCELED ? "ECANCELED" : "EIO";
    return JS_ThrowInternalError(ctx, "%s: deepSleep request rejected (%d)", name, result);
  }
  return JS_UNDEFINED;
}

void px_install_sleep(JSContext *ctx, JSValue native)
{
  JS_SetPropertyStr(ctx, native, "deepSleep", JS_NewCFunction(ctx, deep_sleep, "deepSleep", 1));
}
