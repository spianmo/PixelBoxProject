/* 真实QuickJS检查FFI可重入转换、owner隔离、TXT长度和回收；网络由单独UDP测试覆盖。 */
#include "quickjs.h"
#include "pixelbox_mdns.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct px_mdns { uint32_t id; int pending, error; };
static unsigned owners, discoveries, advertisements, timeout_seen, removed;
static uint8_t txt_seen[PX_MDNS_TXT_BYTES]; static size_t txt_size;
void px_install_mdns(JSContext *ctx, JSValue native);
struct px_mdns *px_mdns_create(void)
{ struct px_mdns *owner = calloc(1, sizeof(*owner)); if (owner) ++owners; return owner; }
void px_mdns_destroy(struct px_mdns *owner) { if (owner) { --owners; free(owner); } }
int px_mdns_discover(struct px_mdns *owner, const char *service, unsigned timeout, uint32_t *id)
{
  assert(owner && service); ++discoveries; timeout_seen = timeout;
  *id = ++owner->id; owner->pending = 1; owner->error = !strcmp(service, "_fail._tcp") ? -ENETDOWN : 0; return 0;
}
int px_mdns_cancel(struct px_mdns *owner, uint32_t id)
{ assert(owner); if (owner->id == id) owner->error = -ECANCELED; return 0; }
int px_mdns_advertise(struct px_mdns *owner, const char *name, const char *service, unsigned port,
                      const uint8_t *txt, size_t length, uint32_t *id)
{
  assert(owner && name && service && port && length <= sizeof(txt_seen));
  ++advertisements; memcpy(txt_seen, txt, length); txt_size = length; *id = ++owner->id; return 0;
}
int px_mdns_unadvertise(struct px_mdns *owner, uint32_t id) { assert(owner && id); ++removed; return 0; }
int px_mdns_poll(struct px_mdns *owner, struct px_mdns_result *result)
{
  assert(owner); if (!owner->pending) return 0; owner->pending = 0;
  memset(result, 0, sizeof(*result)); result->id = owner->id; result->error = owner->error;
  if (!result->error) {
    result->services = calloc(1, sizeof(*result->services)); assert(result->services); result->count = 1;
    struct px_mdns_service *service = result->services;
    strcpy(service->name, "中文.设备"); strcpy(service->host, "pixelbox.local"); strcpy(service->ip, "192.0.2.1"); service->port = 8765;
    const uint8_t txt[] = {3, 'a', '=', 'b', 11, '_','_','p','r','o','t','o','_','_', '=', 'x', 4,'f','l','a','g', 0};
    memcpy(service->txt, txt, sizeof(txt)); service->txt_length = sizeof(txt);
  }
  return 1;
}
void px_mdns_result_free(struct px_mdns_result *result) { free(result->services); memset(result, 0, sizeof(*result)); }
static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{ (void)self; (void)argc; (void)argv; JS_RunGC(JS_GetRuntime(ctx)); return JS_NewUint32(ctx, owners); }
static JSValue stats(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv; JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "discoveries", JS_NewUint32(ctx, discoveries));
  JS_SetPropertyStr(ctx, value, "advertisements", JS_NewUint32(ctx, advertisements));
  JS_SetPropertyStr(ctx, value, "removed", JS_NewUint32(ctx, removed));
  JS_SetPropertyStr(ctx, value, "timeout", JS_NewUint32(ctx, timeout_seen));
  JS_SetPropertyStr(ctx, value, "txt", JS_NewStringLen(ctx, (const char *)txt_seen, txt_size)); return value;
}
static JSValue make_mdns(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv; JSValue native = JS_NewObject(ctx); px_install_mdns(ctx, native);
  JSValue value = JS_GetPropertyStr(ctx, native, "mdns"); JS_FreeValue(ctx, native); return value;
}
int main(int argc, char **argv)
{
  assert(argc == 2); FILE *file = fopen(argv[1], "rb"); assert(file && !fseek(file, 0, SEEK_END));
  long size = ftell(file); assert(size > 0 && !fseek(file, 0, SEEK_SET));
  char *script = malloc((size_t)size + 1); assert(script && fread(script, 1, (size_t)size, file) == (size_t)size);
  fclose(file); script[size] = 0;
  for (unsigned generation = 0; generation < 3; ++generation) {
    JSRuntime *runtime = JS_NewRuntime(); assert(runtime); JS_SetMaxStackSize(runtime, 1024 * 1024);
    JSContext *ctx = JS_NewContext(runtime); assert(ctx);
    JSValue global = JS_GetGlobalObject(ctx), native = JS_NewObject(ctx); px_install_mdns(ctx, native);
    JS_SetPropertyStr(ctx, global, "native", native);
    JS_SetPropertyStr(ctx, global, "gc", JS_NewCFunction(ctx, collect, "gc", 0));
    JS_SetPropertyStr(ctx, global, "stats", JS_NewCFunction(ctx, stats, "stats", 0));
    JS_SetPropertyStr(ctx, global, "makeMdns", JS_NewCFunction(ctx, make_mdns, "makeMdns", 0)); JS_FreeValue(ctx, global);
    JSValue result = JS_Eval(ctx, script, (size_t)size, argv[1], JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
      JSValue exception = JS_GetException(ctx), stack = JS_GetPropertyStr(ctx, exception, "stack");
      const char *message = JS_ToCString(ctx, exception), *trace = JS_ToCString(ctx, stack);
      fprintf(stderr, "%s\n%s\n", message ? message : "exception", trace ? trace : ""); return 1;
    }
    JS_FreeValue(ctx, result); JS_FreeContext(ctx); JS_FreeRuntime(runtime); assert(!owners);
  }
  free(script); puts("mDNS绑定通过：真实QuickJS、TXT原型安全、参数边界、重入关闭、GC与3代VM"); return 0;
}
