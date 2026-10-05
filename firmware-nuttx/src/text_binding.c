/* 文字绑定与渲染分开：所有 JS 值仅在调用线程内解析和释放。 */
#include "quickjs.h"
#include "pixelbox_text.h"
#include <stdint.h>
#include <string.h>

static int text_style(JSContext *ctx, JSValueConst value,
                      struct px_text_style *style)
{
  *style = (struct px_text_style){NULL, 0xffffff, 1, PX_TEXT_LEFT, false};
  if (JS_IsUndefined(value) || JS_IsNull(value)) return 0;
  if (!JS_IsObject(value)) {
    JS_ThrowTypeError(ctx, "text style must be an object"); return -1;
  }
  const char *names[] = {"color", "font", "scale", "align", "smooth"};
  for (int i = 0; i < 5; ++i) {
    JSValue property = JS_GetPropertyStr(ctx, value, names[i]);
    if (JS_IsException(property)) return -1;
    int failed = 0;
    if (!JS_IsUndefined(property)) {
      if (i == 0) failed = JS_ToUint32(ctx, &style->color, property);
      else if (i == 1 && JS_IsString(property)) {
        style->font = JS_ToCString(ctx, property);
        failed = style->font ? 0 : -1;
      } else if (i == 2) {
        int32_t scale;
        failed = JS_ToInt32(ctx, &scale, property);
        if (!failed) style->scale = scale < 1 ? 1 : scale > 8 ? 8 : (int)scale;
      } else if (i == 3 && JS_IsString(property)) {
        const char *align = JS_ToCString(ctx, property);
        if (!align) failed = -1;
        else {
          if (!strcmp(align, "center")) style->align = PX_TEXT_CENTER;
          else if (!strcmp(align, "right")) style->align = PX_TEXT_RIGHT;
          JS_FreeCString(ctx, align);
        }
      } else if (i == 4) {
        int smooth = JS_ToBool(ctx, property);
        failed = smooth < 0; style->smooth = smooth > 0;
      }
    }
    JS_FreeValue(ctx, property);
    if (failed) return -1;
  }
  return 0;
}

static JSValue measure_text(JSContext *ctx, JSValueConst self,
                             int argc, JSValueConst *argv)
{
  (void)self;
  if (!argc) return JS_ThrowTypeError(ctx, "measureText needs text");
  struct px_text_style style;
  int error = text_style(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, &style);
  const char *text = error ? NULL : JS_ToCString(ctx, argv[0]);
  struct px_text_metrics metrics;
  int result = text ? px_text_measure(text, &style, &metrics) : -1;
  JS_FreeCString(ctx, text); JS_FreeCString(ctx, style.font);
  if (error || !text) return JS_EXCEPTION;
  if (result) return JS_ThrowRangeError(ctx, "invalid text dimensions (%d)", result);
  JSValue value = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, value, "width", JS_NewInt32(ctx, metrics.width));
  JS_SetPropertyStr(ctx, value, "height", JS_NewInt32(ctx, metrics.height));
  return value;
}

static JSValue draw_text(JSContext *ctx, JSValueConst self,
                          int argc, JSValueConst *argv)
{
  (void)self;
  if (argc < 6 || JS_GetTypedArrayType(argv[0]) != JS_TYPED_ARRAY_UINT32)
    return JS_ThrowTypeError(ctx, "drawText needs RGB pixels, dimensions, text and coordinates");
  int32_t width, height, x, y;
  if (JS_ToInt32(ctx, &width, argv[1]) || JS_ToInt32(ctx, &height, argv[2]) ||
      JS_ToInt32(ctx, &x, argv[4]) || JS_ToInt32(ctx, &y, argv[5])) return JS_EXCEPTION;
  if (width < 1 || height < 1 || width > 2048 || height > 2048)
    return JS_ThrowRangeError(ctx, "invalid canvas dimensions");
  struct px_text_style style;
  int error = text_style(ctx, argc > 6 ? argv[6] : JS_UNDEFINED, &style);
  const char *text = error ? NULL : JS_ToCString(ctx, argv[3]);
  if (error || !text) { JS_FreeCString(ctx, style.font); return JS_EXCEPTION; }
  /* style getter 可执行任意 JS，必须在其完成后重新获取并检查像素缓冲区。 */
  size_t offset, length, element, capacity;
  JSValue owner = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &length, &element);
  JSValue result = JS_EXCEPTION;
  if (!JS_IsException(owner)) {
    uint8_t *base = JS_GetArrayBuffer(ctx, &capacity, owner);
    if (!base || offset > capacity || length > capacity - offset ||
        length != (size_t)width * height * sizeof(uint32_t)) {
      result = JS_ThrowRangeError(ctx, "invalid canvas buffer");
    } else {
      int ret = px_text_draw((uint32_t *)(base + offset), length / 4,
                             width, height, width, text, x, y, &style);
      if (ret) {
        result = JS_ThrowRangeError(ctx, "text drawing failed (%d)", ret);
      } else {
        /* 与绘制共用同一份已转换的 C 字符串，避免 JS 侧再次 ToString。
         * prelude 依据此度量登记精确脏区；旧调用方忽略返回值即可保持兼容。 */
        struct px_text_metrics metrics;
        ret = px_text_measure(text, &style, &metrics);
        if (ret) {
          result = JS_ThrowRangeError(ctx, "text measurement failed (%d)", ret);
        } else {
          /* 画布上常见字体度量均小于4096，打包为一个无分配的 JS int；
           * 极端超宽文本再退回对象，保持尺寸不会截断。 */
          if (metrics.width >= 0 && metrics.width < 4096 &&
              metrics.height >= 0 && metrics.height < 4096) {
            result = JS_NewInt32(ctx, (metrics.width << 12) | metrics.height);
          } else {
            result = JS_NewObject(ctx);
            if (!JS_IsException(result)) {
              JS_SetPropertyStr(ctx, result, "width", JS_NewInt32(ctx, metrics.width));
              JS_SetPropertyStr(ctx, result, "height", JS_NewInt32(ctx, metrics.height));
            }
          }
        }
      }
    }
    JS_FreeValue(ctx, owner);
  }
  JS_FreeCString(ctx, text); JS_FreeCString(ctx, style.font);
  return result;
}

void px_install_text(JSContext *ctx, JSValue native)
{
  JS_SetPropertyStr(ctx, native, "drawText", JS_NewCFunction(ctx, draw_text, "drawText", 7));
  JS_SetPropertyStr(ctx, native, "measureText", JS_NewCFunction(ctx, measure_text, "measureText", 2));
}
