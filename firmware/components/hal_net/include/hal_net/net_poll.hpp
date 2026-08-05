/**
 * hal_net/net_poll.hpp — 单一 socket poll 任务(select 循环)
 *
 * 统一管理所有 lwip fd(TCP 客户端/服务器/UDP):
 *   - add() 注册 fd 与回调;on_readable/on_writable/on_error 全部在 poll 任务
 *     上下文执行,上层负责把数据经 jsvm 事件循环投递到 JS 线程
 *   - set_want_write() 控制是否监听可写(用于发送缓冲排空)
 *   - post_task() 把闭包投递到 poll 线程执行 —— **所有 close(fd) 必须经此执行**,
 *     以避免「select 正在用 fd 时被其他线程关闭/复用」的竞态
 *
 * 线程安全:所有公开方法可从任意任务调用。
 */
#pragma once

#include <functional>
#include <memory>

#include "esp_err.h"

namespace hal_net {

struct PollHandler {
  std::function<void(int fd)> on_readable;
  std::function<void(int fd)> on_writable;
  std::function<void(int fd)> on_error;
};

class NetPoll {
 public:
  static NetPoll& instance();

  /** 幂等启动 poll 任务 */
  esp_err_t ensure_start();

  /** 注册 fd(fd 必须已是非阻塞);重复注册同一 fd 覆盖旧 handler */
  void add(int fd, PollHandler handler);

  /** 是否监听可写事件(默认 false) */
  void set_want_write(int fd, bool want);

  /** 注销 fd(不 close);之后不会再有该 fd 的回调被派发 */
  void remove(int fd);

  /** 把闭包投递到 poll 线程执行(下一轮 select 前);用于安全 close(fd) */
  void post_task(std::function<void()> fn);

  /** 唤醒 select(注册/注销后内部自动调用) */
  void wakeup();

  NetPoll(const NetPoll&) = delete;
  NetPoll& operator=(const NetPoll&) = delete;

 private:
  NetPoll() = default;
  static void task_entry(void* arg);
  void run();

  struct Impl;
  Impl* impl_ = nullptr;
};

}  // namespace hal_net
