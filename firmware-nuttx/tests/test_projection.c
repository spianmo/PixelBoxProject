/* 独立 QuickJS 原生入口测试：显式提供分离操作，覆盖 getter 重入后的真实缓冲生命周期。 */
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

#ifdef PX_TEST_CANVAS
void px_install_canvas(JSContext *ctx, JSValue native);
#ifdef PX_TEST_CANVAS_TEXT
void px_install_text(JSContext *ctx, JSValue native);
#endif
#else
void px_install_projection(JSContext *ctx, JSValue native);
#endif
static int interrupt_after = -1;
static int interrupt_polls = 0;
/* 专项fixture只控制中断位置；真实截止时间和不可catch语义另用完整runtime验证。 */
int px_runtime_poll_interrupt(JSContext *ctx)
{
  ++interrupt_polls;
  if (interrupt_after < 0) return 0;
  if (interrupt_after-- > 0) return 0;
  JS_ThrowInternalError(ctx, "test native interruption");
  return -1;
}
static JSValue arm_interrupt(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc || JS_ToInt32(ctx, &interrupt_after, argv[0])) return JS_EXCEPTION;
  return JS_UNDEFINED;
}
static JSValue interrupt_poll_count(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;(void)argc;(void)argv;
  return JS_NewInt32(ctx, interrupt_polls);
}
static JSValue detach(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (argc) JS_DetachArrayBuffer(ctx, argv[0]);
  return JS_UNDEFINED;
}
#ifdef PX_TEST_PROJECTION
extern uint32_t px_projection_test_fast,px_projection_test_fallback;
static JSValue projection_stats(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;(void)argc;(void)argv;
  JSValue result=JS_NewObject(ctx);
  JS_SetPropertyStr(ctx,result,"fast",JS_NewUint32(ctx,px_projection_test_fast));
  JS_SetPropertyStr(ctx,result,"fallback",JS_NewUint32(ctx,px_projection_test_fallback));
  return result;
}
#endif
int main(int argc, char **argv)
{
  if (argc != 2) return 2;
  FILE *file = fopen(argv[1], "rb");
  if (!file) return 2;
  fseek(file, 0, SEEK_END); long bytes = ftell(file); rewind(file);
  if (bytes < 0) { fclose(file); return 2; }
  char *script = malloc((size_t)bytes + 1);
  if (!script) { fclose(file); return 2; }
  if (fread(script, 1, (size_t)bytes, file) != (size_t)bytes) { free(script); fclose(file); return 2; }
  fclose(file); script[bytes] = 0;
  JSRuntime *runtime = JS_NewRuntime();
  JSContext *ctx = JS_NewContext(runtime);
  JSValue global = JS_GetGlobalObject(ctx), native = JS_NewObject(ctx);
#ifdef PX_TEST_CANVAS
  px_install_canvas(ctx, native);
#ifdef PX_TEST_CANVAS_TEXT
  px_install_text(ctx, native);
#endif
#else
  px_install_projection(ctx, native);
#endif
  JS_SetPropertyStr(ctx, global, "armInterrupt", JS_NewCFunction(ctx, arm_interrupt, "armInterrupt", 1));
  JS_SetPropertyStr(ctx, global, "interruptPollCount", JS_NewCFunction(ctx, interrupt_poll_count, "interruptPollCount", 0));
  JS_SetPropertyStr(ctx, global, "native", native);
  JS_SetPropertyStr(ctx, global, "detach", JS_NewCFunction(ctx, detach, "detach", 1));
#ifdef PX_TEST_PROJECTION
  JS_SetPropertyStr(ctx, global, "projectionStats", JS_NewCFunction(ctx, projection_stats, "projectionStats", 0));
#endif
  JS_FreeValue(ctx, global);
  JSValue result = JS_Eval(ctx, script, (size_t)bytes, argv[1], JS_EVAL_TYPE_GLOBAL);
  int failed = JS_IsException(result);
  if (failed) {
    JSValue error = JS_GetException(ctx), stack = JS_GetPropertyStr(ctx, error, "stack");
    const char *message = JS_ToCString(ctx, error), *trace = JS_ToCString(ctx, stack);
    fprintf(stderr, "%s\n%s\n", message ? message : "projection error", trace ? trace : "");
    JS_FreeCString(ctx, message); JS_FreeCString(ctx, trace);
    JS_FreeValue(ctx, stack); JS_FreeValue(ctx, error);
  } else {
#ifdef PX_TEST_CANVAS
    puts("PASS native Canvas clipping, offsets, getter detachment and integer boundaries");
#else
    puts("PASS native projection buffers, getter detachment, alias, Float32 and run boundaries");
#endif
  }
  JS_FreeValue(ctx, result); JS_FreeContext(ctx); JS_FreeRuntime(runtime); free(script);
  return failed;
}
