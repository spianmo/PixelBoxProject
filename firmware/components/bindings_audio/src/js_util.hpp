/**
 * PixelBox bindings_audio — QuickJS 辅助函数(组件内私有)
 */
#pragma once

#include <cstdint>
#include <cstring>
#include <string>

#include "esp_log.h"
#include "quickjs.h"

namespace pxjs {

/** 抛出 Error(msg),返回 JS_EXCEPTION */
inline JSValue throw_error(JSContext* ctx, const char* msg) {
    JSValue err = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, msg),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw(ctx, err);
}

/** 读取 obj.name 的整数属性,缺省/非法返回 def */
inline int32_t opt_int_prop(JSContext* ctx, JSValueConst obj, const char* name, int32_t def) {
    if (!JS_IsObject(obj)) return def;
    JSValue v = JS_GetPropertyStr(ctx, obj, name);
    int32_t out = def;
    if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
        if (JS_ToInt32(ctx, &out, v) != 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            out = def;
        }
    }
    JS_FreeValue(ctx, v);
    return out;
}

/** 调用 JS 回调并吞掉异常(打印日志),用于事件派发 */
inline void call_js(JSContext* ctx, JSValueConst fn, int argc, JSValueConst* argv,
                    const char* tag) {
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, argc, const_cast<JSValue*>(argv));
    if (JS_IsException(ret)) {
        JSValue ex = JS_GetException(ctx);
        const char* s = JS_ToCString(ctx, ex);
        ESP_LOGE(tag, "JS 回调异常: %s", s ? s : "(unknown)");
        if (s) JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, ex);
    }
    JS_FreeValue(ctx, ret);
}

/** 定义只读 getter 属性 */
inline void define_getter(JSContext* ctx, JSValueConst obj, const char* name,
                          JSCFunction* getter) {
    JSAtom atom = JS_NewAtom(ctx, name);
    JSValue g = JS_NewCFunction(ctx, getter, name, 0);
    JS_DefinePropertyGetSet(ctx, obj, atom, g, JS_UNDEFINED, JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, atom);
}

}  // namespace pxjs
