/* 麦克风只通过主线程 poll 向 QuickJS 交付完整 PCM 帧。 */
#include "quickjs.h"
#include "pixelbox_mic.h"

#include <errno.h>
#include <math.h>
#include <stdlib.h>

static JSValue mic_error(JSContext *ctx, int result)
{
  const char *name;
  switch (-result) {
    case ENOTSUP: name = "ENOTSUP"; break;
    case ENODEV: name = "ENODEV"; break;
    case EINVAL: name = "EINVAL"; break;
    case EBUSY: name = "EBUSY"; break;
    case ENOMEM: name = "ENOMEM"; break;
    case EOVERFLOW: name = "EOVERFLOW"; break;
    case ETIMEDOUT: name = "ETIMEDOUT"; break;
    case EPROTO: name = "EPROTO"; break;
    case ECANCELED: name = "ECANCELED"; break;
    default: name = "EIO"; break;
  }
  return JS_ThrowInternalError(ctx, "%s", name);
}

static JSValue mic_start(JSContext *ctx, JSValueConst self,
                         int argc, JSValueConst *argv)
{
  (void)self;
  double rate, frame;
  if (argc < 2) return JS_ThrowTypeError(ctx, "micStart needs sample rate and frame duration");
  if (JS_ToFloat64(ctx, &rate, argv[0]) || JS_ToFloat64(ctx, &frame, argv[1]))
    return JS_EXCEPTION;
  if (!isfinite(rate) || !isfinite(frame) || rate < 8000 || rate > 48000 ||
      trunc(rate) != rate || frame < 10 || frame > 500 || trunc(frame) != frame)
    return JS_ThrowRangeError(ctx, "EINVAL");
  int result = px_mic_start((unsigned)rate, (unsigned)frame);
  return result < 0 ? mic_error(ctx, result) : JS_UNDEFINED;
}

enum { MIC_AVAILABLE, MIC_ACTIVE, MIC_BUSY, MIC_STOP };
static JSValue mic_control(JSContext *ctx, JSValueConst self,
                           int argc, JSValueConst *argv, int operation)
{
  (void)self; (void)argc; (void)argv;
  if (operation == MIC_AVAILABLE) return JS_NewBool(ctx, px_mic_available());
  if (operation == MIC_ACTIVE) return JS_NewBool(ctx, px_mic_active());
  if (operation == MIC_BUSY) return JS_NewBool(ctx, px_mic_busy());
  px_mic_stop();
  return JS_UNDEFINED;
}

static JSValue mic_gain(JSContext *ctx, JSValueConst self,
                        int argc, JSValueConst *argv)
{
  (void)self;
  double number;
  if (!argc) return JS_ThrowTypeError(ctx, "setGain needs a number");
  if (JS_ToFloat64(ctx, &number, argv[0])) return JS_EXCEPTION;
  if (!isfinite(number)) return JS_ThrowRangeError(ctx, "EINVAL");
  int gain = number < 0 ? 0 : number > 100 ? 100 : (int)number;
  int result = px_mic_set_gain(gain);
  return result < 0 ? mic_error(ctx, result) : JS_UNDEFINED;
}

static JSValue mic_poll(JSContext *ctx, JSValueConst self,
                        int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  struct px_mic_frame frame;
  /* 采集始终使用10ms帧；每次最多100ms，公开回调仍由micHub按要求拆帧。 */
  int result = px_mic_poll(&frame, 10);
  if (result < 0) return mic_error(ctx, result);
  if (!result) return JS_NULL;
  JSValue bytes = JS_NewArrayBufferCopy(ctx, frame.data, frame.bytes);
  free(frame.data);
  if (JS_IsException(bytes)) return bytes;
  JSValue event = JS_NewObject(ctx);
  if (JS_IsException(event)) { JS_FreeValue(ctx, bytes); return event; }
  if (JS_SetPropertyStr(ctx, event, "data", bytes) < 0 ||
      JS_SetPropertyStr(ctx, event, "sampleRate", JS_NewUint32(ctx, frame.sample_rate)) < 0) {
    JS_FreeValue(ctx, event);
    return JS_EXCEPTION;
  }
  return event;
}

/* 语音20ms帧的能量计算在原生循环执行；整数平方和在2^53内，与JS逐样本累加完全一致。 */
static JSValue mic_pcm_rms(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc || JS_GetTypedArrayType(argv[0]) != JS_TYPED_ARRAY_UINT8)
    return JS_ThrowTypeError(ctx, "micPcmRms needs Uint8Array PCM16LE");
  size_t offset, bytes, element, capacity;
  JSValue owner = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &bytes, &element);
  if (JS_IsException(owner)) return JS_EXCEPTION;
  const uint8_t *data = JS_GetArrayBuffer(ctx, &capacity, owner);
  JSValue result = JS_UNDEFINED;
  if (JS_HasException(ctx)) result = JS_EXCEPTION;
  else if (!data || !bytes || bytes % 2 || bytes > 48000 || offset > capacity || bytes > capacity - offset)
    result = JS_ThrowRangeError(ctx, "invalid PCM16LE frame");
  else {
    uint64_t sum = 0;
    data += offset;
    for (size_t i = 0; i < bytes; i += 2) {
      int32_t sample = data[i] | (uint32_t)data[i + 1] << 8;
      if (sample >= 32768) sample -= 65536;
      sum += (uint32_t)(sample * sample);
    }
    result = JS_NewFloat64(ctx, sqrt((double)sum / (bytes / 2)));
  }
  JS_FreeValue(ctx, owner);
  return result;
}

void px_install_mic(JSContext *ctx, JSValue native)
{
  const char *controls[] = {"micAvailable", "micActive", "micBusy", "micStop"};
  for (int i = 0; i < 4; ++i)
    JS_SetPropertyStr(ctx, native, controls[i], JS_NewCFunctionMagic(ctx,
                       mic_control, controls[i], 0, JS_CFUNC_generic_magic, i));
  JS_SetPropertyStr(ctx, native, "micStart", JS_NewCFunction(ctx, mic_start, "micStart", 2));
  JS_SetPropertyStr(ctx, native, "micSetGain", JS_NewCFunction(ctx, mic_gain, "micSetGain", 1));
  JS_SetPropertyStr(ctx, native, "micPoll", JS_NewCFunction(ctx, mic_poll, "micPoll", 0));
  JS_SetPropertyStr(ctx, native, "micPcmRms", JS_NewCFunction(ctx, mic_pcm_rms, "micPcmRms", 1));
}
