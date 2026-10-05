/* PixelBox 位图文字：复用 pxfont 字表，直接绘制到 NuttX JS 的 RGB888 画布。 */
#include "pixelbox_text.h"
#include "hal_display/pxfont.h"
#include "pixelbox_fonts.h"

#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define PX_SMOOTH_DIM 128
#define PX_SMOOTH_PIXELS (PX_SMOOTH_DIM * PX_SMOOTH_DIM)

struct text_context {
  pxfont_t font;
  uint32_t color;
  int scale;
  enum px_text_align align;
  bool smooth;
};

struct text_surface {
  uint32_t *pixels;
  int width;
  int height;
  int stride;
  uint8_t *scratch;
  bool scratch_attempted;
};

static int resolve_style(const struct px_text_style *style,
                         struct text_context *context)
{
  const unsigned char *data = px_font_pixel8;
  size_t size = sizeof(px_font_pixel8);
  if (style && style->font) {
    if (!strcmp(style->font, "pixel12")) {
      data = px_font_pixel12;
      size = sizeof(px_font_pixel12);
    } else if (!strcmp(style->font, "pixel16")) {
      data = px_font_pixel16;
      size = sizeof(px_font_pixel16);
    }
  }
  if (!pxfont_load(data, size, &context->font)) return -EBADMSG;
  const int scale = style ? style->scale : 1;
  context->scale = scale < 1 ? 1 : (scale > 8 ? 8 : scale);
  context->color = style ? style->color & 0xffffffu : 0xffffffu;
  context->align = style ? style->align : PX_TEXT_LEFT;
  context->smooth = style && style->smooth;
  return 0;
}

/* 保持原 gfx::utf8_next 的逐字节替代语义；截断序列遇到 NUL 即停止探测。 */
static uint32_t next_codepoint(const char **cursor)
{
  const uint8_t *input = (const uint8_t *)*cursor;
  uint32_t codepoint;
  int length;
  if (!input[0]) return 0;
  if (input[0] < 0x80) { codepoint = input[0]; length = 1; }
  else if ((input[0] & 0xe0) == 0xc0) { codepoint = input[0] & 0x1f; length = 2; }
  else if ((input[0] & 0xf0) == 0xe0) { codepoint = input[0] & 0x0f; length = 3; }
  else if ((input[0] & 0xf8) == 0xf0) { codepoint = input[0] & 0x07; length = 4; }
  else { ++*cursor; return 0xfffd; }
  for (int i = 1; i < length; ++i) {
    if ((input[i] & 0xc0) != 0x80) { ++*cursor; return 0xfffd; }
    codepoint = (codepoint << 6) | (input[i] & 0x3f);
  }
  *cursor += length;
  return codepoint;
}

static int glyph_advance(const struct text_context *context, uint32_t codepoint,
                         const pxfont_glyph_t *glyph)
{
  if (glyph) return glyph->advance * context->scale;
  return (codepoint >= 0x2e80 ? context->font.height :
          (context->font.height + 1) / 2) * context->scale;
}

static int measure_line(const char **cursor, const struct text_context *context,
                        int *width)
{
  int result = 0;
  while (**cursor && **cursor != '\n') {
    const uint32_t cp = next_codepoint(cursor);
    const int advance = glyph_advance(context, cp, pxfont_find(&context->font, cp));
    if (result > INT_MAX - advance) return -EOVERFLOW;
    result += advance;
  }
  *width = result;
  return 0;
}

static int measure(const char *text, const struct text_context *context,
                   struct px_text_metrics *metrics)
{
  int width = 0, height = 0;
  const int line_height = context->font.height * context->scale;
  while (*text) {
    int line_width;
    int result = measure_line(&text, context, &line_width);
    if (result) return result;
    if (height > INT_MAX - line_height) return -EOVERFLOW;
    if (line_width > width) width = line_width;
    height += line_height;
    if (*text == '\n') ++text;
  }
  metrics->width = width;
  metrics->height = height;
  return 0;
}

int px_text_measure(const char *utf8, const struct px_text_style *style,
                    struct px_text_metrics *metrics)
{
  if (!utf8 || !metrics) return -EINVAL;
  struct text_context context;
  int result = resolve_style(style, &context);
  return result ? result : measure(utf8, &context, metrics);
}

