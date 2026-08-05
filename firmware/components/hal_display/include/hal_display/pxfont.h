/**
 * hal_display/pxfont.h — PixelBox 位图字体 (pxfont) 运行时视图
 *
 * 二进制字表由 tools/fontgen/fontgen.py 生成 (布局说明见该脚本头注释),
 * 本模块零拷贝解析: 直接在 flash 常量区上建立指针视图, 按码点二分查找。
 *
 * 布局 (小端):
 *   [0..3]   magic "PXFN"
 *   [4]      u8  version = 1
 *   [5]      u8  height
 *   [6]      u8  baseline
 *   [7]      u8  flags (保留)
 *   [8..11]  u32 glyph_count
 *   [12..15] u32 pool_size
 *   [16..]   glyph_count 个 pxfont_glyph_t (8B, 按 codepoint 升序)
 *   之后     位图池 (每字形 rows=height, row_bytes=ceil(width/8), MSB=最左)
 */
#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 字形记录 (与二进制布局逐字节对应, 8 字节) */
typedef struct {
    uint16_t cp;      /*!< UTF-16 BMP 码点 */
    uint8_t width;    /*!< 位图宽 (像素) */
    uint8_t advance;  /*!< 步进宽 (像素) */
    uint32_t offset;  /*!< 位图在池中的字节偏移 */
} pxfont_glyph_t;

/** 字体视图 (指向常量数据, 不持有内存) */
typedef struct {
    uint8_t height;                 /*!< 字形格高 */
    uint8_t baseline;               /*!< 顶部到基线的像素数 */
    uint32_t count;                 /*!< 字形数 */
    const pxfont_glyph_t *glyphs;   /*!< 字形记录数组 (码点升序) */
    const uint8_t *pool;            /*!< 位图池 */
} pxfont_t;

/**
 * 在 data 上建立字体视图 (校验 magic/version/长度)。
 * data 必须 4 字节对齐且生命周期覆盖 out 的使用期。
 */
bool pxfont_load(const uint8_t *data, size_t size, pxfont_t *out);

/** 按码点二分查找字形; 未收录返回 NULL */
const pxfont_glyph_t *pxfont_find(const pxfont_t *font, uint32_t cp);

/** 字形位图指针 (rows = font->height, row_bytes = ceil(width/8)) */
static inline const uint8_t *pxfont_bitmap(const pxfont_t *font, const pxfont_glyph_t *g)
{
    return font->pool + g->offset;
}

#ifdef __cplusplus
}
#endif
