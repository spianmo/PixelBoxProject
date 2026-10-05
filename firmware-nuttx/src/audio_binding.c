/* QuickJS 绑定只在 VM 主线程执行；后台结果由 audioPoll 显式收取。 */
#include "quickjs.h"
#include "pixelbox_audio.h"

#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

static const char *audio_error_name(int error)
{
  switch (-error) {
    case ENOTSUP: return "ENOTSUP";
    case ENODEV: case ENOENT: return "ENODEV";
    case EBUSY: return "EBUSY";
    case EAGAIN: return "EAGAIN";
    case ENOMEM: return "ENOMEM";
    case EINVAL: return "EINVAL";
    case EBADMSG: return "EBADMSG";
    case ECANCELED: return "ECANCELED";
    case ETIMEDOUT: return "ETIMEDOUT";
    default: return "EIO";
  }
}

static JSValue audio_error(JSContext *ctx, int error)
{
  return JS_ThrowInternalError(ctx, "%s", audio_error_name(error));
}

static int audio_ready(JSContext *ctx)
{
  int result = px_audio_init();
  if (result < 0) audio_error(ctx, result);
  return result;
}

static int audio_uint(JSContext *ctx, JSValueConst value, uint32_t *result)
{
  double number;
  if (JS_ToFloat64(ctx, &number, value)) return -1;
  if (!isfinite(number) || number < 0 || number > UINT32_MAX ||
      trunc(number) != number) {
    JS_ThrowRangeError(ctx, "EINVAL");
    return -1;
  }
  *result = (uint32_t)number;
  return 0;
}

static int audio_binary(JSContext *ctx, JSValueConst value,
                        const uint8_t **bytes, size_t *length)
{
  if (JS_GetTypedArrayType(value) == JS_TYPED_ARRAY_UINT8) {
    size_t offset, element, capacity;
    JSValue owner = JS_GetTypedArrayBuffer(ctx, value, &offset, length, &element);
    if (JS_IsException(owner)) return -1;
    uint8_t *base = JS_GetArrayBuffer(ctx, &capacity, owner);
    bool invalid = JS_HasException(ctx) || offset > capacity ||
                   *length > capacity - offset;
    *bytes = base ? base + offset : NULL;
    JS_FreeValue(ctx, owner);
    return invalid ? -1 : 0;
  }
  if (!JS_IsArrayBuffer(value)) {
    JS_ThrowTypeError(ctx, "expected ArrayBuffer or Uint8Array");
    return -1;
  }
  *bytes = JS_GetArrayBuffer(ctx, length, value);
  return JS_HasException(ctx) ? -1 : 0;
}

static int32_t pcm16le(const uint8_t *data)
{
  int32_t sample = data[0] | (uint32_t)data[1] << 8;
  return sample >= 32768 ? sample - 65536 : sample;
}

/* 独立块沿用原JS/ESP-IDF格式：样本数、首样本、初始索引、保留字节，再低半字节先行。 */
static JSValue audio_ima_adpcm(JSContext *ctx, JSValueConst self,
                              int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc) return JS_ThrowTypeError(ctx, "expected ArrayBuffer or Uint8Array");
  const uint8_t *data; size_t bytes;
  if (audio_binary(ctx, argv[0], &data, &bytes) < 0) return JS_EXCEPTION;
  if (!bytes || bytes % 2 || bytes > 8192)
    return JS_ThrowRangeError(ctx, "PCM must contain 1..4096 PCM16LE samples");
  static const int16_t steps[] = {
    7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,
    130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,
    1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,
    5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,
    22385,24623,27086,29794,32767
  };
  static const int8_t shifts[] = {-1,-1,-1,-1,2,4,6,8};
  size_t count = bytes / 2, length = 6 + count / 2;
  int32_t predicted = pcm16le(data), index = 0;
  if (count > 1) {
    int32_t difference = pcm16le(data + 2) - predicted;
    if (difference < 0) difference = -difference;
    while (index < 88 && steps[index] < difference) ++index;
  }
  /* 仅申请最多2054字节输出；没有用户getter/valueOf，可在原生计算期间持有输入地址。 */
  uint8_t *encoded = js_mallocz(ctx, length);
  if (!encoded) return JS_EXCEPTION;
  encoded[0] = (uint8_t)count; encoded[1] = (uint8_t)(count >> 8);
  encoded[2] = data[0]; encoded[3] = data[1]; encoded[4] = (uint8_t)index;
  for (size_t i = 1; i < count; ++i) {
    int32_t delta = pcm16le(data + i * 2) - predicted;
    int code = delta < 0 ? 8 : 0, step = steps[index], change = step >> 3;
    if (delta < 0) delta = -delta;
    for (int bit = 4; bit; bit >>= 1, step >>= 1) {
      if (delta >= step) { code |= bit; delta -= step; change += step; }
    }
    predicted += code & 8 ? -change : change;
    if (predicted < -32768) predicted = -32768;
    if (predicted > 32767) predicted = 32767;
    index += shifts[code & 7];
    if (index < 0) index = 0;
    if (index > 88) index = 88;
    encoded[6 + (i - 1) / 2] |= (uint8_t)(code << (((i - 1) % 2) * 4));
  }
  JSValue result = JS_NewArrayBufferCopy(ctx, encoded, length);
  js_free(ctx, encoded);
  return result;
}