/* 所有锚点运算使用 int64_t，极端 int32 坐标也先裁剪再转换为数组下标。 */
static void fill(struct text_surface *surface, int64_t x, int64_t y,
                 int width, int height, uint32_t color)
{
  if (width <= 0 || height <= 0) return;
  int64_t right = x + width, bottom = y + height;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (right > surface->width) right = surface->width;
  if (bottom > surface->height) bottom = surface->height;
  if (x >= right || y >= bottom) return;
  for (int64_t row = y; row < bottom; ++row) {
    uint32_t *pixels = surface->pixels + (size_t)row * surface->stride;
    for (int64_t column = x; column < right; ++column) pixels[(size_t)column] = color;
  }
}

static void outline(struct text_surface *surface, int64_t x, int64_t y,
                    int width, int height, uint32_t color)
{
  if (width <= 0 || height <= 0) return;
  fill(surface, x, y, width, 1, color);
  if (height > 1) fill(surface, x, y + height - 1, width, 1, color);
  if (height > 2) {
    fill(surface, x, y + 1, 1, height - 2, color);
    if (width > 1) fill(surface, x + width - 1, y + 1, 1, height - 2, color);
  }
}

/* 原固件 Scale2x/Scale3x 的二值蒙版规则；不产生插值灰色。 */
static void scale_mask(const uint8_t *input, int width, int height,
                       uint8_t *output, int factor)
{
  for (int y = 0; y < height; ++y) {
    const uint8_t *row = input + (size_t)y * width;
    const uint8_t *up = y ? row - width : NULL;
    const uint8_t *down = y + 1 < height ? row + width : NULL;
    for (int x = 0; x < width; ++x) {
      const uint8_t e = row[x];
      const uint8_t b = up ? up[x] : 0;
      const uint8_t h = down ? down[x] : 0;
      const uint8_t d = x ? row[x - 1] : 0;
      const uint8_t f = x + 1 < width ? row[x + 1] : 0;
      uint8_t cells[9];
      memset(cells, e, sizeof(cells));
      if (factor == 2) {
        if (d == b && d != h && b != f) cells[0] = b;
        if (b == f && b != d && f != h) cells[1] = f;
        if (h == d && h != f && d != b) cells[2] = d;
        if (f == h && f != b && h != d) cells[3] = h;
      } else {
        const uint8_t a = up && x ? up[x - 1] : 0;
        const uint8_t c = up && x + 1 < width ? up[x + 1] : 0;
        const uint8_t g = down && x ? down[x - 1] : 0;
        const uint8_t i = down && x + 1 < width ? down[x + 1] : 0;
        if (d == b && d != h && b != f) {
          cells[0] = d;
          if (e != c) cells[1] = b;
          if (e != g) cells[3] = d;
        }
        if (b == f && b != d && f != h) {
          cells[2] = f;
          if (e != a) cells[1] = b;
          if (e != i) cells[5] = f;
        }
        if (h == d && h != f && d != b) {
          cells[6] = d;
          if (e != i) cells[7] = h;
          if (e != a) cells[3] = d;
        }
        if (f == h && f != b && h != d) {
          cells[8] = f;
          if (e != c) cells[5] = f;
          if (e != g) cells[7] = h;
        }
      }
      for (int dy = 0; dy < factor; ++dy)
        memcpy(output + (size_t)(y * factor + dy) * width * factor + x * factor,
               cells + dy * factor, (size_t)factor);
    }
  }
}

static int smooth_passes(int scale, int passes[3])
{
  switch (scale) {
    case 2: passes[0] = 2; return 1;
    case 3: passes[0] = 3; return 1;
    case 4: passes[0] = 2; passes[1] = 2; return 2;
    case 6: passes[0] = 2; passes[1] = 3; return 2;
    case 8: passes[0] = 2; passes[1] = 2; passes[2] = 2; return 3;
    default: return 0;
  }
}

