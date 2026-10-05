/* 将真实mDNS core/binding/prelude置于QuickJS主循环，UDP对端由独立Python协议实现提供。 */
#include "quickjs.h"
#include "pixelbox_mdns.h"
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

void px_install_mdns(JSContext *ctx, JSValue native);
static bool evaluate(JSContext *ctx, const char *text, size_t length, const char *filename)
{
  JSValue value = JS_Eval(ctx, text, length, filename, JS_EVAL_TYPE_GLOBAL);
  bool okay = !JS_IsException(value); JS_FreeValue(ctx, value);
  if (!okay) {
    JSValue exception = JS_GetException(ctx), stack = JS_GetPropertyStr(ctx, exception, "stack");
    const char *message = JS_ToCString(ctx, exception), *trace = JS_ToCString(ctx, stack);
    fprintf(stderr, "%s\n%s\n", message ? message : "exception", trace ? trace : "");
    JS_FreeCString(ctx, message); JS_FreeCString(ctx, trace); JS_FreeValue(ctx, exception); JS_FreeValue(ctx, stack);
  }
  return okay;
}
int main(int argc, char **argv)
{
  assert(argc == 2); FILE *file = fopen(argv[1], "rb"); assert(file && !fseek(file, 0, SEEK_END));
  long length = ftell(file); assert(length > 0 && !fseek(file, 0, SEEK_SET));
  char *script = malloc((size_t)length + 1); assert(script && fread(script, 1, (size_t)length, file) == (size_t)length);
  script[length] = 0; fclose(file);
  assert(!px_mdns_configure("runtime-box", "127.0.0.1"));
  assert(!px_mdns_publish_devd("Runtime Devd", 8765, "ESP32-S3-Touch-AMOLED-2.16", "P11-test", "demo.app"));
  JSRuntime *runtime = JS_NewRuntime(); assert(runtime); JS_SetMaxStackSize(runtime, 1024 * 1024);
  JSContext *ctx = JS_NewContext(runtime); assert(ctx);
  JSValue global = JS_GetGlobalObject(ctx), native = JS_NewObject(ctx); px_install_mdns(ctx, native);
  JS_SetPropertyStr(ctx, global, "native", native);
  assert(evaluate(ctx, script, (size_t)length, argv[1])); free(script);
  bool done = false;
  for (unsigned turn = 0; turn < 1000 && !done; ++turn) {
    const char pump[] = "for (const callback of [...timers.values()]) callback();";
    assert(evaluate(ctx, pump, sizeof(pump) - 1, "mdns-pump"));
    JSContext *job_ctx; int count = 0;
    while (JS_IsJobPending(runtime) && count++ < 100) assert(JS_ExecutePendingJob(runtime, &job_ctx) >= 0);
    JSValue flag = JS_GetPropertyStr(ctx, global, "done"); done = JS_ToBool(ctx, flag); JS_FreeValue(ctx, flag);
    JSValue failed = JS_GetPropertyStr(ctx, global, "failure");
    if (!JS_IsUndefined(failed)) {
      const char *text = JS_ToCString(ctx, failed); fprintf(stderr, "JS test failed: %s\n", text ? text : "unknown"); return 1;
    }
    JS_FreeValue(ctx, failed);
    struct timespec delay = {.tv_nsec = 5000000}; nanosleep(&delay, NULL);
  }
  assert(done); JS_FreeValue(ctx, global); JS_FreeContext(ctx); JS_FreeRuntime(runtime); assert(!px_mdns_shutdown());
  puts("mDNS真实QuickJS→prelude→binding→常驻UDP worker端到端通过"); return 0;
}
