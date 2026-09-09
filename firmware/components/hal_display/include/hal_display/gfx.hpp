/**
 * gfx.hpp — LVGL RGB565 即时绘图适配层。
 * JS 颜色仍为 0xRRGGBB，画布保存 LVGL 原生 RGB565；面板行带在发送前交换字节。
 * 像素字体、整数几何与最近邻采样保持现有规则，可在宿主机验证。
 */
#pragma once

#include <cstdint>
#include <cstddef>

#include "hal_display/pxfont.h"

namespace gfx {

/* ------------------------------------------------------------
 * 颜色转换
 * ------------------------------------------------------------ */

/** 0xRRGGBB → 帧缓冲 565 值 */
constexpr uint16_t to565(uint32_t rgb888)
{
    const uint16_t c = static_cast<uint16_t>(((rgb888 >> 8) & 0xF800) |
                                             ((rgb888 >> 5) & 0x07E0) |
                                             ((rgb888 >> 3) & 0x001F));
    return c;
}

/** 帧缓冲 565 值 → 0xRRGGBB (低位按 565 量化损失) */
constexpr uint32_t to888(uint16_t c565)
{
    const uint16_t c = c565;
    uint32_t r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
    // 位复制展宽, 保证 0/满量程精确还原
    r = (r << 3) | (r >> 2);
    g = (g << 2) | (g >> 4);
    b = (b << 3) | (b >> 2);
    return (r << 16) | (g << 8) | b;
}

/* ------------------------------------------------------------
 * 表面
 * ------------------------------------------------------------ */

/**
 * 绘图表面: 行优先 RGB565 缓冲。不持有内存 (创建/释放见
 * create_surface/destroy_surface, 固件侧缓冲位于 PSRAM)。
 */
struct Surface {
    uint16_t *px = nullptr;  //!< 像素缓冲
    int w = 0;               //!< 宽 (像素)
    int h = 0;               //!< 高 (像素)
    int stride = 0;          //!< 行距 (像素单位, 通常 == w)

    inline uint16_t *row(int y) { return px + static_cast<size_t>(y) * stride; }
    inline const uint16_t *row(int y) const { return px + static_cast<size_t>(y) * stride; }
    inline bool contains(int x, int y) const { return x >= 0 && y >= 0 && x < w && y < h; }
};

/**
 * 分配表面 (固件: PSRAM heap_caps_malloc; 宿主: malloc)。
 * 像素初始化为 0 (黑)。失败返回 false。
 */
bool create_surface(Surface *out, int w, int h);
void destroy_surface(Surface *s);

/* ------------------------------------------------------------
 * 基础绘图 (坐标全部自动裁剪到表面范围)
 * ------------------------------------------------------------ */

void clear(Surface &s, uint16_t c565);

/** 采集物理矩形到紧凑行带; 坐标已由 HAL 裁剪, rotation 为 0/90/180/270。 */
void gather_rotated_rect(const Surface &source, uint16_t *destination, int rotation,
                         int x, int y, int width, int height);
void set_pixel(Surface &s, int x, int y, uint16_t c565);
/** 越界返回 0 */
uint16_t get_pixel(const Surface &s, int x, int y);
/** Bresenham 直线 (含两端点) */
void draw_line(Surface &s, int x0, int y0, int x1, int y1, uint16_t c565);
void draw_rect(Surface &s, int x, int y, int w, int h, uint16_t c565);
/** 行填充优化: 首行逐像素铺满后按行 memcpy */
void fill_rect(Surface &s, int x, int y, int w, int h, uint16_t c565);
/** 中点画圆 */
void draw_circle(Surface &s, int cx, int cy, int r, uint16_t c565);
/** 逐扫描线水平段填充 */
void fill_circle(Surface &s, int cx, int cy, int r, uint16_t c565);

/* ------------------------------------------------------------
 * 位块传送 (drawImage 核心)
 * ------------------------------------------------------------ */

struct BlitOpts {
    // 源矩形 (默认全图); 会先裁剪到源表面范围
    int sx = 0, sy = 0, sw = -1, sh = -1;
    // 目标宽高 (最近邻缩放); -1 = 与源矩形一致
    int dw = -1, dh = -1;
    // 透明色键 (帧缓冲 565 空间); -1 = 无
    int32_t color_key = -1;
    // 可选 1bpp 透明掩码 (与源表面同尺寸, 行字节 = ceil(src.w/8), 置位 = 不透明)
    const uint8_t *alpha = nullptr;
};

/** 最近邻缩放 + 源裁剪 + colorKey/alpha 掩码; 无缩放无键时走按行 memcpy 快路径 */
void blit(Surface &dst, const Surface &src, int dx, int dy, const BlitOpts &opts);

/* ------------------------------------------------------------
 * 文本 (pxfont 位图字体, UTF-8)
 * ------------------------------------------------------------ */

enum class Align : uint8_t { Left = 0, Center = 1, Right = 2 };

struct TextStyle {
    const pxfont_t *font = nullptr;  //!< 必填
    uint16_t c565 = 0xFFFF;          //!< 前景色 (565)
    int scale = 1;                   //!< 整数放大 1-8
    Align align = Align::Left;       //!< 对齐 (center/right 以 x 为锚点)
    /** 放大平滑 (Scale2x/3x 阶梯圆滑, 仅 2/3/4/6/8 倍生效; 5/7 倍退化块状)。
     * 默认关: EPX 对大号拉丁/简单形状效果好, 但会吃掉密集 CJK 小字的
     * 笔画转角像素 (真机实测"溶解"), 中文文本请保持关闭 */
    bool smooth = false;
};

/**
 * 绘制 UTF-8 文本; 支持 '\n' 换行 (行高 = font.height * scale)。
 * (x, y) 为首行左上角锚点 (align 影响水平锚定)。
 * 未收录字形绘制空心"豆腐块"。
 */
void draw_text(Surface &s, const char *utf8, int x, int y, const TextStyle &st);

/** 文本渲染尺寸 (多行取最宽行; 高 = 行数 * 行高) */
void measure_text(const char *utf8, const TextStyle &st, int *out_w, int *out_h);

/** 解码一个 UTF-8 码点并前移指针; 非法序列按单字节 U+FFFD 处理 */
uint32_t utf8_next(const char **p);

}  // namespace gfx