static bool smooth_glyph(struct text_surface *surface,
                         const struct text_context *context,
                         const pxfont_glyph_t *glyph, int64_t x, int64_t y)
{
  int passes[3];
  const int count = smooth_passes(context->scale, passes);
  int width = glyph->width, height = context->font.height;
  if (!count || !width || width * context->scale > PX_SMOOTH_DIM ||
      height * context->scale > PX_SMOOTH_DIM) return false;
  /* 按调用惰性分配到堆，避免小型任务栈溢出；同一段文字复用两块蒙版。 */
  if (!surface->scratch_attempted) {
    surface->scratch_attempted = true;
    surface->scratch = malloc(2 * PX_SMOOTH_PIXELS);
  }
  if (!surface->scratch) return false;
  uint8_t *current = surface->scratch;
  uint8_t *next = current + PX_SMOOTH_PIXELS;
  const uint8_t *bitmap = pxfont_bitmap(&context->font, glyph);
  const int row_bytes = (width + 7) / 8;
  for (int gy = 0; gy < height; ++gy)
    for (int gx = 0; gx < width; ++gx)
      current[gy * width + gx] = (bitmap[gy * row_bytes + gx / 8] >> (7 - gx % 8)) & 1;
  for (int pass = 0; pass < count; ++pass) {
    scale_mask(current, width, height, next, passes[pass]);
    width *= passes[pass];
    height *= passes[pass];
    uint8_t *swap = current;
    current = next;
    next = swap;
  }
  for (int gy = 0; gy < height; ++gy) {
    const uint8_t *row = current + gy * width;
    for (int gx = 0; gx < width;) {
      if (!row[gx]) { ++gx; continue; }
      int end = gx + 1;
      while (end < width && row[end]) ++end;
      fill(surface, x + gx, y + gy, end - gx, 1, context->color);
      gx = end;
    }
  }
  return true;
}

static int draw_glyph(struct text_surface *surface,
                      const struct text_context *context,
                      uint32_t codepoint, int64_t x, int64_t y)
{
  const pxfont_glyph_t *glyph = pxfont_find(&context->font, codepoint);
  const int advance = glyph_advance(context, codepoint, glyph);
  const int scale = context->scale;
  const int height = context->font.height * scale;
  const int width = glyph ? glyph->width * scale : advance;
  if (x >= surface->width || x + width <= 0 || y >= surface->height || y + height <= 0)
    return advance;
  if (!glyph) {
    /* 缺字沿用原固件：按码点选择半角/全角步进，画一像素空心边框。 */
    outline(surface, x + scale, y + scale, advance - 2 * scale,
            height - 2 * scale, context->color);
    return advance;
  }
  if (context->smooth && smooth_glyph(surface, context, glyph, x, y)) return advance;
  const uint8_t *bitmap = pxfont_bitmap(&context->font, glyph);
  const int row_bytes = (glyph->width + 7) / 8;
  for (int gy = 0; gy < context->font.height; ++gy)
    for (int gx = 0; gx < glyph->width; ++gx)
      if ((bitmap[gy * row_bytes + gx / 8] >> (7 - gx % 8)) & 1)
        fill(surface, x + gx * scale, y + gy * scale, scale, scale, context->color);
  return advance;
}

int px_text_draw(uint32_t *pixels, size_t pixel_count,
                 int width, int height, int stride, const char *utf8,
                 int x, int y, const struct px_text_style *style)
{
  if (!pixels || !utf8 || width <= 0 || height <= 0 || stride < width) return -EINVAL;
  if ((size_t)width > SIZE_MAX / sizeof(*pixels)) return -EOVERFLOW;
  if ((size_t)(height - 1) > (SIZE_MAX / sizeof(*pixels) - (size_t)width) / (size_t)stride)
    return -EOVERFLOW;
  const size_t needed = (size_t)(height - 1) * stride + width;
  if (pixel_count < needed) return -EINVAL;
  struct text_context context;
  int result = resolve_style(style, &context);
  if (result) return result;
  struct px_text_metrics metrics;
  if ((result = measure(utf8, &context, &metrics))) return result;
  struct text_surface surface = {pixels, width, height, stride, NULL, false};
  const int line_height = context.font.height * context.scale;
  int64_t line_y = y;
  const char *cursor = utf8;
  while (*cursor) {
    const char *next = cursor;
    int line_width;
    /* 上面的整体测量已完成溢出检查；每行仍单独确定 center/right 锚点。 */
    (void)measure_line(&next, &context, &line_width);
    int64_t pen_x = x;
    if (context.align == PX_TEXT_CENTER) pen_x -= line_width / 2;
    else if (context.align == PX_TEXT_RIGHT) pen_x -= line_width;
    if (line_y >= surface.height || line_y + line_height <= 0) cursor = next;
    else while (*cursor && *cursor != '\n')
      pen_x += draw_glyph(&surface, &context, next_codepoint(&cursor), pen_x, line_y);
    if (*cursor == '\n') ++cursor;
    line_y += line_height;
  }
  free(surface.scratch);
  return 0;
}
