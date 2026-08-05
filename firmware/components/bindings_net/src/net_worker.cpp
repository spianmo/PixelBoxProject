/**
 * net_worker.cpp — 工作线程池实现(FreeRTOS 任务 + 计数信号量队列)
 */
#include "net_worker.hpp"

#include <deque>
#include <mutex>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

namespace pxjs {

static const char* TAG = "px_networker";
static const int WORKER_COUNT = 2;
static const uint32_t WORKER_STACK = 12288;  // TLS 握手需要较大栈

namespace {
struct Pool {
  std::mutex mtx;
  std::deque<std::function<void()>> jobs;
  SemaphoreHandle_t sem = nullptr;
  bool started = false;
};
Pool& pool() {
  static Pool p;
  return p;
}

void worker_entry(void*) {
  Pool& p = pool();
  for (;;) {
    xSemaphoreTake(p.sem, portMAX_DELAY);
    std::function<void()> job;
    {
      std::lock_guard<std::mutex> lk(p.mtx);
      if (p.jobs.empty()) continue;
      job = std::move(p.jobs.front());
      p.jobs.pop_front();
    }
    job();
  }
}
}  // namespace

void worker_submit(std::function<void()> job) {
  Pool& p = pool();
  {
    std::lock_guard<std::mutex> lk(p.mtx);
    if (!p.started) {
      p.sem = xSemaphoreCreateCounting(0x7fffffff, 0);
      for (int i = 0; i < WORKER_COUNT; i++) {
        char name[16];
        snprintf(name, sizeof(name), "px_netwk%d", i);
        if (xTaskCreatePinnedToCore(worker_entry, name, WORKER_STACK, nullptr, 5, nullptr,
                                    0) != pdPASS) {
          ESP_LOGE(TAG, "worker 任务创建失败");
        }
      }
      p.started = true;
    }
    p.jobs.push_back(std::move(job));
  }
  xSemaphoreGive(p.sem);
}

}  // namespace pxjs
