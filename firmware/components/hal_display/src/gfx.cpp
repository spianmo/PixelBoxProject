/**
 * gfx.cpp — PixelBox 软件绘图引擎实现
 *
 * 设计要点:
 *   - 全部函数先做矩形裁剪, 内层循环无边界判断、无虚调用;
 *   - fill_rect: 首行铺满后逐行 memcpy (行拷贝比逐像素快一个量级);
 *   - blit: 无缩放/无键/无掩码时按行 memcpy; 缩放用定点最近邻;
 *   - 大缓冲 (画布) 分配优先 PSRAM (MALLOC_CAP_SPIRAM), 宿主机退化为 malloc。
 */
#include "hal_display/gfx.hpp"

#include <cstring>
#include <cstdlib>

#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#endif

namespace gfx {

/* ------------------------------------------------------------
 * 表面分配
 * ------------------------------------------------------------ */

bool create_surface(Surface *out, int w, int h)
{
    if (!out || w <= 0 || h <= 0 || w > 4096 || h > 4096) return false;
    const size_t bytes = static_cast<size_t>(w) * h * sizeof(uint16_t);
    uint16_t *px = nullptr;
#ifdef ESP_PLATFORM
    // 画布优先 PSRAM; 无 PSRAM 时回退内部堆
    px = static_cast<uint16_t *>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!px) px = static_cast<uint16_t *>(heap_caps_malloc(bytes, MALLOC_CAP_8BIT));
#else
    px = static_cast<uint16_t *>(malloc(bytes));
#endif
    if (!px) return false;
    memset(px, 0, bytes);
    out->px = px;
    out->w = w;
    out->h = h;
    out->stride = w;
    return true;
}

void destroy_surface(Surface *s)
{
    if (!s || !s->px) return;
#ifdef ESP_PLATFORM
    heap_caps_free(s->px);
#else
    free(s->px);
#endif
    s->px = nullptr;
    s->w = s->h = s->stride = 0;
}

/* ------------------------------------------------------------
 * 基础绘图
 * ------------------------------------------------------------ */

static inline void fill_row(uint16_t *dst, int n, uint16_t c)
{
    for (int i = 0; i < n; ++i) dst[i] = c;
}

void clear(Surface &s, uint16_t c565)
{
    if (!s.px) return;
    if (s.stride == s.w) {
        // 连续缓冲: 铺首行后成倍 memcpy (log 次拷贝)
        const size_t total = static_cast<size_t>(s.w) * s.h;
        if (total == 0) return;
        fill_row(s.px, s.w, c565);
        size_t filled = static_cast<size_t>(s.w);
        while (filled < total) {
            const size_t n = (filled <= total - filled) ? filled : total - filled;
            memcpy(s.px + filled, s.px, n * sizeof(uint16_t));
            filled += n;
        }
    } else {
        for (int y = 0; y < s.h; ++y) fill_row(s.row(y), s.w, c565);
    }
}

void set_pixel(Surface &s, int x, int y, uint16_t c565)
{
    if (!s.px || !s.contains(x, y)) return;
    s.row(y)[x] = c565;
}

uint16_t get_pixel(const Surface &s, int x, int y)
{
    if (!s.px || !s.contains(x, y)) return 0;
    return s.row(y)[x];
}

void draw_line(Surface &s, int x0, int y0, int x1, int y1, uint16_t c565)
{
    if (!s.px) return;
    // Bresenham; 逐点裁剪 (线段通常不长, 保持简单正确)
    int dx = x1 - x0, dy = y1 - y0;
    const int sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
    dx = dx >= 0 ? dx : -dx;
    dy = dy >= 0 ? dy : -dy;
    if (dy == 0) {  // 水平快路径
        if (y0 < 0 || y0 >= s.h) return;
        int a = x0 < x1 ? x0 : x1, b = x0 < x1 ? x1 : x0;
        if (a < 0) a = 0;
        if (b >= s.w) b = s.w - 1;
        if (a > b) return;
        fill_row(s.row(y0) + a, b - a + 1, c565);
        return;
    }
    if (dx == 0) {  // 垂直快路径
        if (x0 < 0 || x0 >= s.w) return;
        int a = y0 < y1 ? y0 : y1, b = y0 < y1 ? y1 : y0;
        if (a < 0) a = 0;
        if (b >= s.h) b = s.h - 1;
        for (int y = a; y <= b; ++y) s.row(y)[x0] = c565;
        return;
    }
    int err = dx - dy;
    int x = x0, y = y0;
    while (true) {
        if (static_cast<unsigned>(x) < static_cast<unsigned>(s.w) &&
            static_cast<unsigned>(y) < static_cast<unsigned>(s.h)) {
            s.row(y)[x] = c565;
        }
        if (x == x1 && y == y1) break;
        const int e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 < dx) { err += dx; y += sy; }
    }
}

