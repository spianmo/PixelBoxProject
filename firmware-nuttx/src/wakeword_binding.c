#include "quickjs.h"
#include "pixelbox_wakeword.h"
#include <errno.h>
#include <math.h>

static const char *code(int result)
{
  switch (-result) {
    case ENOTSUP: return "ENOTSUP";
    case EBUSY: return "EBUSY";
    case ENOMEM: return "ENOMEM";
    case EINVAL: return "EINVAL";
    case ECANCELED: return "ECANCELED";
    case ETIMEDOUT: return "ETIMEDOUT";
    case EPROTO: return "EPROTO";
    case EBADMSG: return "EBADMSG";
    default: return "EIO";
  }
}
static JSValue failure(JSContext *ctx, int error) { return JS_ThrowInternalError(ctx, "%s: MultiNet7", code(error)); }
static int uint_arg(JSContext *ctx, JSValueConst value, uint32_t *id)
{
  double n;
  if (JS_ToFloat64(ctx, &n, value)) return -1;
  if (!isfinite(n) || n < 0 || n > UINT32_MAX || trunc(n) != n) {
    JS_ThrowRangeError(ctx, "invalid wakeword job id"); return -1;
  }
  *id = (uint32_t)n; return 0;
}
static JSValue start(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (argc != 2 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "wakewordStart needs pinyin and threshold");
  double threshold; if (JS_ToFloat64(ctx, &threshold, argv[1])) return JS_EXCEPTION;
  if (!isfinite(threshold) || threshold < 0 || threshold > .9999) return failure(ctx, -EINVAL);
  const char *pinyin = JS_ToCString(ctx, argv[0]); if (!pinyin) return JS_EXCEPTION;
  uint32_t id = 0; int result = px_wakeword_start(pinyin, (float)threshold, &id);
  JS_FreeCString(ctx, pinyin);
  return result < 0 ? failure(ctx, result) : JS_NewUint32(ctx, id);
}
static JSValue feed(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  uint32_t id;
  if (argc != 2) return JS_ThrowTypeError(ctx, "wakewordFeed needs job id and PCM16LE");
  if (uint_arg(ctx, argv[0], &id)) return JS_EXCEPTION;
  size_t bytes, offset = 0, capacity, element;
  const uint8_t *data;
  if (JS_GetTypedArrayType(argv[1]) == JS_TYPED_ARRAY_UINT8) {
    JSValue owner = JS_GetTypedArrayBuffer(ctx, argv[1], &offset, &bytes, &element);
    if (JS_IsException(owner)) return owner;
    data = JS_GetArrayBuffer(ctx, &capacity, owner);
    bool invalid = JS_HasException(ctx) || offset > capacity || bytes > capacity - offset;
    JS_FreeValue(ctx, owner);
    if (invalid) return JS_EXCEPTION;
    if (data) data += offset;
  } else if (JS_IsArrayBuffer(argv[1])) {
    data = JS_GetArrayBuffer(ctx, &bytes, argv[1]);
    if (JS_HasException(ctx)) return JS_EXCEPTION;
  } else return JS_ThrowTypeError(ctx, "PCM must be ArrayBuffer or Uint8Array");
  int result = px_wakeword_feed(id, data, bytes);
  return result < 0 ? failure(ctx, result) : JS_UNDEFINED;
}
static JSValue poll_event(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  struct px_wakeword_event event;
  int result = px_wakeword_poll(&event);
  if (result < 0) return failure(ctx, result);
  if (!result) return JS_NULL;
  JSValue value = JS_NewObject(ctx);
  if (JS_IsException(value)) return value;
  const char *kind = event.kind == PX_WAKEWORD_READY ? "ready" : event.kind == PX_WAKEWORD_DETECTED ? "wake" : "error";
  if (JS_SetPropertyStr(ctx, value, "jobId", JS_NewUint32(ctx, event.job_id)) < 0 ||
      JS_SetPropertyStr(ctx, value, "kind", JS_NewString(ctx, kind)) < 0 ||
      JS_SetPropertyStr(ctx, value, "probability", JS_NewFloat64(ctx, event.probability)) < 0 ||
      JS_SetPropertyStr(ctx, value, "code", JS_NewString(ctx, event.error ? code(event.error) : "")) < 0) {
    JS_FreeValue(ctx, value); return JS_EXCEPTION;
  }
  return value;
}
enum { AVAILABLE, BUSY, STOP };
static JSValue control(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int op)
{
  (void)self;
  if (op == AVAILABLE) return JS_NewBool(ctx, px_wakeword_available());
  if (op == BUSY) return JS_NewBool(ctx, px_wakeword_busy());
  uint32_t id = 0;
  if (argc && uint_arg(ctx, argv[0], &id)) return JS_EXCEPTION;
  px_wakeword_stop(id); return JS_UNDEFINED;
}
void px_install_wakeword(JSContext *ctx, JSValue native)
{
  const char *names[] = {"wakewordAvailable", "wakewordBusy", "wakewordStop"};
  for (int i = 0; i < 3; ++i) JS_SetPropertyStr(ctx, native, names[i], JS_NewCFunctionMagic(ctx,
      control, names[i], i == STOP, JS_CFUNC_generic_magic, i));
  JS_SetPropertyStr(ctx, native, "wakewordStart", JS_NewCFunction(ctx, start, "wakewordStart", 2));
  JS_SetPropertyStr(ctx, native, "wakewordFeed", JS_NewCFunction(ctx, feed, "wakewordFeed", 2));
  JS_SetPropertyStr(ctx, native, "wakewordPoll", JS_NewCFunction(ctx, poll_event, "wakewordPoll", 0));
}
