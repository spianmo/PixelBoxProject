/**
 * net_worker.hpp — 网络阻塞操作工作线程池
 *
 * fetch / TLS 握手 / mDNS 查询 / SNTP 等待等阻塞操作禁止占用 JS 线程,
 * 统一提交到这里(2 个 worker 任务,12KB 栈,惰性创建;有 PSRAM 时栈放外部)。
 * 不得提交 Flash 写入操作;otaApply 使用独立的内部栈任务。
 * 注意:池内任务无顺序保证,需要顺序的操作(如 WS 发送)不要提交到这里。
 */
#pragma once

#include <functional>

namespace pxjs {

/** Submit work; false means no consumer or the request backlog is full. */
// Cleanup jobs must survive VM changes and are exempt from request backpressure.
bool worker_submit(std::function<void()> job, bool cleanup = false);

}  // namespace pxjs
