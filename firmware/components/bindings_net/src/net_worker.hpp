/**
 * net_worker.hpp — 网络阻塞操作工作线程池
 *
 * fetch / TLS 握手 / mDNS 查询 / SNTP 等待等阻塞操作禁止占用 JS 线程,
 * 统一提交到这里(2 个 worker 任务,12KB 栈,惰性创建)。
 * 注意:池内任务无顺序保证,需要顺序的操作(如 WS 发送)不要提交到这里。
 */
#pragma once

#include <functional>

namespace pxjs {

/** 提交一个阻塞作业(线程安全,任意任务可调) */
void worker_submit(std::function<void()> job);

}  // namespace pxjs
