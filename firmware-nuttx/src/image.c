/* 便携图片解码：RGB888输出，借用输入，显式限制解码工作集与GIF帧数。 */
#include "pixelbox_image.h"
#include "pngle.h"
#include "gifdec.h"
#include "tjpgd.h"

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#define PX_IMAGE_MIB ((size_t)1024 * 1024)
#define PX_JPEG_WORKSPACE ((size_t)64 * 1024)

struct px_gif {
  gd_GIF *decoder;
  unsigned frames;
  unsigned decoded;
  bool failed;
};

static struct px_image_limits normalized(const struct px_image_limits *input)
{
  struct px_image_limits limits = {8 * PX_IMAGE_MIB, 1024 * 1024,
                                   4 * PX_IMAGE_MIB, 2048, 256};
  if (input) {
    if (input->max_input_bytes) limits.max_input_bytes = input->max_input_bytes;
    if (input->max_pixels) limits.max_pixels = input->max_pixels;
    if (input->max_working_bytes) limits.max_working_bytes = input->max_working_bytes;
    if (input->max_dimension) limits.max_dimension = input->max_dimension;
    if (input->max_frames) limits.max_frames = input->max_frames;
  }
  return limits;
}

static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint16_t be16(const uint8_t *p) { return (uint16_t)(p[0] << 8 | p[1]); }
static uint32_t be32(const uint8_t *p)
{
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static uint32_t rgb(const uint8_t *p)
{
  return (uint32_t)p[0] << 16 | (uint32_t)p[1] << 8 | p[2];
}

static bool empty_output(const struct px_image *image)
{
  return image && !image->pixels && !image->alpha;
}

static int check_input(const uint8_t *data, size_t length,
                        const struct px_image_limits *limits)
{
  if (!data || !length) return -EINVAL;
  if (length > limits->max_input_bytes || length > INT_MAX) return -EFBIG;
  return 0;
}

/* 在任何依赖库分配前核算保守工作集；4096为原画布尺寸的硬上限。 */
static int check_layout(unsigned width, unsigned height,
                         const struct px_image_limits *limits,
                         size_t bytes_per_pixel, size_t overhead)
{
  if (!width || !height) return -EBADMSG;
  if (width > 4096 || height > 4096 || width > limits->max_dimension ||
      height > limits->max_dimension) return -EFBIG;
  const size_t count = (size_t)width * height;
  const size_t mask_bytes = ((size_t)width + 7) / 8 * height;
  if (count > limits->max_pixels || count > (SIZE_MAX - overhead - mask_bytes) / bytes_per_pixel)
    return -EFBIG;
  if (count * bytes_per_pixel + mask_bytes + overhead > limits->max_working_bytes)
    return -EFBIG;
  return 0;
}

static int allocate_image(unsigned width, unsigned height, struct px_image *out)
{
  out->pixels = calloc((size_t)width * height, sizeof(*out->pixels));
  if (!out->pixels) return -ENOMEM;
  out->width = width;
  out->height = height;
  return 0;
}

void px_image_free(struct px_image *image)
{
  if (!image) return;
  free(image->pixels);
  free(image->alpha);
  memset(image, 0, sizeof(*image));
}

static int ensure_alpha(struct px_image *image)
{
  if (image->alpha) return 0;
  const size_t bytes = ((size_t)image->width + 7) / 8 * image->height;
  image->alpha = malloc(bytes);
  if (!image->alpha) return -ENOMEM;
  memset(image->alpha, 0xff, bytes);
  return 0;
}

int px_image_apply_color_key(struct px_image *image, uint32_t color)
{
  if (!image || !image->pixels || !image->width || !image->height ||
      image->width > 4096 || image->height > 4096) return -EINVAL;
  color &= 0xffffff;
  for (unsigned y = 0; y < image->height; ++y)
    for (unsigned x = 0; x < image->width; ++x) {
      if (image->pixels[(size_t)y * image->width + x] != color) continue;
      int result = ensure_alpha(image);
      if (result) return result;
      image->alpha[(size_t)y * ((image->width + 7) / 8) + x / 8] &=
        (uint8_t)~(0x80u >> (x % 8));
    }
  return 0;
}

enum px_image_format px_image_sniff(const uint8_t *data, size_t length)
{
  static const uint8_t png_magic[] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (!data) return PX_IMAGE_UNKNOWN;
  if (length >= 8 && !memcmp(data, png_magic, 8)) return PX_IMAGE_PNG;
  if (length >= 2 && data[0] == 0xff && data[1] == 0xd8) return PX_IMAGE_JPEG;
  if (length >= 6 && (!memcmp(data, "GIF87a", 6) || !memcmp(data, "GIF89a", 6)))
    return PX_IMAGE_GIF;
  return PX_IMAGE_UNKNOWN;
}

struct png_context {
  struct px_image *image;
  int failure;
  bool done;
};

static void png_init(pngle_t *decoder, uint32_t width, uint32_t height)
{
  struct png_context *context = pngle_get_user_data(decoder);
  if (width != context->image->width || height != context->image->height)
    context->failure = -EBADMSG;
}

static void png_draw(pngle_t *decoder, uint32_t x, uint32_t y,
                      uint32_t width, uint32_t height, const uint8_t rgba[4])
{
  struct png_context *context = pngle_get_user_data(decoder);
  struct px_image *image = context->image;
  if (context->failure) return;
  if (x >= image->width || y >= image->height || width > image->width - x ||
      height > image->height - y) { context->failure = -EBADMSG; return; }
  const bool opaque = rgba[3] >= 128;
  if (!opaque && (context->failure = ensure_alpha(image))) return;
  const uint32_t color = rgb(rgba);
  for (uint32_t dy = 0; dy < height; ++dy)
    for (uint32_t dx = 0; dx < width; ++dx) {
      const uint32_t px = x + dx, py = y + dy;
      image->pixels[(size_t)py * image->width + px] = color;
      /* Adam7后续pass可能覆盖早期粗块：不透明位同样必须重新置1。 */
      if (image->alpha) {
        uint8_t *mask = image->alpha + (size_t)py * ((image->width + 7) / 8) + px / 8;
        const uint8_t bit = (uint8_t)(0x80u >> (px % 8));
        if (opaque) *mask |= bit;
        else *mask &= (uint8_t)~bit;
      }
    }
}

static void png_done(pngle_t *decoder)
{
  struct png_context *context = pngle_get_user_data(decoder);
  context->done = true;
}

static int decode_png(const uint8_t *data, size_t length,
                        const struct px_image_limits *limits, struct px_image *out)
{
  if (length < 33 || be32(data + 8) != 13 || memcmp(data + 12, "IHDR", 4)) return -EBADMSG;
  const unsigned width = be32(data + 16), height = be32(data + 20);
  int result = check_layout(width, height, limits, 4, PNGLE_T_SIZE + 16 * (size_t)width + 4096);
  if (result) return result;
  if (data[28] > 1) return -EBADMSG;
  result = allocate_image(width, height, out);
  if (result) return result;
  pngle_t *decoder = pngle_new();
  if (!decoder) { px_image_free(out); return -ENOMEM; }
  struct png_context context = {out, 0, false};
  pngle_set_user_data(decoder, &context);
  pngle_set_init_callback(decoder, png_init);
  pngle_set_draw_callback(decoder, png_draw);
  pngle_set_done_callback(decoder, png_done);
  size_t consumed = 0;
  while (consumed < length && !context.done && !context.failure) {
    const int bytes = pngle_feed(decoder, data + consumed, length - consumed);
    if (bytes <= 0) { context.failure = -EBADMSG; break; }
    consumed += (size_t)bytes;
  }
  result = context.failure ? context.failure : (context.done ? 0 : -EBADMSG);
  pngle_destroy(decoder);
  if (result) px_image_free(out);
  return result;
}

struct jpeg_context {
  const uint8_t *data;
  size_t length;
  size_t offset;
  struct px_image *image;
};

static size_t jpeg_input(JDEC *decoder, uint8_t *buffer, size_t count)
{
  struct jpeg_context *context = decoder->device;
  if (count > context->length - context->offset) count = context->length - context->offset;
  if (buffer) memcpy(buffer, context->data + context->offset, count);
  context->offset += count;
  return count;
}

static int jpeg_output(JDEC *decoder, void *bitmap, JRECT *rectangle)
{
  struct jpeg_context *context = decoder->device;
  struct px_image *image = context->image;
  if (rectangle->right >= image->width || rectangle->bottom >= image->height ||
      rectangle->left > rectangle->right || rectangle->top > rectangle->bottom) return 0;
  const uint8_t *source = bitmap;
  for (unsigned y = rectangle->top; y <= rectangle->bottom; ++y)
    for (unsigned x = rectangle->left; x <= rectangle->right; ++x, source += 3)
      image->pixels[(size_t)y * image->width + x] = rgb(source);
  return 1;
}

static int jpeg_dimensions(const uint8_t *data, size_t length, unsigned *width, unsigned *height)
{
  if (length < 4 || data[length - 2] != 0xff || data[length - 1] != 0xd9) return -EBADMSG;
  size_t offset = 2;
  while (offset < length) {
    if (data[offset++] != 0xff) return -EBADMSG;
    while (offset < length && data[offset] == 0xff) ++offset;
    if (offset >= length) return -EBADMSG;
    const uint8_t marker = data[offset++];
    if (marker == 0xd9 || marker == 0xda) return -EBADMSG;
    if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (length - offset < 2) return -EBADMSG;
    const size_t size = be16(data + offset);
    if (size < 2 || size > length - offset) return -EBADMSG;
    if (marker == 0xc0) {
      if (size < 8) return -EBADMSG;
      if (data[offset + 2] != 8) return -ENOTSUP;
      *height = be16(data + offset + 3);
      *width = be16(data + offset + 5);
      return 0;
    }
    if (marker >= 0xc1 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc)
      return -ENOTSUP;
    offset += size;
  }
  return -EBADMSG;
}

static int decode_jpeg(const uint8_t *data, size_t length,
                         const struct px_image_limits *limits, struct px_image *out)
{
  unsigned width, height;
  int result = jpeg_dimensions(data, length, &width, &height);
  if (result) return result;
  result = check_layout(width, height, limits, 4, PX_JPEG_WORKSPACE + sizeof(JDEC));
  if (result) return result;
  void *workspace = malloc(PX_JPEG_WORKSPACE);
  if (!workspace) return -ENOMEM;
  JDEC decoder;
  struct jpeg_context context = {data, length, 0, out};
  JRESULT status = jd_prepare(&decoder, jpeg_input, workspace, PX_JPEG_WORKSPACE, &context);
  if (status == JDR_OK && (decoder.width != width || decoder.height != height)) status = JDR_FMT1;
  if (status == JDR_OK) {
    result = allocate_image(width, height, out);
    if (!result) status = jd_decomp(&decoder, jpeg_output, 0);
  }
  if (!result && status != JDR_OK)
    result = status == JDR_FMT2 || status == JDR_FMT3 ? -ENOTSUP : -EBADMSG;
  free(workspace);
  if (result) px_image_free(out);
  return result;
}

static bool skip_blocks(const uint8_t *data, size_t length, size_t *offset)
{
  while (*offset < length) {
    const unsigned count = data[(*offset)++];
    if (!count) return true;
    if (count > length - *offset) return false;
    *offset += count;
  }
  return false;
}

/* 先遍历完整GIF块结构，再进入旧LZW核心，避免截断输入导致读取循环不结束。 */
static int gif_structure(const uint8_t *data, size_t length,
                          const struct px_image_limits *limits, unsigned *frames)
{
  if (length < 13) return -EBADMSG;
  const unsigned width = le16(data + 6), height = le16(data + 8);
  int result = check_layout(width, height, limits, 8, 64 * 1024 + sizeof(gd_GIF) + sizeof(struct px_gif));
  if (result) return result;
  if (!(data[10] & 0x80)) return -ENOTSUP;
  const unsigned palette_size = 2u << (data[10] & 7);
  if (data[11] >= palette_size) return -EBADMSG;
  size_t offset = 13 + palette_size * 3;
  if (offset > length) return -EBADMSG;
  *frames = 0;
  while (offset < length) {
    const uint8_t block = data[offset++];
    if (block == 0x3b) return *frames ? 0 : -EBADMSG;
    if (block == 0x21) {
      if (length - offset < 2) return -EBADMSG;
      const uint8_t label = data[offset++], size = data[offset];
      if (label == 0xf9) {
        if (size != 4 || length - offset < 6 || data[offset + 5] != 0 ||
            ((data[offset + 1] >> 2) & 7) > 3) return -EBADMSG;
      } else if (label == 0x01 && size != 12) return -EBADMSG;
      else if (label == 0xff) {
        if (size != 11 || length - offset < 12) return -EBADMSG;
        if (!memcmp(data + offset + 1, "NETSCAPE", 8) &&
            (length - offset < 17 || data[offset + 12] != 3 || data[offset + 13] != 1 ||
             data[offset + 16] != 0)) return -EBADMSG;
      }
      if (!skip_blocks(data, length, &offset)) return -EBADMSG;
    } else if (block == 0x2c) {
      if (length - offset < 9) return -EBADMSG;
      const unsigned x = le16(data + offset), y = le16(data + offset + 2);
      const unsigned w = le16(data + offset + 4), h = le16(data + offset + 6);
      if (!w || !h || x >= width || y >= height || w > width - x || h > height - y)
        return -EBADMSG;
      const uint8_t flags = data[offset + 8];
      offset += 9;
      const size_t palette_bytes = flags & 0x80 ? (size_t)(2u << (flags & 7)) * 3 : 0;
      if (palette_bytes >= length - offset) return -EBADMSG;
      offset += palette_bytes;
      const uint8_t code_size = data[offset++];
      if (code_size < 2 || code_size > 8 || !skip_blocks(data, length, &offset)) return -EBADMSG;
      if (++*frames > limits->max_frames) return -EFBIG;
    } else return -EBADMSG;
  }
  return -EBADMSG;
}

int px_gif_open(const uint8_t *data, size_t length,
                const struct px_image_limits *input_limits, struct px_gif **out)
{
  if (!out || *out) return -EINVAL;
  const struct px_image_limits limits = normalized(input_limits);
  int result = check_input(data, length, &limits);
  if (result) return result;
  if (px_image_sniff(data, length) != PX_IMAGE_GIF) return -ENOTSUP;
  unsigned frames;
  result = gif_structure(data, length, &limits, &frames);
  if (result) return result;
  struct px_gif *gif = calloc(1, sizeof(*gif));
  if (!gif) return -ENOMEM;
  gif->decoder = gd_open_gif_data(data, length);
  if (!gif->decoder) { free(gif); return -ENOMEM; }
  gif->frames = frames;
  *out = gif;
  return 0;
}

int px_gif_next(struct px_gif *gif, struct px_image *out)
{
  if (!gif || !empty_output(out)) return -EINVAL;
  if (gif->failed) return -EBADMSG;
  if (gif->decoded == gif->frames) return 0;
  gd_GIF *decoder = gif->decoder;
  if (gd_get_frame(decoder) != 1) { gif->failed = true; return -EBADMSG; }
  int result = allocate_image(decoder->width, decoder->height, out);
  if (result) { gif->failed = true; return result; }
  /* 直接从已合成背景转换RGB888，省去第三份整帧RGB临时缓冲。 */
  const size_t count = (size_t)out->width * out->height;
  for (size_t i = 0; i < count; ++i) out->pixels[i] = rgb(decoder->canvas + 3 * i);
  for (unsigned y = 0; y < decoder->fh; ++y)
    for (unsigned x = 0; x < decoder->fw; ++x) {
      const size_t offset = (size_t)(decoder->fy + y) * out->width + decoder->fx + x;
      const uint8_t index = decoder->frame[offset];
      if (!decoder->gce.transparency || index != decoder->gce.tindex)
        out->pixels[offset] = rgb(decoder->palette->colors + 3 * index);
    }
  out->duration_ms = decoder->gce.delay ? decoder->gce.delay * 10u : 100u;
  ++gif->decoded;
  return 1;
}

void px_gif_close(struct px_gif *gif)
{
  if (!gif) return;
  gd_close_gif(gif->decoder);
  free(gif);
}

int px_image_decode(const uint8_t *data, size_t length,
                     const struct px_image_limits *input_limits, struct px_image *out)
{
  if (!empty_output(out)) return -EINVAL;
  memset(out, 0, sizeof(*out));
  const struct px_image_limits limits = normalized(input_limits);
  int result = check_input(data, length, &limits);
  if (result) return result;
  switch (px_image_sniff(data, length)) {
    case PX_IMAGE_PNG: return decode_png(data, length, &limits, out);
    case PX_IMAGE_JPEG: return decode_jpeg(data, length, &limits, out);
    case PX_IMAGE_GIF: {
      struct px_gif *gif = NULL;
      result = px_gif_open(data, length, &limits, &gif);
      if (!result) { result = px_gif_next(gif, out); result = result == 1 ? 0 : result; }
      px_gif_close(gif);
      return result;
    }
    default: return -ENOTSUP;
  }
}
