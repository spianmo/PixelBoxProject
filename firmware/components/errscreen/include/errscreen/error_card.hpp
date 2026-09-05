/**
 * errscreen/error_card.hpp — 应用异常卡片的纯绘制层 (RGB565)
 *
 * 只依赖 gfx + pxfont, 不碰 esp_lcd / FreeRTOS / 日志 —— 因此可在宿主机
 * 编译出图人工核对 (test_host/build_run.sh), 与真机像素一致。
 *
 * 两种形态 (errscreen.hpp 决定何时用哪个):
 *   - 全屏卡片 render_fatal_card(): 应用已停, 整屏接管, 常驻到 VM 重启;
 *   - 顶部横幅 render_banner():     应用还在跑, 只占顶部 banner_height() 行。
 *
 * 文本策略: 摘要 (message 首行) 按宽度折行, 堆栈逐行截断 (不折行) ——
 * 一帧一行对应一个调用栈层级, 折行会把栈读成一团。
 */
#pragma once

#include "hal_display/gfx.hpp"
#include "hal_display/pxfont.h"

namespace errscreen {

/** 绘制所需字体 (固件走 pxfonts_get, 宿主机从 fonts 目录的 pxf 文件加载) */
struct Fonts {
    const pxfont_t *f12 = nullptr;  //!< 正文/堆栈 (12px, 含 GB2312 一级汉字)
    const pxfont_t *f16 = nullptr;  //!< 标题/摘要 (16px)
};

struct CardInfo {
    const char *app = nullptr;      //!< 应用名 (空 → "未知应用")
    const char *version = nullptr;  //!< 版本号 (可空)
    const char *message = nullptr;  //!< 完整错误文本: 首行摘要 + 其余堆栈
    const char *hint = nullptr;     //!< 底部提示 (空 → 默认按键提示)
    int repeat = 1;                 //!< 同一错误累计次数 (>1 时显示 "×N")
};

/** 顶部横幅高度 (逻辑像素); w/h 为逻辑屏幕尺寸 */
int banner_height(int w, int h);

/** 全屏卡片: 覆盖 [0,0,w,h] */
void render_fatal_card(gfx::Surface &fb, int w, int h, const Fonts &fonts, const CardInfo &info);

/** 顶部横幅: 只覆盖 [0,0,w,banner_height(w,h)] */
void render_banner(gfx::Surface &fb, int w, int h, const Fonts &fonts, const CardInfo &info);

}  // namespace errscreen
