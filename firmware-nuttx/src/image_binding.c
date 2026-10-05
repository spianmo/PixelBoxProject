/* 图片绑定只借用当前调用的输入；输出复制入QuickJS计费堆，不能绕过VM内存上限。 */
#include "quickjs.h"
#include "pixelbox_image.h"
#include <errno.h>
#include <stdint.h>

#define PX_ANIMATION_BYTES ((size_t)4 * 1024 * 1024)

static int binary_input(JSContext *ctx, JSValueConst value, const uint8_t **data,
                         size_t *length, JSValue *owner)
{
  *owner = JS_UNDEFINED;
  if (JS_GetTypedArrayType(value) == JS_TYPED_ARRAY_UINT8) {
    size_t offset, element, capacity;
    *owner = JS_GetTypedArrayBuffer(ctx, value, &offset, length, &element);
    if (JS_IsException(*owner)) return -1;
    uint8_t *base = JS_GetArrayBuffer(ctx, &capacity, *owner);
    if (JS_HasException(ctx)) return -1;
    if (!base || offset > capacity || *length > capacity - offset) {
      JS_ThrowTypeError(ctx, "invalid image binary view"); return -1;
    }
    *data = base + offset;
    return 0;
  }
  if (!JS_IsArrayBuffer(value)) {
    JS_ThrowTypeError(ctx, "image source must be ArrayBuffer or Uint8Array"); return -1;
  }
  *owner = JS_DupValue(ctx, value);
  *data = JS_GetArrayBuffer(ctx, length, value);
  return JS_HasException(ctx) ? -1 : 0;
}

static JSValue image_error(JSContext *ctx, int result)
{
  if (result == -ENOMEM) return JS_ThrowOutOfMemory(ctx);
  if (result == -EFBIG) return JS_ThrowRangeError(ctx, "image dimensions, frames or memory exceed limits");
  if (result == -ENOTSUP) return JS_ThrowTypeError(ctx, "unsupported image format");
  return JS_ThrowTypeError(ctx, "invalid or truncated image (%d)", result);
}

/* DefineProperty创建自有数据属性，防止恶意原型setter在解码中途detach输入。 */
static int property(JSContext *ctx, JSValue object, const char *name, JSValue value)
{
  if (JS_IsException(value)) return -1;
  return JS_DefinePropertyValueStr(ctx, object, name, value, JS_PROP_C_W_E);
}

static JSValue wrap_image(JSContext *ctx, const struct px_image *image)
{
  JSValue object = JS_NewObject(ctx);
  if (JS_IsException(object)) return object;
  const size_t pixel_bytes = (size_t)image->width * image->height * sizeof(uint32_t);
  const size_t alpha_bytes = ((size_t)image->width + 7) / 8 * image->height;
  if (property(ctx, object, "width", JS_NewUint32(ctx, image->width)) < 0 ||
      property(ctx, object, "height", JS_NewUint32(ctx, image->height)) < 0 ||
      property(ctx, object, "duration", JS_NewUint32(ctx, image->duration_ms)) < 0 ||
      property(ctx, object, "pixels", JS_NewArrayBufferCopy(ctx, (const uint8_t *)image->pixels, pixel_bytes)) < 0 ||
      property(ctx, object, "alpha", image->alpha ? JS_NewArrayBufferCopy(ctx, image->alpha, alpha_bytes) : JS_NULL) < 0) {
    JS_FreeValue(ctx, object); return JS_EXCEPTION;
  }
  return object;
}

static JSValue decode_image(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc) return JS_ThrowTypeError(ctx, "decodeImage needs binary data");
  const uint8_t *data;
  size_t length;
  JSValue owner;
  if (binary_input(ctx, argv[0], &data, &length, &owner)) {
    JS_FreeValue(ctx, owner); return JS_EXCEPTION;
  }
  struct px_image image = {0};
  int result = px_image_decode(data, length, NULL, &image);
  JSValue output = result ? image_error(ctx, result) : wrap_image(ctx, &image);
  px_image_free(&image);
  JS_FreeValue(ctx, owner);
  return output;
}

static JSValue load_gif_frames(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc) return JS_ThrowTypeError(ctx, "loadGifFrames needs binary data");
  const uint8_t *data;
  size_t length;
  JSValue owner;
  if (binary_input(ctx, argv[0], &data, &length, &owner)) {
    JS_FreeValue(ctx, owner); return JS_EXCEPTION;
  }
  struct px_gif *gif = NULL;
  int result = px_gif_open(data, length, NULL, &gif);
  JSValue frames = result ? image_error(ctx, result) : JS_NewArray(ctx);
  size_t total = 0;
  uint32_t count = 0;
  if (!JS_IsException(frames)) {
    struct px_image image = {0};
    while ((result = px_gif_next(gif, &image)) == 1) {
      const size_t bytes = (size_t)image.width * image.height * sizeof(uint32_t) +
        (image.alpha ? ((size_t)image.width + 7) / 8 * image.height : 0);
      /* 达上限整次失败，不把截短动画交给脚本当成完整结果。 */
      if (bytes > PX_ANIMATION_BYTES - total) {
        px_image_free(&image); result = -EFBIG; break;
      }
      total += bytes;
      JSValue frame = wrap_image(ctx, &image);
      px_image_free(&image);
      if (JS_IsException(frame) ||
          JS_DefinePropertyValueUint32(ctx, frames, count++, frame, JS_PROP_C_W_E) < 0) {
        result = 0;
        JS_FreeValue(ctx, frames); frames = JS_EXCEPTION; break;
      }
    }
    if (result < 0) {
      JS_FreeValue(ctx, frames); frames = image_error(ctx, result);
    }
  }
  px_gif_close(gif);
  JS_FreeValue(ctx, owner);
  return frames;
}

void px_install_image(JSContext *ctx, JSValue native)
{
  JS_SetPropertyStr(ctx, native, "decodeImage", JS_NewCFunction(ctx, decode_image, "decodeImage", 1));
  JS_SetPropertyStr(ctx, native, "loadGifFrames", JS_NewCFunction(ctx, load_gif_frames, "loadGifFrames", 1));
}
