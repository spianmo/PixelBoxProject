/* 真实QuickJS+受控C状态：验证FFI边界、可重入参数转换、GC与跨VM资源归还。 */
#include "quickjs.h"
#include "pixelbox_system_net.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct px_system_net { unsigned id; int pending, error; };
static unsigned owners, starts, timeout_seen;
static char server_seen[PX_SYSTEM_NTP_HOST_BYTES];
void px_install_system_net(JSContext *ctx, JSValue native);
struct px_system_net *px_system_net_create(void)
{
  struct px_system_net *context = calloc(1, sizeof(*context)); if (context) ++owners; return context;
}
void px_system_net_destroy(struct px_system_net *context) { if (context) { --owners; free(context); } }
int px_system_ntp_start(struct px_system_net *context, const char *server, unsigned timeout, uint32_t *id)
{
  assert(context); ++starts; timeout_seen = timeout;
  strcpy(server_seen, server ? server : "pool.ntp.org");
  context->pending = 1; context->error = server && !strcmp(server, "failed") ? -ETIMEDOUT : 0;
  *id = ++context->id; return 0;
}
int px_system_ntp_cancel(struct px_system_net *context, uint32_t id)
{
  assert(context); if (context->id == id) context->error = -ECANCELED; return 0;
}
int px_system_net_poll(struct px_system_net *context, struct px_system_net_result *result)
{
  assert(context); if (!context->pending) return 0;
  context->pending = 0; result->id = context->id; result->error = context->error; return 1;
}
int px_system_temperature(double *celsius) { *celsius = 42.125; return 0; }
static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv; JS_RunGC(JS_GetRuntime(ctx)); return JS_NewUint32(ctx, owners);
}
static JSValue stats(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  JSValue result = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, result, "starts", JS_NewUint32(ctx, starts));
  JS_SetPropertyStr(ctx, result, "timeout", JS_NewUint32(ctx, timeout_seen));
  JS_SetPropertyStr(ctx, result, "server", JS_NewString(ctx, server_seen)); return result;
}
static JSValue make_system(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  JSValue native = JS_NewObject(ctx); px_install_system_net(ctx, native);
  JSValue value = JS_GetPropertyStr(ctx, native, "systemNet"); JS_FreeValue(ctx, native); return value;
}
int main(int argc, char **argv)
{
  assert(argc == 2); FILE *file = fopen(argv[1], "rb"); assert(file && !fseek(file, 0, SEEK_END));
  long size = ftell(file); assert(size > 0 && size < 1000000 && !fseek(file, 0, SEEK_SET));
  char *source = malloc((size_t)size + 1); assert(source && fread(source, 1, (size_t)size, file) == (size_t)size);
  fclose(file); source[size] = 0;
  for (unsigned i = 0; i < 3; ++i) {
    JSRuntime *runtime = JS_NewRuntime(); assert(runtime); JS_SetMaxStackSize(runtime, 1024 * 1024);
    JSContext *ctx = JS_NewContext(runtime); assert(ctx);
    JSValue global = JS_GetGlobalObject(ctx), native = JS_NewObject(ctx);
    px_install_system_net(ctx, native); JS_SetPropertyStr(ctx, global, "native", native);
    JS_SetPropertyStr(ctx, global, "gc", JS_NewCFunction(ctx, collect, "gc", 0));
    JS_SetPropertyStr(ctx, global, "stats", JS_NewCFunction(ctx, stats, "stats", 0));
    JS_SetPropertyStr(ctx, global, "makeSystem", JS_NewCFunction(ctx, make_system, "makeSystem", 0));
    JS_FreeValue(ctx, global);
    JSValue value = JS_Eval(ctx, source, (size_t)size, argv[1], JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
      JSValue exception = JS_GetException(ctx), stack = JS_GetPropertyStr(ctx, exception, "stack");
      const char *text = JS_ToCString(ctx, exception), *trace = JS_ToCString(ctx, stack);
      fprintf(stderr, "%s\n%s\n", text ? text : "exception", trace ? trace : ""); return 1;
    }
    JS_FreeValue(ctx, value); JS_FreeContext(ctx); JS_FreeRuntime(runtime); assert(owners == 0);
  }
  free(source); puts("system绑定通过：真实QuickJS、参数/默认值、错误码、call隔离、重入关闭、GC及跨VM资源回收"); return 0;
}
