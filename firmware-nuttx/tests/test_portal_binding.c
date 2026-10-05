#include "pixelbox_portal.h"
#include "quickjs.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool available = true, requested;
static unsigned starts, stops;
void px_install_portal(JSContext *ctx, JSValue native);
int px_portal_request_start(void)
{ if (!available) return -ENODEV; if (requested) return -EBUSY; requested = true; ++starts; return 0; }
int px_portal_stop(void)
{ if (!available) return -ENODEV; requested = false; ++stops; return 0; }
int px_portal_get_status(struct px_portal_status *status)
{
  if (!available) return -ENODEV;
  memset(status, 0, sizeof(*status)); status->phase = PX_PORTAL_WAITING; status->active = status->wifi_owned = true;
  status->generation = 3; strcpy(status->ap_ssid, "PixelBox-ABCD"); strcpy(status->ap_password, "not-exposed");
  strcpy(status->ssid, "Finger"); strcpy(status->ip, "192.168.31.100"); return 0;
}
const char *px_portal_phase_name(enum px_portal_phase phase)
{ assert(phase == PX_PORTAL_WAITING); return "waiting"; }
static JSValue control(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)self; if (argc) available = JS_ToBool(ctx, argv[0]); return JS_UNDEFINED; }
static JSValue inspect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv; JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "starts", JS_NewUint32(ctx, starts));
  JS_SetPropertyStr(ctx, value, "stops", JS_NewUint32(ctx, stops));
  JS_SetPropertyStr(ctx, value, "requested", JS_NewBool(ctx, requested)); return value;
}
static JSValue reinstall(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)self; (void)argc; (void)argv; JSValue value = JS_NewObject(ctx); px_install_portal(ctx, value); return value; }
int main(int argc, char **argv)
{
  assert(argc == 2); FILE *file = fopen(argv[1], "rb"); assert(file && !fseek(file, 0, SEEK_END));
  long size = ftell(file); assert(size > 0 && !fseek(file, 0, SEEK_SET));
  char *script = malloc((size_t)size + 1); assert(script && fread(script, 1, (size_t)size, file) == (size_t)size);
  fclose(file); script[size] = 0;
  for (unsigned generation = 0; generation < 3; ++generation) {
    /* 上一 VM 退出不能取消已提交给 service 的进入请求。 */
    assert(generation == 0 || requested); requested = false;
    JSRuntime *runtime = JS_NewRuntime(); assert(runtime); JS_SetMaxStackSize(runtime, 1024 * 1024);
    JSContext *ctx = JS_NewContext(runtime); assert(ctx);
    JSValue global = JS_GetGlobalObject(ctx), native = JS_NewObject(ctx); px_install_portal(ctx, native);
    JS_SetPropertyStr(ctx, global, "native", native);
    JS_SetPropertyStr(ctx, global, "control", JS_NewCFunction(ctx, control, "control", 1));
    JS_SetPropertyStr(ctx, global, "inspect", JS_NewCFunction(ctx, inspect, "inspect", 0));
    JS_SetPropertyStr(ctx, global, "reinstall", JS_NewCFunction(ctx, reinstall, "reinstall", 0)); JS_FreeValue(ctx, global);
    JSValue result = JS_Eval(ctx, script, (size_t)size, argv[1], JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
      JSValue exception = JS_GetException(ctx), stack = JS_GetPropertyStr(ctx, exception, "stack");
      const char *message = JS_ToCString(ctx, exception), *trace = JS_ToCString(ctx, stack);
      fprintf(stderr, "%s\n%s\n", message ? message : "exception", trace ? trace : ""); return 1;
    }
    unsigned stopped = stops;
    JS_FreeValue(ctx, result); JS_FreeContext(ctx); JS_FreeRuntime(runtime);
    assert(requested && stops == stopped);
  }
  free(script); puts("门户 JS 绑定通过：真实 QuickJS、服务排队、原型安全、无密码泄露、3 代 VM 退出不撤销请求"); return 0;
}
