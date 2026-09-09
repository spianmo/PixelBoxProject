/**
 * hal_display.hpp — LVGL RGB565 绘图与 AMOLED/SPI 面板提交。
 * 帧缓冲在 PSRAM（无 PSRAM 时使用内部堆），两个内部 DMA 行带交替打包和发送。
 * 绘图、浮层与刷新都由单一 JS 线程调用；成功 flush 返回前最后一笔 DMA 已完成。
 * 超时返回错误并保留脏区及在途缓冲，后续刷新先等待回收，再安全重试。
 * init 在启动线程中先于 JS 任务执行，不与绘图并发。
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
 * 逻辑帧缓冲表面（原生 RGB565；尺寸来自板型配置，90/270 度时交换宽高）。
 * 绘图后需调用 mark_dirty 声明改动区域, flush 才会推送。
 */
gfx::Surface &framebuffer();

/** 逻辑宽高 (旋转后) */
int width();
int height();

/** 声明逻辑坐标系中的脏矩形 (自动裁剪/合并, 槽满时并入最近矩形) */
void mark_dirty(int x, int y, int w, int h);

/** 推送脏区到面板并等待完成；每笔 DMA 等待上限 250ms，失败保留脏区 */
esp_err_t flush();

/**
 * 帧缓冲覆盖层 (系统级浮层: 错误卡片/横幅等)。
 *
 * flush() 内部时序: pre() → 推送脏区 → post()。pre 把浮层"盖"进帧缓冲并自行
 * mark_dirty (故 pre 在"无脏区直接返回"之前调用), post 负责把被覆盖的像素原样
 * 写回 —— 应用的帧缓冲内容因此永不被永久破坏, 取消浮层只需 mark_dirty + flush。
 *
 * 回调在 flush() 的调用线程 (js_task) 上同步执行, 不得阻塞/不得再调 flush。
 * 熄屏 (get_power() == false) 时整体跳过。
 */
struct Overlay {
    void (*pre)(gfx::Surface &fb, int w, int h) = nullptr;
    void (*post)(gfx::Surface &fb, int w, int h) = nullptr;
};

/** 设置/取消覆盖层 (nullptr = 取消); 指针须在取消前保持有效 */
void set_overlay(const Overlay *ov);

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
