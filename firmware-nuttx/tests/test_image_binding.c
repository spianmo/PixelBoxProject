/* 独立QuickJS宿主：不进入主构建目录，也不访问串口。 */
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>

void px_install_image(JSContext *ctx, JSValue native);

static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  JS_RunGC(JS_GetRuntime(ctx));
  JSMemoryUsage usage;
  JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &usage);
  return JS_NewFloat64(ctx, (double)usage.memory_used_size);
}

int main(int argc, char **argv)
{
  if (argc != 2) return 2;
  FILE *file = fopen(argv[1], "rb");
  if (!file || fseek(file, 0, SEEK_END)) return 2;
  long size = ftell(file);
  if (size < 0 || size > 4 * 1024 * 1024 || fseek(file, 0, SEEK_SET)) return 2;
  char *source = malloc((size_t)size + 1);
  if (!source || fread(source, 1, (size_t)size, file) != (size_t)size) return 2;
  fclose(file); source[size] = 0;
  JSRuntime *runtime = JS_NewRuntime();
  JS_SetMemoryLimit(runtime, 32 * 1024 * 1024);
  JS_SetMaxStackSize(runtime, 1024 * 1024);
  JSContext *ctx = JS_NewContext(runtime);
  JSValue global = JS_GetGlobalObject(ctx), native = JS_NewObject(ctx);
  px_install_image(ctx, native);
  JS_SetPropertyStr(ctx, global, "native", native);
  JS_SetPropertyStr(ctx, global, "gc", JS_NewCFunction(ctx, collect, "gc", 0));
  JS_FreeValue(ctx, global);
  JSValue result = JS_Eval(ctx, source, (size_t)size, argv[1], JS_EVAL_TYPE_GLOBAL);
  free(source);
  const int failed = JS_IsException(result);
  if (failed) {
    JSValue error = JS_GetException(ctx);
    const char *message = JS_ToCString(ctx, error);
    fprintf(stderr, "%s\n", message ? message : "unknown JS exception");
    JS_FreeCString(ctx, message);
    JSValue stack = JS_GetPropertyStr(ctx, error, "stack");
    message = JS_ToCString(ctx, stack);
    fprintf(stderr, "%s\n", message ? message : "");
    JS_FreeCString(ctx, message); JS_FreeValue(ctx, stack); JS_FreeValue(ctx, error);
  }
  JS_FreeValue(ctx, result); JS_FreeContext(ctx); JS_FreeRuntime(runtime);
  if (!failed) puts("图片原生绑定通过：真实QuickJS视图偏移/独立所有权/原型setter隔离/GC回收/异常输入/累计帧限额");
  return failed;
}
