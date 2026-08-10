/**
 * wifi_portal/wifi_portal.hpp — 网页配网模式 (SoftAP + HTTP 表单页)
 *
 * 交互形态: 设备开自己的热点 → 手机连上 → 浏览器填表 → 设备连目标 WiFi。
 * 屏幕全程显示热点名称、密码、访问地址与连接状态 (手机只负责输入),
 * 因此配网期间必须独占屏幕: start() 会先 appmgr_stop_app() 停掉 JS VM。
 *
 * 为什么原生实现而非内置 JS 页: JS 应用每帧 clear+flush 会盖掉热点密码;
 * 而 js_task 是无限循环, VM 停止后仍在泵 post 队列 (jsvm.cpp 的 js_task_main),
 * 所以原生代码依然能经 jsvm::post 在 JS 线程上安全画帧 —— 帧缓冲与 QSPI IO
 * 归 JS 线程所有 (同 system_keys.cpp 的关机流程)。这样也不新增 JS API,
 * 免去 sdk/types/pixelbox.d.ts 契约与 simulator 的同步。
 *
 * 触发手势见 firmware/main/system_keys.cpp (键1 + 键3 同时按住 2s)。
 *
 * 线程安全: 三个接口均可从任意任务调用 (重活在内部 px_portal 任务里做,
 * 与调用方栈大小无关)。
 */
#pragma once

#include "esp_err.h"

namespace wifi_portal {

/**
 * 进入网页配网 (幂等: 已在配网中返回 ESP_OK 不做事)。
 * 立即返回, 实际流程在 px_portal 任务中推进。
 * 无片上 WiFi 的目标返回 ESP_ERR_NOT_SUPPORTED。
 */
esp_err_t start();

/**
 * 退出配网 (幂等, 异步生效)。
 * 收尾顺序: 停 httpd → 摘 WiFi 监听 → 关 AP → 未配网成功则恢复原凭据连接
 *           → restart_app 时热重启 JS VM 回到应用页。
 */
void stop(bool restart_app);

/** 当前是否在配网模式 (system_keys 用来改按键语义) */
bool active();

}  // namespace wifi_portal
