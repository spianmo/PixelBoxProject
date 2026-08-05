/**
 * devd/devd.h — PixelBox 开发服务
 *
 * 提供 (architecture.md §5):
 *   - WebSocket ws://<ip>:8765/devd, JSON 协议
 *     方法: hello / app.push_begin / app.push_chunk / app.push_end /
 *           app.restart / app.stop / js.eval / logs.subscribe / logs.unsubscribe
 *     事件: log { level, tag, msg, ts } / app.state { state, error? }
 *   - mDNS 广播 _pixelbox._tcp (TXT: model / fw / app)
 *   - 日志环形缓冲: console.* 与 ESP_LOG 均转发给订阅者
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 启动开发服务 (HTTP 服务器 + WS 端点 + mDNS + 日志钩子)。
 * 需在 esp_netif/esp_event 初始化与 appmgr_init 之后调用;
 * WiFi 未连接时服务照常监听, 联网后即可访问。
 */
esp_err_t devd_start(void);

#ifdef __cplusplus
}
#endif
