/**
 * net_poll.cpp — 单一 select 循环实现
 *
 * 唤醒机制:一个绑定到 127.0.0.1 环回的 UDP socket,注册/注销/post_task 时向
 * 自己 sendto 1 字节即可打断 select(lwip 默认开启 loopback)。
 */
#include "hal_net/net_poll.hpp"

#include <cstring>
#include <deque>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

namespace hal_net {

static const char* TAG = "px_netpoll";

struct FdEntry {
  std::shared_ptr<PollHandler> handler;
  bool want_write = false;
};

struct NetPoll::Impl {
  std::mutex mtx;
  std::unordered_map<int, FdEntry> fds;
  std::deque<std::function<void()>> tasks;
  int wake_fd = -1;
  struct sockaddr_in wake_addr = {};
  bool started = false;
};

NetPoll& NetPoll::instance() {
  static NetPoll inst;
  return inst;
}

esp_err_t NetPoll::ensure_start() {
  static std::mutex start_mtx;
  std::lock_guard<std::mutex> lk(start_mtx);
  if (impl_ && impl_->started) return ESP_OK;
  if (!impl_) impl_ = new Impl();

  // 环回唤醒 socket
  int fd = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (fd < 0) {
    ESP_LOGE(TAG, "唤醒 socket 创建失败: errno=%d", errno);
    return ESP_FAIL;
  }
  struct sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;  // 随机端口
  if (::bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    ::close(fd);
    return ESP_FAIL;
  }
  socklen_t alen = sizeof(impl_->wake_addr);
  getsockname(fd, (struct sockaddr*)&impl_->wake_addr, &alen);
  impl_->wake_fd = fd;

  BaseType_t ok = xTaskCreatePinnedToCore(&NetPoll::task_entry, "px_net_poll", 4096, this,
                                          5, nullptr, 0);
  if (ok != pdPASS) {
    ::close(fd);
    impl_->wake_fd = -1;
    return ESP_ERR_NO_MEM;
  }
  impl_->started = true;
  return ESP_OK;
}

void NetPoll::add(int fd, PollHandler handler) {
  ensure_start();
  {
    std::lock_guard<std::mutex> lk(impl_->mtx);
    FdEntry e;
    e.handler = std::make_shared<PollHandler>(std::move(handler));
    impl_->fds[fd] = std::move(e);
  }
  wakeup();
}

void NetPoll::set_want_write(int fd, bool want) {
  if (!impl_) return;
  {
    std::lock_guard<std::mutex> lk(impl_->mtx);
    auto it = impl_->fds.find(fd);
    if (it == impl_->fds.end()) return;
    it->second.want_write = want;
  }
  wakeup();
}

void NetPoll::remove(int fd) {
  if (!impl_) return;
  {
    std::lock_guard<std::mutex> lk(impl_->mtx);
    impl_->fds.erase(fd);
  }
  wakeup();
}

void NetPoll::post_task(std::function<void()> fn) {
  ensure_start();
  {
    std::lock_guard<std::mutex> lk(impl_->mtx);
    impl_->tasks.push_back(std::move(fn));
  }
  wakeup();
}

void NetPoll::wakeup() {
  if (!impl_ || impl_->wake_fd < 0) return;
  uint8_t b = 0;
  ::sendto(impl_->wake_fd, &b, 1, 0, (struct sockaddr*)&impl_->wake_addr,
           sizeof(impl_->wake_addr));
}

void NetPoll::task_entry(void* arg) {
  static_cast<NetPoll*>(arg)->run();
  vTaskDelete(nullptr);
}

void NetPoll::run() {
  Impl* im = impl_;
  for (;;) {
    // 先执行投递的任务(close fd 等)
    for (;;) {
      std::function<void()> fn;
      {
        std::lock_guard<std::mutex> lk(im->mtx);
        if (im->tasks.empty()) break;
        fn = std::move(im->tasks.front());
        im->tasks.pop_front();
      }
      fn();
    }

    fd_set rset, wset, eset;
    FD_ZERO(&rset);
    FD_ZERO(&wset);
    FD_ZERO(&eset);
    int maxfd = im->wake_fd;
    FD_SET(im->wake_fd, &rset);
    std::vector<std::pair<int, bool>> snapshot;  // fd, want_write
    {
      std::lock_guard<std::mutex> lk(im->mtx);
      snapshot.reserve(im->fds.size());
      for (auto& kv : im->fds) snapshot.emplace_back(kv.first, kv.second.want_write);
    }
    for (auto& [fd, ww] : snapshot) {
      FD_SET(fd, &rset);
      FD_SET(fd, &eset);
      if (ww) FD_SET(fd, &wset);
      if (fd > maxfd) maxfd = fd;
    }

    struct timeval tv = {.tv_sec = 1, .tv_usec = 0};  // 兜底超时,防止漏唤醒
    int n = ::select(maxfd + 1, &rset, &wset, &eset, &tv);
    if (n < 0) {
      if (errno == EINTR) continue;
      ESP_LOGW(TAG, "select 失败: errno=%d", errno);
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    if (n == 0) continue;

    if (FD_ISSET(im->wake_fd, &rset)) {
      uint8_t buf[8];
      while (::recv(im->wake_fd, buf, sizeof(buf), MSG_DONTWAIT) > 0) {
      }
    }

    for (auto& [fd, ww] : snapshot) {
      // 每次派发前确认 fd 仍注册(回调内可能 remove 了其他 fd 或自己)
      std::shared_ptr<PollHandler> h;
      {
        std::lock_guard<std::mutex> lk(im->mtx);
        auto it = im->fds.find(fd);
        if (it == im->fds.end()) continue;
        h = it->second.handler;
      }
      if (FD_ISSET(fd, &eset) && h->on_error) {
        h->on_error(fd);
        continue;
      }
      if (FD_ISSET(fd, &rset) && h->on_readable) h->on_readable(fd);
      if (ww && FD_ISSET(fd, &wset) && h->on_writable) {
        bool still = false;
        {
          std::lock_guard<std::mutex> lk(im->mtx);
          still = im->fds.count(fd) != 0;  // on_readable 里可能已注销
        }
        if (still) h->on_writable(fd);
      }
    }
  }
}

}  // namespace hal_net
