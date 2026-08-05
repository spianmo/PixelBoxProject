/**
 * binding_util.cpp — bindings_periph 共用工具实现
 */
#include "binding_util.hpp"

#include <cstring>

namespace pxb {

// ---------------------------------------------------------------
// Unsubscribe 闭包
// ---------------------------------------------------------------

namespace {

/** func_data[0] = 注册表指针(int64), [1] = 订阅 id(int64) */
JSValue unsub_impl(JSContext* ctx, JSValueConst /*this_val*/, int /*argc*/,
                   JSValueConst* /*argv*/, int /*magic*/, JSValueConst* func_data) {
    int64_t p = 0, id = 0;
    JS_ToInt64(ctx, &p, func_data[0]);
    JS_ToInt64(ctx, &id, func_data[1]);
    auto* reg = reinterpret_cast<CallbackRegistry*>(static_cast<uintptr_t>(p));
    if (reg != nullptr) reg->remove(static_cast<uint64_t>(id));
    return JS_UNDEFINED;
}

}  // namespace

JSValue make_unsubscribe(JSContext* ctx, CallbackRegistry* reg, uint64_t id) {
    JSValue data[2] = {
        JS_NewInt64(ctx, static_cast<int64_t>(reinterpret_cast<uintptr_t>(reg))),
        JS_NewInt64(ctx, static_cast<int64_t>(id)),
    };
    JSValue fn = JS_NewCFunctionData(ctx, unsub_impl, 0, 0, 2, data);
    JS_FreeValue(ctx, data[0]);
    JS_FreeValue(ctx, data[1]);
    return fn;
}

// ---------------------------------------------------------------
// Promise
// ---------------------------------------------------------------

void PromisePair::reject_error(std::string msg) const {
    reject.invoke_with([msg = std::move(msg)](JSContext* ctx, JSValue* argv) -> int {
        JSValue err = JS_NewError(ctx);
        JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, msg.c_str()));
        argv[0] = err;
        return 1;
    });
}

void PromisePair::resolve_undefined() const {
    resolve.invoke_with([](JSContext*, JSValue* argv) -> int {
        argv[0] = JS_UNDEFINED;
        return 1;
    });
}

JSValue make_promise(JSContext* ctx, PromisePair& out) {
    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) return promise;
    out.resolve = jsvm::Callback(ctx, funcs[0]);
    out.reject = jsvm::Callback(ctx, funcs[1]);
    JS_FreeValue(ctx, funcs[0]);
    JS_FreeValue(ctx, funcs[1]);
    return promise;
}

// ---------------------------------------------------------------
// 参数/属性工具
// ---------------------------------------------------------------

bool opt_string(JSContext* ctx, JSValueConst obj, const char* prop, std::string& out) {
    if (!JS_IsObject(obj)) return false;
    JSValue v = JS_GetPropertyStr(ctx, obj, prop);
    bool ok = false;
    if (JS_IsString(v)) {
        size_t len = 0;
        const char* s = JS_ToCStringLen(ctx, &len, v);
        if (s != nullptr) {
            out.assign(s, len);
            JS_FreeCString(ctx, s);
            ok = true;
        }
    }
    JS_FreeValue(ctx, v);
    return ok;
}

double opt_number(JSContext* ctx, JSValueConst obj, const char* prop, double defv) {
    if (!JS_IsObject(obj)) return defv;
    JSValue v = JS_GetPropertyStr(ctx, obj, prop);
    double out = defv;
    if (JS_IsNumber(v)) JS_ToFloat64(ctx, &out, v);
    JS_FreeValue(ctx, v);
    return out;
}

bool opt_bool(JSContext* ctx, JSValueConst obj, const char* prop, bool defv) {
    if (!JS_IsObject(obj)) return defv;
    JSValue v = JS_GetPropertyStr(ctx, obj, prop);
    bool out = defv;
    if (JS_IsBool(v)) out = JS_ToBool(ctx, v) != 0;
    JS_FreeValue(ctx, v);
    return out;
}

jsvm::Callback opt_callback(JSContext* ctx, JSValueConst obj, const char* prop) {
    if (!JS_IsObject(obj)) return {};
    JSValue v = JS_GetPropertyStr(ctx, obj, prop);
    jsvm::Callback cb;
    if (JS_IsFunction(ctx, v)) cb = jsvm::Callback(ctx, v);
    JS_FreeValue(ctx, v);
    return cb;
}

bool to_string(JSContext* ctx, JSValueConst v, std::string& out) {
    size_t len = 0;
    const char* s = JS_ToCStringLen(ctx, &len, v);
    if (s == nullptr) return false;
    out.assign(s, len);
    JS_FreeCString(ctx, s);
    return true;
}

bool get_binary_copy(JSContext* ctx, JSValueConst v, std::vector<uint8_t>& out) {
    const uint8_t* data = nullptr;
    size_t len = 0;
    if (!jsvm::get_binary(ctx, v, &data, &len)) return false;
    out.assign(data, data + len);
    return true;
}

JSValue ab_from_vec(JSContext* ctx, const std::vector<uint8_t>& v) {
    return JS_NewArrayBufferCopy(ctx, v.data(), v.size());
}

void def_fn(JSContext* ctx, JSValueConst obj, const char* name, JSCFunction* fn, int nargs) {
    JS_SetPropertyStr(ctx, obj, name, JS_NewCFunction(ctx, fn, name, nargs));
}

}  // namespace pxb
