/**
 * hal_display/fonts.h — 内置像素字体访问
 *
 * 三款内置字体 (产物由 tools/fontgen 生成, 见 fonts/ 目录):
 *   - pixel8:  unscii-16 (Public Domain), 8x16 ASCII;
 *   - pixel12: 缤纷像素 fusion-pixel 12px 等宽 (OFL-1.1),
 *              ASCII(6x12) + GB2312 一级汉字 + 常用标点 (12x12);
 *   - pixel16: fusion-pixel 8px 等宽 2 倍放大 (16px), 字符集同 pixel12。
 *
 * 数据经 CMake EMBED_FILES 编入 flash, 零拷贝解析 (pxfont_load)。
 */
#pragma once

#include "hal_display/pxfont.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PXFONT_PIXEL8 = 0,
    PXFONT_PIXEL12 = 1,
    PXFONT_PIXEL16 = 2,
} pxfont_id_t;

/** 取内置字体 (首次调用惰性解析); 数据损坏返回 NULL */
const pxfont_t *pxfonts_get(pxfont_id_t id);

/** 按 d.ts 字体名取字体 ("pixel8"/"pixel12"/"pixel16"); 未知名返回 NULL */
const pxfont_t *pxfonts_by_name(const char *name);

#ifdef __cplusplus
}
#endif
