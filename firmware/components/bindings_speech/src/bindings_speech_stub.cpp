#include "jsvm/jsvm.hpp"

namespace {
JSValue unsupported(JSContext* ctx, JSValueConst, int, JSValueConst*) { return jsvm::throw_enotsup(ctx); }
JSValue available(JSContext* ctx, JSValueConst, int, JSValueConst*) { return JS_NewBool(ctx, false); }
JSValue stop(JSContext*, JSValueConst, int, JSValueConst*) { return JS_UNDEFINED; }
void init(JSContext* ctx, JSValue root) {
    JSValue speech = JS_NewObject(ctx), wakeword = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, speech, "available", JS_NewCFunction(ctx, available, "available", 0));
    for (const char* name : {"configure", "recognize", "speak"}) JS_SetPropertyStr(ctx, speech, name, JS_NewCFunction(ctx, unsupported, name, 1));
    JS_SetPropertyStr(ctx, speech, "cancel", JS_NewCFunction(ctx, stop, "cancel", 0));
    JS_SetPropertyStr(ctx, wakeword, "start", JS_NewCFunction(ctx, unsupported, "start", 1));
    JS_SetPropertyStr(ctx, wakeword, "stop", JS_NewCFunction(ctx, stop, "stop", 0));
    JS_SetPropertyStr(ctx, speech, "wakeword", wakeword);
    JS_SetPropertyStr(ctx, root, "speech", speech);
}
const jsvm::Module module{"speech", 12, init, nullptr};
JSVM_REGISTER_MODULE(module);
}  // namespace
