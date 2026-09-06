#include "quickjs.h"
#include "jsvm_internal.hpp"
#include <stdio.h>
#include <stdlib.h>

static JSValue print(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    for (int i = 0; i < argc; ++i) {
        const char *text = JS_ToCString(ctx, argv[i]);
        if (!text) return JS_EXCEPTION;
        printf("%s%s", i ? " " : "", text);
        JS_FreeCString(ctx, text);
    }
    puts("");
    return JS_UNDEFINED;
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 2;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    rewind(file);
    if (size < 0) { fclose(file); return 2; }
    char *code = static_cast<char *>(malloc((size_t)size + 1));
    if (!code || fread(code, 1, size, file) != (size_t)size) { free(code); fclose(file); return 2; }
    fclose(file);
    code[size] = 0;
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue util = JS_NewObject(ctx);
    jsvm::internal::install_projection_util(ctx, util);
    JSValue px = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, px, "util", util);
    JS_SetPropertyStr(ctx, global, "px", px);
    JS_SetPropertyStr(ctx, global, "print", JS_NewCFunction(ctx, print, "print", 0));
    JS_FreeValue(ctx, global);
    JSValue result = JS_Eval(ctx, code, size, argv[1], JS_EVAL_TYPE_GLOBAL);
    free(code);
    int failed = JS_IsException(result);
    if (failed) {
        JSValue error = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, error);
        fprintf(stderr, "%s\n", text ? text : "exception");
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, error);
    }
    JS_FreeValue(ctx, result);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return failed;
}
