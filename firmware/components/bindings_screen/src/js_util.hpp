/**
 * PixelBox bindings_screen — QuickJS 辅助函数(组件内私有)
 */
#pragma once

#include <cstdint>

#include "quickjs.h"

namespace pxscr {

/** 抛出 Error(msg), 返回 JS_EXCEPTION */
inline JSValue throw_error(JSContext *ctx, const char *msg)
{
    JSValue err = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, msg),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return JS_Throw(ctx, err);
}

/** 定义只读 getter 属性 */
inline void define_getter(JSContext *ctx, JSValue obj, const char *name,
                          JSValue (*getter)(JSContext *, JSValueConst, int, JSValueConst *))
{
    JSAtom atom = JS_NewAtom(ctx, name);
    JSValue fn = JS_NewCFunction(ctx, getter, name, 0);
    JS_DefinePropertyGetSet(ctx, obj, atom, fn, JS_UNDEFINED, JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, atom);
}

/** 取 int32 参数; 失败返回 false (已抛异常) */
inline bool get_i32(JSContext *ctx, JSValueConst v, int32_t *out)
{
    return JS_ToInt32(ctx, out, v) == 0;
}

/** 取可选属性 int32 (undefined 保持默认); 类型错误返回 false */
inline bool opt_prop_i32(JSContext *ctx, JSValueConst obj, const char *name, int32_t *out)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, name);
    if (JS_IsException(v)) return false;
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }
    const bool ok = JS_ToInt32(ctx, out, v) == 0;
    JS_FreeValue(ctx, v);
    return ok;
}

}  // namespace pxscr
