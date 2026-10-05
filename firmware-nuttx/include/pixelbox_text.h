#ifndef PIXELBOX_NUTTX_TEXT_H
#define PIXELBOX_NUTTX_TEXT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum px_text_align {
  PX_TEXT_LEFT = 0,
  PX_TEXT_CENTER = 1,
  PX_TEXT_RIGHT = 2
};

struct px_text_style {
  const char *font;              /* pixel8/pixel12/pixel16；未知名回退 pixel8。 */
  uint32_t color;                /* Canvas 的 0xRRGGBB，不含透明度。 */
  int scale;                    /* 与原绑定一致，钳制到 1..8。 */
  enum px_text_align align;      /* 每一行分别以 x 为水平锚点。 */
  bool smooth;                  /* 2/3/4/6/8 倍使用 Scale2x/3x。 */
};

struct px_text_metrics {
  int width;
  int height;
};

/* style 为 NULL 时：pixel8、白色、1 倍、左对齐、不平滑。
 * UTF-8 文本必须以 NUL 结尾；换行规则与 ESP-IDF gfx::measure_text 一致：
 * 空串为 0x0，尾部换行不额外增加一行。返回 0 或负 errno。
 */
int px_text_measure(const char *utf8, const struct px_text_style *style,
                    struct px_text_metrics *metrics);

/* 在现有 Uint32Array 画布直接绘制，stride/pixel_count 均以像素为单位。
 * 保留背景，仅写入文字笔画；负坐标和画布外字形会裁剪。
 * 绘制前校验整个缓冲区尺寸及文本尺寸，参数错误不会部分绘制。
 * 不持有输入缓冲区、字体名或文本；支持不同画布并发调用。
 */
int px_text_draw(uint32_t *pixels, size_t pixel_count,
                 int width, int height, int stride, const char *utf8,
                 int x, int y, const struct px_text_style *style);

#ifdef __cplusplus
}
#endif
#endif