static JSValue audio_available(JSContext *ctx, JSValueConst self,
                               int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  return JS_NewBool(ctx, px_audio_init() == 0);
}

static JSValue audio_volume(JSContext *ctx, JSValueConst self,
                            int argc, JSValueConst *argv, int set)
{
  (void)self;
  if (audio_ready(ctx) < 0) return JS_EXCEPTION;
  int result;
  if (set) {
    double value;
    if (!argc) return JS_ThrowTypeError(ctx, "setVolume needs a number");
    if (JS_ToFloat64(ctx, &value, argv[0])) return JS_EXCEPTION;
    if (!isfinite(value)) return JS_ThrowRangeError(ctx, "EINVAL");
    int volume = value < 0 ? 0 : value > 100 ? 100 : (int)value;
    result = px_audio_set_volume(volume);
    return result < 0 ? audio_error(ctx, result) : JS_UNDEFINED;
  }
  result = px_audio_get_volume();
  return result < 0 ? audio_error(ctx, result) : JS_NewInt32(ctx, result);
}

static JSValue audio_tone(JSContext *ctx, JSValueConst self,
                          int argc, JSValueConst *argv)
{
  (void)self;
  if (audio_ready(ctx) < 0) return JS_EXCEPTION;
  double frequency, volume;
  uint32_t duration, job;
  if (argc < 3) return JS_ThrowTypeError(ctx, "audioTone needs frequency, duration, volume");
  if (JS_ToFloat64(ctx, &frequency, argv[0]) ||
      audio_uint(ctx, argv[1], &duration) ||
      JS_ToFloat64(ctx, &volume, argv[2])) return JS_EXCEPTION;
  if (!isfinite(volume)) return JS_ThrowRangeError(ctx, "EINVAL");
  int amplitude = volume < 0 ? 0 : volume > 100 ? 100 : (int)volume;
  int result = px_audio_tone((float)frequency, duration, amplitude, &job);
  return result < 0 ? audio_error(ctx, result) : JS_NewUint32(ctx, job);
}

static JSValue audio_start(JSContext *ctx, JSValueConst self,
                           int argc, JSValueConst *argv, int stream)
{
  (void)self;
  if (audio_ready(ctx) < 0) return JS_EXCEPTION;
  int offset = stream ? 0 : 1;
  uint32_t rate, channels, job;
  if (argc < offset + 2) return JS_ThrowTypeError(ctx, "audio source needs rate and channels");
  if (audio_uint(ctx, argv[offset], &rate) ||
      audio_uint(ctx, argv[offset + 1], &channels)) return JS_EXCEPTION;
  int result;
  if (stream) result = px_audio_stream_open(rate, channels, &job);
  else {
    const uint8_t *bytes;
    size_t length;
    /* 数字转换可调用用户代码，先解析参数再获取二进制指针，防止脱离缓冲。 */
    if (audio_binary(ctx, argv[0], &bytes, &length)) return JS_EXCEPTION;
    result = px_audio_play_pcm(bytes, length, rate, channels, &job);
  }
  return result < 0 ? audio_error(ctx, result) : JS_NewUint32(ctx, job);
}

static JSValue audio_feed(JSContext *ctx, JSValueConst self,
                          int argc, JSValueConst *argv)
{
  (void)self;
  if (audio_ready(ctx) < 0) return JS_EXCEPTION;
  uint32_t job;
  const uint8_t *bytes;
  size_t length;
  if (argc < 2) return JS_ThrowTypeError(ctx, "audioStreamFeed needs job and PCM");
  if (audio_uint(ctx, argv[0], &job) ||
      audio_binary(ctx, argv[1], &bytes, &length)) return JS_EXCEPTION;
  int result = px_audio_stream_feed(job, bytes, length);
  return result < 0 ? audio_error(ctx, result) : JS_UNDEFINED;
}

static JSValue audio_encoded(JSContext *ctx, JSValueConst self,
                             int argc, JSValueConst *argv)
{
  (void)self;
  if (audio_ready(ctx) < 0) return JS_EXCEPTION;
  if (!argc) return JS_ThrowTypeError(ctx, "audioPlayEncoded needs WAV or MP3 bytes");
  const uint8_t *bytes;
  size_t length;
  uint32_t job;
  if (audio_binary(ctx, argv[0], &bytes, &length)) return JS_EXCEPTION;
  int result = px_audio_play_encoded(bytes, length, &job);
  return result < 0 ? audio_error(ctx, result) : JS_NewUint32(ctx, job);
}

