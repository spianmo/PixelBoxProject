#ifndef PIXELBOX_NUTTX_IMAGE_H
#define PIXELBOX_NUTTX_IMAGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum px_image_format {
  PX_IMAGE_UNKNOWN = 0, PX_IMAGE_PNG, PX_IMAGE_JPEG, PX_IMAGE_GIF
};

/* 各项为零时使用默认值。工作内存上限含当前输出帧、透明掩码和解码器，
 * 不含调用者持有的输入及已经交付的旧帧；GIF 收集器须另限制累计帧内存。
 * 默认：输入8MiB、1M像素、边长2048、工作内存4MiB、GIF最多256帧。
 */
struct px_image_limits {
  size_t max_input_bytes;
  size_t max_pixels;
  size_t max_working_bytes;
  unsigned max_dimension;
  unsigned max_frames;
};

struct px_image {
  unsigned width;
  unsigned height;
  uint32_t *pixels;      /* 行优先 0xRRGGBB，每行恰好 width 像素。 */
  uint8_t *alpha;        /* NULL=全不透明；否则每行ceil(width/8)字节，MSB在左，1=不透明。 */
  unsigned duration_ms; /* 静态图为0；GIF延迟为0时沿用原固件的100ms。 */
};

struct px_gif;

enum px_image_format px_image_sniff(const uint8_t *data, size_t length);

/* out 必须清零或已 free；成功获得独立缓冲，失败保持空结果。
 * PNG alpha<128 视为透明，JPEG支持基线灰度/YCbCr，渐进式明确返回-ENOTSUP。
 * GIF静态解码返回第一帧；帧已按GIF背景色/透明索引/disposal合成，与原固件一致。
 * GIF87a/89a须带全局色表；只有局部色表的GIF明确返回-ENOTSUP。
 * BMP并非原固件支持格式，返回-ENOTSUP。
 */
int px_image_decode(const uint8_t *data, size_t length,
                     const struct px_image_limits *limits, struct px_image *out);
void px_image_free(struct px_image *image);

/* 将精确匹配0xRRGGBB的像素叠加到透明掩码；不修改像素颜色。 */
int px_image_apply_color_key(struct px_image *image, uint32_t color);

/* GIF句柄借用data，直到close前输入不得释放或修改；没有全局状态。
 * next: 1=独立新帧，0=正常结束，负errno=失败。每一帧由调用者image_free。
 * 失败不会把已解出的部分动画当作成功；open预先检查完整结构与帧数上限。
 */
int px_gif_open(const uint8_t *data, size_t length,
                const struct px_image_limits *limits, struct px_gif **out);
int px_gif_next(struct px_gif *gif, struct px_image *out);
void px_gif_close(struct px_gif *gif);

#ifdef __cplusplus
}
#endif
#endif
