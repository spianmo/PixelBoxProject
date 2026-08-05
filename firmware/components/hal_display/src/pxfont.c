/**
 * pxfont.c — pxfont 二进制字表零拷贝解析 (布局见 pxfont.h / fontgen.py)
 */
#include "hal_display/pxfont.h"

#include <string.h>

#define PXFONT_HEADER_SIZE 16u
#define PXFONT_GLYPH_SIZE 8u

static uint32_t rd_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool pxfont_load(const uint8_t *data, size_t size, pxfont_t *out)
{
    if (!data || !out || size < PXFONT_HEADER_SIZE) return false;
    if (memcmp(data, "PXFN", 4) != 0) return false;
    if (data[4] != 1) return false; /* version */

    const uint32_t count = rd_u32(data + 8);
    const uint32_t pool_size = rd_u32(data + 12);
    const size_t need = PXFONT_HEADER_SIZE + (size_t)count * PXFONT_GLYPH_SIZE + pool_size;
    if (size < need) return false;
    /* glyph 记录含 u32, 要求整体 4 字节对齐 (EMBED_FILES/静态数组均满足) */
    if (((uintptr_t)data & 3u) != 0) return false;

    out->height = data[5];
    out->baseline = data[6];
    out->count = count;
    out->glyphs = (const pxfont_glyph_t *)(const void *)(data + PXFONT_HEADER_SIZE);
    out->pool = data + PXFONT_HEADER_SIZE + (size_t)count * PXFONT_GLYPH_SIZE;
    return true;
}

const pxfont_glyph_t *pxfont_find(const pxfont_t *font, uint32_t cp)
{
    if (!font || cp > 0xFFFFu || font->count == 0) return NULL;
    uint32_t lo = 0, hi = font->count;
    while (lo < hi) {
        const uint32_t mid = lo + (hi - lo) / 2;
        const uint16_t c = font->glyphs[mid].cp;
        if (c == cp) return &font->glyphs[mid];
        if (c < cp) lo = mid + 1;
        else hi = mid;
    }
    return NULL;
}