void draw_rect(Surface &s, int x, int y, int w, int h, uint16_t c565)
{
    if (!s.px || w <= 0 || h <= 0) return;
    draw_line(s, x, y, x + w - 1, y, c565);
    if (h > 1) draw_line(s, x, y + h - 1, x + w - 1, y + h - 1, c565);
    if (h > 2) {
        draw_line(s, x, y + 1, x, y + h - 2, c565);
        if (w > 1) draw_line(s, x + w - 1, y + 1, x + w - 1, y + h - 2, c565);
    }
}

void fill_rect(Surface &s, int x, int y, int w, int h, uint16_t c565)
{
    if (!s.px || w <= 0 || h <= 0) return;
    int x0 = x, y0 = y, x1 = x + w, y1 = y + h;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > s.w) x1 = s.w;
    if (y1 > s.h) y1 = s.h;
    if (x0 >= x1 || y0 >= y1) return;
    const int n = x1 - x0;
    uint16_t *first = s.row(y0) + x0;
    fill_row(first, n, c565);  // 首行铺满
    const size_t row_bytes = static_cast<size_t>(n) * sizeof(uint16_t);
    for (int yy = y0 + 1; yy < y1; ++yy) {
        memcpy(s.row(yy) + x0, first, row_bytes);  // 后续行整行拷贝
    }
}

void draw_circle(Surface &s, int cx, int cy, int r, uint16_t c565)
{
    if (!s.px || r < 0) return;
    if (r == 0) { set_pixel(s, cx, cy, c565); return; }
    // 中点画圆 (八分对称)
    int x = 0, y = r, d = 1 - r;
    while (x <= y) {
        set_pixel(s, cx + x, cy + y, c565);
        set_pixel(s, cx - x, cy + y, c565);
        set_pixel(s, cx + x, cy - y, c565);
        set_pixel(s, cx - x, cy - y, c565);
        set_pixel(s, cx + y, cy + x, c565);
        set_pixel(s, cx - y, cy + x, c565);
        set_pixel(s, cx + y, cy - x, c565);
        set_pixel(s, cx - y, cy - x, c565);
        if (d < 0) {
            d += 2 * x + 3;
        } else {
            d += 2 * (x - y) + 5;
            --y;
        }
        ++x;
    }
}

static void hspan(Surface &s, int x0, int x1, int y, uint16_t c565)
{
    if (y < 0 || y >= s.h) return;
    if (x0 < 0) x0 = 0;
    if (x1 >= s.w) x1 = s.w - 1;
    if (x0 > x1) return;
    fill_row(s.row(y) + x0, x1 - x0 + 1, c565);
}

void fill_circle(Surface &s, int cx, int cy, int r, uint16_t c565)
{
    if (!s.px || r < 0) return;
    if (r == 0) { set_pixel(s, cx, cy, c565); return; }
    // 每条扫描线一个水平段 (避免中点法重复覆盖)
    for (int dy = -r; dy <= r; ++dy) {
        // dx = floor(sqrt(r^2 - dy^2)) 用整数递推亦可; 半径小, 直接乘法比较
        int dx = 0;
        while ((dx + 1) * (dx + 1) + dy * dy <= r * r) ++dx;
        hspan(s, cx - dx, cx + dx, cy + dy, c565);
    }
}

/* ------------------------------------------------------------
 * blit
 * ------------------------------------------------------------ */

static inline bool alpha_test(const uint8_t *alpha, int src_w, int x, int y)
{
    const int row_bytes = (src_w + 7) >> 3;
    return (alpha[y * row_bytes + (x >> 3)] >> (7 - (x & 7))) & 1;
}

