/**
 * hal_display/hal_display.hpp — AMOLED 显示 HAL (SH8601 QSPI, 368x448 RGB565)
 *
 * 架构 (architecture.md §3/§4):
 *   - 面板: esp_lcd + 组件注册表 espressif/esp_lcd_sh8601 (QSPI 接口);
 *   - 引脚/时钟等全部来自 boards 组件 (hal_common/board.h 的
 *     board_display_config()), 本组件不硬编码任何引脚;
 *   - 逻辑帧缓冲位于 PSRAM (368*448*2 ≈ 322KB), 绘图引擎 (gfx) 直接
 *     操作它; flush 时按合并后的脏矩形分块推送 (QSPI 80MHz, 全帧约 8ms);
 *   - 旋转采用软件坐标变换: 逻辑帧缓冲按旋转后尺寸布局, flush 时把脏
 *     区变换回面板物理方向写入 PSRAM 中转缓冲再 draw_bitmap;
 *   - 亮度走 SH8601 亮度命令 0x51 (QSPI 需 0x02 前导操作码, 组件 io 已
 *     配置 32bit cmd, 见实现); 电源开关 = sleep in/out + display on/off。
 *
 * 线程约定: 本 HAL 的全部接口默认由单一线程 (JS 线程) 调用;
 * flush 内部等待 DMA 完成后才返回, 保证帧缓冲可立即复用。
 */
#pragma once

#include "esp_err.h"

#include "hal_display/gfx.hpp"

namespace hal_display {

/** 初始化面板 + 帧缓冲 (整屏置脏, 首次 flush 推全帧) */
esp_err_t init();

/** 是否已初始化 */
bool ready();

/**
 * 逻辑帧缓冲表面 (尺寸随旋转变化: 0/180 → 368x448, 90/270 → 448x368)。
 * 绘图后需调用 mark_dirty 声明改动区域, flush 才会推送。
 */
gfx::Surface &framebuffer();

/** 逻辑宽高 (旋转后) */
int width();
int height();

/** 声明逻辑坐标系中的脏矩形 (自动裁剪/合并, 槽满时并入最近矩形) */
void mark_dirty(int x, int y, int w, int h);

/** 推送脏区到面板并等待完成; 无脏区时直接返回 ESP_OK */
esp_err_t flush();

/** 亮度 0-100 (SH8601 命令 0x51, 线性映射到 0-255) */
esp_err_t set_brightness(int percent);
int get_brightness();

/** 屏幕电源 (AMOLED 熄屏省电: sleep in/out + display on/off) */
esp_err_t set_power(bool on);
bool get_power();

/**
 * 旋转 (软件坐标变换)。改变逻辑尺寸并清空帧缓冲 (整屏置脏)。
 * 仅接受 0/90/180/270。
 */
esp_err_t set_rotation(int deg);
int get_rotation();

}  // namespace hal_display