enum audio_control { CONTROL_END, CONTROL_STOP, CONTROL_PAUSE, CONTROL_BUFFERED,
                     CONTROL_PLAYING, CONTROL_STOP_ALL, CONTROL_SHUTDOWN };

static JSValue audio_control(JSContext *ctx, JSValueConst self,
                             int argc, JSValueConst *argv, int operation)
{
  (void)self;
  uint32_t job = 0;
  if (argc && audio_uint(ctx, argv[0], &job)) return JS_EXCEPTION;
  /* 查询/清理在未支持平台也可安全调用，其余方法明确抛 ENOTSUP。 */
  if (operation == CONTROL_PLAYING) return JS_NewBool(ctx, px_audio_playing(job));
  if (operation == CONTROL_SHUTDOWN) { px_audio_shutdown(); return JS_UNDEFINED; }
  if (audio_ready(ctx) < 0) return JS_EXCEPTION;
  if (operation == CONTROL_STOP_ALL) { px_audio_stop_all(); return JS_UNDEFINED; }
  if (!argc) return JS_ThrowTypeError(ctx, "audio control needs job id");
  int result;
  switch (operation) {
    case CONTROL_END: result = px_audio_stream_end(job); break;
    case CONTROL_STOP: result = px_audio_stop(job); break;
    case CONTROL_PAUSE: {
      if (argc < 2) return JS_ThrowTypeError(ctx, "audioPause needs paused flag");
      int paused = JS_ToBool(ctx, argv[1]);
      if (paused < 0) return JS_EXCEPTION;
      result = px_audio_pause(job, paused != 0); break;
    }
    case CONTROL_BUFFERED: result = px_audio_buffered_ms(job); break;
    default: return JS_ThrowInternalError(ctx, "EINVAL");
  }
  if (result < 0) return audio_error(ctx, result);
  return operation == CONTROL_BUFFERED ? JS_NewInt32(ctx, result) : JS_UNDEFINED;
}

static JSValue audio_poll(JSContext *ctx, JSValueConst self,
                          int argc, JSValueConst *argv)
{
  (void)self; (void)argc; (void)argv;
  struct px_audio_result result;
  int ready = px_audio_poll(&result);
  if (ready < 0) return audio_error(ctx, ready);
  if (!ready) return JS_NULL;
  JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "jobId", JS_NewUint32(ctx, result.job_id));
  JS_SetPropertyStr(ctx, value, "error", JS_NewInt32(ctx, result.error));
  JS_SetPropertyStr(ctx, value, "started", JS_NewBool(ctx, result.started));
  JS_SetPropertyStr(ctx, value, "code", JS_NewString(ctx,
                    result.error ? audio_error_name(result.error) : ""));
  return value;
}

void px_install_audio(JSContext *ctx, JSValue native)
{
  JS_SetPropertyStr(ctx, native, "encodeImaAdpcm", JS_NewCFunction(ctx, audio_ima_adpcm, "encodeImaAdpcm", 1));
  JS_SetPropertyStr(ctx, native, "audioAvailable", JS_NewCFunction(ctx, audio_available, "audioAvailable", 0));
  JS_SetPropertyStr(ctx, native, "audioSetVolume", JS_NewCFunctionMagic(ctx, audio_volume, "audioSetVolume", 1, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(ctx, native, "audioGetVolume", JS_NewCFunctionMagic(ctx, audio_volume, "audioGetVolume", 0, JS_CFUNC_generic_magic, 0));
  JS_SetPropertyStr(ctx, native, "audioTone", JS_NewCFunction(ctx, audio_tone, "audioTone", 3));
  JS_SetPropertyStr(ctx, native, "audioPlayPcm", JS_NewCFunctionMagic(ctx, audio_start, "audioPlayPcm", 3, JS_CFUNC_generic_magic, 0));
  JS_SetPropertyStr(ctx, native, "audioPlayEncoded", JS_NewCFunction(ctx, audio_encoded, "audioPlayEncoded", 1));
  JS_SetPropertyStr(ctx, native, "audioStreamOpen", JS_NewCFunctionMagic(ctx, audio_start, "audioStreamOpen", 2, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(ctx, native, "audioStreamFeed", JS_NewCFunction(ctx, audio_feed, "audioStreamFeed", 2));
  JS_SetPropertyStr(ctx, native, "audioPoll", JS_NewCFunction(ctx, audio_poll, "audioPoll", 0));
  const char *controls[] = {"audioStreamEnd", "audioStop", "audioPause",
                            "audioBuffered", "audioPlaying", "audioStopAll", "audioShutdown"};
  for (int i = 0; i < 7; ++i)
    JS_SetPropertyStr(ctx, native, controls[i], JS_NewCFunctionMagic(ctx,
                       audio_control, controls[i], i == CONTROL_PAUSE ? 2 : 1,
                       JS_CFUNC_generic_magic, i));
}