void blit(Surface &dst, const Surface &src, int dx, int dy, const BlitOpts &opts)
{
    if (!dst.px || !src.px) return;

    // 1) 源矩形裁剪到源表面
    int sx = opts.sx, sy = opts.sy;
    int sw = opts.sw < 0 ? src.w : opts.sw;
    int sh = opts.sh < 0 ? src.h : opts.sh;
    if (sx < 0) { sw += sx; sx = 0; }
    if (sy < 0) { sh += sy; sy = 0; }
    if (sx + sw > src.w) sw = src.w - sx;
    if (sy + sh > src.h) sh = src.h - sy;
    if (sw <= 0 || sh <= 0) return;

    // 2) 目标尺寸 (最近邻缩放)
    const int dw = opts.dw < 0 ? sw : opts.dw;
    const int dh = opts.dh < 0 ? sh : opts.dh;
    if (dw <= 0 || dh <= 0) return;

    // 3) 目标矩形裁剪
    int cx0 = dx < 0 ? -dx : 0;                        // 目标矩形内起始列
    int cy0 = dy < 0 ? -dy : 0;
    int cx1 = (dx + dw > dst.w) ? dst.w - dx : dw;     // 目标矩形内结束列 (开区间)
    int cy1 = (dy + dh > dst.h) ? dst.h - dy : dh;
    if (cx0 >= cx1 || cy0 >= cy1) return;

    const bool plain = (dw == sw && dh == sh && opts.color_key < 0 && !opts.alpha);
    if (plain) {
        // 快路径: 尺寸一致、无键无掩码 → 按行 memcpy
        const size_t row_bytes = static_cast<size_t>(cx1 - cx0) * sizeof(uint16_t);
        for (int y = cy0; y < cy1; ++y) {
            memcpy(dst.row(dy + y) + dx + cx0, src.row(sy + y) + sx + cx0, row_bytes);
        }
        return;
    }

    // 通用路径: 16.16 定点最近邻 + colorKey/alpha
    const uint32_t x_step = (static_cast<uint32_t>(sw) << 16) / static_cast<uint32_t>(dw);
    const uint32_t y_step = (static_cast<uint32_t>(sh) << 16) / static_cast<uint32_t>(dh);
    const uint16_t key = static_cast<uint16_t>(opts.color_key & 0xFFFF);
    const bool has_key = opts.color_key >= 0;

    for (int y = cy0; y < cy1; ++y) {
        const int syy = sy + static_cast<int>((static_cast<uint32_t>(y) * y_step) >> 16);
        const uint16_t *srow = src.row(syy);
        uint16_t *drow = dst.row(dy + y) + dx;
        uint32_t fx = static_cast<uint32_t>(cx0) * x_step;
        if (opts.alpha) {
            for (int x = cx0; x < cx1; ++x, fx += x_step) {
                const int sxx = sx + static_cast<int>(fx >> 16);
                const uint16_t c = srow[sxx];
                if (!alpha_test(opts.alpha, src.w, sxx, syy)) continue;
                if (has_key && c == key) continue;
                drow[x] = c;
            }
        } else if (has_key) {
            for (int x = cx0; x < cx1; ++x, fx += x_step) {
                const uint16_t c = srow[sx + static_cast<int>(fx >> 16)];
                if (c != key) drow[x] = c;
            }
        } else {
            for (int x = cx0; x < cx1; ++x, fx += x_step) {
                drow[x] = srow[sx + static_cast<int>(fx >> 16)];
            }
        }
    }
}

/* ------------------------------------------------------------
 * 文本
 * ------------------------------------------------------------ */

uint32_t utf8_next(const char **p)
{
    const uint8_t *s = reinterpret_cast<const uint8_t *>(*p);
    const uint8_t b0 = s[0];
    if (b0 == 0) return 0;
    uint32_t cp;
    int len;
    if (b0 < 0x80) { cp = b0; len = 1; }
    else if ((b0 & 0xE0) == 0xC0) { cp = b0 & 0x1F; len = 2; }
    else if ((b0 & 0xF0) == 0xE0) { cp = b0 & 0x0F; len = 3; }
    else if ((b0 & 0xF8) == 0xF0) { cp = b0 & 0x07; len = 4; }
    else { *p += 1; return 0xFFFD; }
    for (int i = 1; i < len; ++i) {
        if ((s[i] & 0xC0) != 0x80) { *p += 1; return 0xFFFD; }
        cp = (cp << 6) | (s[i] & 0x3F);
    }
    *p += len;
    return cp;
}

