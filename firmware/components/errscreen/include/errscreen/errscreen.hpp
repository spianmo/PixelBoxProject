/**
 * errscreen/errscreen.hpp — 应用异常的屏幕提示 (真机侧编排)
 *
 * 目的: 推送到设备上的应用出错时, 用户在设备前就能看到, 不必回电脑翻日志。
 *
 * 两种形态 (绘制见 error_card.hpp):
 *   - report_error(): 应用还活着 (回调/定时器/微任务/Promise 未捕获异常) →
 *     顶部红色横幅, 5 秒后自动消失; 同一条错误 3 秒内累计 5 次 (典型: onFrame
 *     每帧抛) 判定为"刷屏", 自动升级为下面的致命形态并停掉应用;
 *   - show_fatal(): 应用已经跑不下去 (入口异常 / VM 创建失败 / 热更新切换失败) →
 *     全屏卡片, 常驻到下一次应用启动 (hide())。
 *
 * 线程: 三个接口都可从任意线程调用, 内部经 jsvm::post() 回到 js_task 绘制
 * (帧缓冲与 QSPI IO 归 js_task 所有)。无屏板型 (hal_display::ready() 为假)
 * 全部退化为 no-op。
 */
#pragma once

namespace errscreen {

/**
 * 全屏错误卡片 (致命): 应用已停止运行。
 * app/version 可为 nullptr; message 首行作摘要, 其余按堆栈逐行显示。
 */
void show_fatal(const char *app, const char *version, const char *message);

/**
 * 顶部横幅 (非致命): 应用仍在运行。
 * 同一 message 在 3 秒窗口内累计 5 次会自动升级为 show_fatal + 停应用。
 */
void report_error(const char *app, const char *version, const char *message);

/** 撤下当前提示 (应用重新跑起来时调用) */
void hide();

/** 当前是否有提示在屏上 */
bool active();

}  // namespace errscreen
