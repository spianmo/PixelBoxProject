/**
 * image_decode.cpp — PNG/JPEG/GIF 统一解码到 RGB565 表面
 *
 * PNG:  vendored pngle (流式, 逐像素回调);
 * JPEG: espressif/esp_new_jpeg — 仅固件目标编译 (宿主单测无此组件);
 * GIF:  vendored gifdec (内存化改造版), 逐帧合成回调。
 */
#include "hal_display/image_decode.hpp"

#include <cstdlib>
#include <cstring>

#include "pngle.h"
#include "gifdec.h"

#if defined(ESP_PLATFORM) && __has_include("esp_jpeg_dec.h")
#include "esp_jpeg_dec.h"
#define PX_HAS_JPEG 1
#else
#define PX_HAS_JPEG 0
#endif

#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#include "hal_common/px_alloc.h"
#endif

namespace img {

/* 掩码分配: 与画布一致优先 PSRAM */
static uint8_t *alloc_bytes(size_t n)
{
#ifdef ESP_PLATFORM
    /* PSRAM 优先, 无 PSRAM 目标自动落内部堆 (hal_common/px_alloc.h) */
    return static_cast<uint8_t *>(px_alloc_prefer_psram(n));
#else
    return static_cast<uint8_t *>(malloc(n));
#endif
}

static void free_bytes(uint8_t *p)
{
#ifdef ESP_PLATFORM
    heap_caps_free(p);
#else
    free(p);
#endif
}

Format sniff(const uint8_t *data, size_t len)
{
    if (!data || len < 8) return Format::Unknown;
    static const uint8_t png_sig[8] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    if (memcmp(data, png_sig, 8) == 0) return Format::Png;
    if (data[0] == 0xFF && data[1] == 0xD8) return Format::Jpeg;
    if (memcmp(data, "GIF8", 4) == 0) return Format::Gif;
    return Format::Unknown;
}

/* ------------------------------------------------------------
 * PNG (pngle)
 * ------------------------------------------------------------ */

struct PngCtx {
    Decoded *out;
    bool failed;
};

static void png_on_init(pngle_t *p, uint32_t w, uint32_t h)
{
    PngCtx *c = static_cast<PngCtx *>(pngle_get_user_data(p));
    if (w == 0 || h == 0 || w > 4096 || h > 4096 ||
        !gfx::create_surface(&c->out->surf, static_cast<int>(w), static_cast<int>(h))) {
        c->failed = true;
    }
}

static void png_on_draw(pngle_t *p, uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                        const uint8_t rgba[4])
{
    PngCtx *c = static_cast<PngCtx *>(pngle_get_user_data(p));
    if (c->failed) return;
    gfx::Surface &s = c->out->surf;
    const uint16_t c565 = gfx::to565((static_cast<uint32_t>(rgba[0]) << 16) |
                                     (static_cast<uint32_t>(rgba[1]) << 8) | rgba[2]);
    const bool opaque = rgba[3] >= 128;
    if (!opaque && !c->out->alpha) {
        // 首次遇到透明像素时才建掩码 (默认全不透明)
        const size_t bytes = static_cast<size_t>((s.w + 7) / 8) * s.h;
        c->out->alpha = alloc_bytes(bytes);
        if (!c->out->alpha) { c->failed = true; return; }
        memset(c->out->alpha, 0xFF, bytes);
    }
    const int row_bytes = (s.w + 7) >> 3;
    for (uint32_t dy = 0; dy < h; ++dy) {
        for (uint32_t dx = 0; dx < w; ++dx) {
            const int px = static_cast<int>(x + dx), py = static_cast<int>(y + dy);
            if (!s.contains(px, py)) continue;
            if (opaque) {
                s.row(py)[px] = c565;
            } else if (c->out->alpha) {
                c->out->alpha[py * row_bytes + (px >> 3)] &=
                    static_cast<uint8_t>(~(1u << (7 - (px & 7))));
            }
        }
    }
}

static bool decode_png(const uint8_t *data, size_t len, Decoded *out)
{
    pngle_t *p = pngle_new();
    if (!p) return false;
    PngCtx ctx = {out, false};
    pngle_set_user_data(p, &ctx);
    pngle_set_init_callback(p, png_on_init);
    pngle_set_draw_callback(p, png_on_draw);

    size_t fed = 0;
    while (fed < len && !ctx.failed) {
        const int r = pngle_feed(p, data + fed, len - fed);
        if (r < 0) { ctx.failed = true; break; }
        if (r == 0) break;  // 需要更多数据 (数据已尽 → 截断)
        fed += static_cast<size_t>(r);
    }
    const bool ok = !ctx.failed && out->surf.px != nullptr;
    pngle_destroy(p);
    if (!ok) free_decoded(out);
    return ok;
}

/* ------------------------------------------------------------
 * JPEG (esp_new_jpeg, 仅固件目标)
 * ------------------------------------------------------------ */

#if PX_HAS_JPEG
static bool decode_jpeg(const uint8_t *data, size_t len, Decoded *out)
{
    jpeg_dec_config_t cfg = DEFAULT_JPEG_DEC_CONFIG();
#if PX_GFX_SWAP16
    cfg.output_type = JPEG_PIXEL_FORMAT_RGB565_BE;  // 帧缓冲即面板字节序
#else
    cfg.output_type = JPEG_PIXEL_FORMAT_RGB565_LE;
#endif
    jpeg_dec_handle_t dec = nullptr;
    if (jpeg_dec_open(&cfg, &dec) != JPEG_ERR_OK || !dec) return false;

    bool ok = false;
    jpeg_dec_io_t io = {};
    jpeg_dec_header_info_t info = {};
    io.inbuf = const_cast<uint8_t *>(data);
    io.inbuf_len = static_cast<int>(len);
    uint8_t *outbuf = nullptr;

    do {
        if (jpeg_dec_parse_header(dec, &io, &info) != JPEG_ERR_OK) break;
        if (info.width == 0 || info.height == 0) break;
        int outbuf_len = 0;
        if (jpeg_dec_get_outbuf_len(dec, &outbuf_len) != JPEG_ERR_OK || outbuf_len <= 0) break;
        // esp_new_jpeg 要求 16 字节对齐输出缓冲
        outbuf = static_cast<uint8_t *>(jpeg_calloc_align(static_cast<size_t>(outbuf_len), 16));
        if (!outbuf) break;
        io.outbuf = outbuf;
        io.out_size = outbuf_len;
        if (jpeg_dec_process(dec, &io) != JPEG_ERR_OK) break;
        if (!gfx::create_surface(&out->surf, info.width, info.height)) break;
        // 解码输出行宽即图像宽 (无对齐填充时) — 逐行拷贝以防万一
        memcpy(out->surf.px, outbuf,
               static_cast<size_t>(info.width) * info.height * sizeof(uint16_t));
        ok = true;
    } while (false);

    if (outbuf) jpeg_free_align(outbuf);
    jpeg_dec_close(dec);
    if (!ok) free_decoded(out);
    return ok;
}
#endif  // PX_HAS_JPEG

/* ------------------------------------------------------------
 * 公共入口
 * ------------------------------------------------------------ */

bool decode(const uint8_t *data, size_t len, Decoded *out)
{
    if (!data || !out) return false;
    out->surf = gfx::Surface{};
    out->alpha = nullptr;
    switch (sniff(data, len)) {
    case Format::Png:
        return decode_png(data, len, out);
    case Format::Jpeg:
#if PX_HAS_JPEG
        return decode_jpeg(data, len, out);
#else
        return false;  // 宿主环境无 JPEG 解码组件
#endif
    default:
        return false;
    }
}

void free_decoded(Decoded *d)
{
    if (!d) return;
    gfx::destroy_surface(&d->surf);
    if (d->alpha) {
        free_bytes(d->alpha);
        d->alpha = nullptr;
    }
}

/* ------------------------------------------------------------
 * GIF (gifdec)
 * ------------------------------------------------------------ */

int decode_gif(const uint8_t *data, size_t len, int max_frames,
               GifFrameSink sink, void *user)
{
    if (!data || !sink || max_frames <= 0) return -1;
    gd_GIF *gif = gd_open_gif_data(data, len);
    if (!gif) return -1;

    const int w = gif->width, h = gif->height;
    uint8_t *rgb = alloc_bytes(static_cast<size_t>(w) * h * 3);
    if (!rgb) { gd_close_gif(gif); return -1; }

    int frames = 0;
    while (frames < max_frames) {
        const int r = gd_get_frame(gif);
        if (r <= 0) break;  // 0 = 结束, -1 = 错误 (已解出的帧仍有效)
        gd_render_frame(gif, rgb);

        gfx::Surface frame;
        if (!gfx::create_surface(&frame, w, h)) break;
        // RGB888 → 帧缓冲 565
        const uint8_t *src = rgb;
        for (int y = 0; y < h; ++y) {
            uint16_t *dst = frame.row(y);
            for (int x = 0; x < w; ++x, src += 3) {
                dst[x] = gfx::to565((static_cast<uint32_t>(src[0]) << 16) |
                                    (static_cast<uint32_t>(src[1]) << 8) | src[2]);
            }
        }
        // gce.delay 单位 1/100 秒; 0 按常见浏览器约定视为 100ms
        int delay_ms = gif->gce.delay * 10;
        if (delay_ms <= 0) delay_ms = 100;
        ++frames;
        if (!sink(user, frame, delay_ms)) break;
    }

    free_bytes(rgb);
    gd_close_gif(gif);
    return frames;
}

}  // namespace img