/** 单字形渲染 (含整数放大); 返回步进宽 (已放大) */
static int draw_glyph(Surface &s, const pxfont_t &font, uint32_t cp,
                      int x, int y, uint16_t c565, int scale)
{
    const pxfont_glyph_t *g = pxfont_find(&font, cp);
    if (!g) {
        // 未收录: 空心豆腐块 (宽 = 半高或全高, 依 CJK 判断)
        const int wid = (cp >= 0x2E80 ? font.height : (font.height + 1) / 2) * scale;
        draw_rect(s, x + scale, y + scale, wid - 2 * scale, font.height * scale - 2 * scale, c565);
        return wid;
    }
    const uint8_t *bm = pxfont_bitmap(&font, g);
    const int row_bytes = (g->width + 7) >> 3;
    for (int gy = 0; gy < font.height; ++gy) {
        const uint8_t *brow = bm + gy * row_bytes;
        for (int gx = 0; gx < g->width; ++gx) {
            if (!((brow[gx >> 3] >> (7 - (gx & 7))) & 1)) continue;
            if (scale == 1) {
                set_pixel(s, x + gx, y + gy, c565);
            } else {
                fill_rect(s, x + gx * scale, y + gy * scale, scale, scale, c565);
            }
        }
    }
    return g->advance * scale;
}

/** 测量单行 (直到 '\n' 或结尾); 返回行宽, *p 停在 '\n' 或 '\0' */
static int measure_line(const char **p, const pxfont_t &font, int scale)
{
    int w = 0;
    while (**p && **p != '\n') {
        const uint32_t cp = utf8_next(p);
        const pxfont_glyph_t *g = pxfont_find(&font, cp);
        if (g) {
            w += g->advance * scale;
        } else {
            w += (cp >= 0x2E80 ? font.height : (font.height + 1) / 2) * scale;
        }
    }
    return w;
}

void draw_text(Surface &s, const char *utf8, int x, int y, const TextStyle &st)
{
    if (!s.px || !utf8 || !st.font) return;
    const int scale = st.scale < 1 ? 1 : (st.scale > 8 ? 8 : st.scale);
    const int line_h = st.font->height * scale;
    const char *p = utf8;
    int line_y = y;
    while (*p) {
        // 先测行宽定水平锚点
        const char *probe = p;
        const int line_w = measure_line(&probe, *st.font, scale);
        int pen_x = x;
        if (st.align == Align::Center) pen_x = x - line_w / 2;
        else if (st.align == Align::Right) pen_x = x - line_w;

        // 整行在表面外时跳过渲染 (仍推进解析)
        const bool off = (line_y + line_h <= 0 || line_y >= s.h);
        while (*p && *p != '\n') {
            const uint32_t cp = utf8_next(&p);
            if (off) {
                const pxfont_glyph_t *g = pxfont_find(st.font, cp);
                pen_x += g ? g->advance * scale
                           : (cp >= 0x2E80 ? st.font->height : (st.font->height + 1) / 2) * scale;
            } else {
                pen_x += draw_glyph(s, *st.font, cp, pen_x, line_y, st.c565, scale);
            }
        }
        if (*p == '\n') ++p;
        line_y += line_h;
    }
}

void measure_text(const char *utf8, const TextStyle &st, int *out_w, int *out_h)
{
    int w = 0, lines = 0;
    if (utf8 && st.font && *utf8) {
        const int scale = st.scale < 1 ? 1 : (st.scale > 8 ? 8 : st.scale);
        const char *p = utf8;
        while (true) {
            const int lw = measure_line(&p, *st.font, scale);
            if (lw > w) w = lw;
            ++lines;
            // 尾部 '\n' 不计为额外空行 (与 draw_text 行为一致)
            if (*p == '\n') { ++p; if (*p) continue; }
            break;
        }
        if (out_h) *out_h = lines * st.font->height * scale;
        if (out_w) *out_w = w;
        return;
    }
    if (out_w) *out_w = 0;
    if (out_h) *out_h = 0;
}

}  // namespace gfx
