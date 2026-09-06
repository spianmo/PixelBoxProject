/**
 * net_worker.cpp — 工作线程池实现(FreeRTOS 任务 + 计数信号量队列)
 */
#include "net_worker.hpp"

#include <deque>
#include <mutex>

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "jsvm/jsvm.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"

namespace pxjs {

static const char* TAG = "px_networker";
static const int WORKER_COUNT = 2;
static const uint32_t WORKER_STACK = 12288;  // TLS 握手需要较大栈

namespace {
struct Pool {
  struct Job { std::function<void()> run; uint32_t generation; int64_t queued_us; bool cleanup; };
  std::mutex mtx;
  std::deque<Job> jobs;
  SemaphoreHandle_t sem = nullptr;
  int workers = 0;
};
Pool& pool() {
  static Pool p;
  return p;
}

void worker_entry(void*) {
  Pool& p = pool();
  for (;;) {
    xSemaphoreTake(p.sem, portMAX_DELAY);
    Pool::Job job;
    {
      std::lock_guard<std::mutex> lk(p.mtx);
      if (p.jobs.empty()) continue;
      job = std::move(p.jobs.front());
      p.jobs.pop_front();
    }
    if (!job.cleanup && job.generation != jsvm::vm_generation()) continue;
    const int64_t wait_ms = (esp_timer_get_time() - job.queued_us) / 1000;
    if (wait_ms >= 250) ESP_LOGW(TAG, "network queue wait: %lld ms", (long long)wait_ms);
    job.run();
  }
}
}  // namespace

bool worker_submit(std::function<void()> job, bool cleanup) {
  Pool& p = pool();
  {
    std::lock_guard<std::mutex> lk(p.mtx);
    if (!p.sem) p.sem = xSemaphoreCreateCounting(0x7fffffff, 0);
    if (!p.sem) { ESP_LOGE(TAG, "worker semaphore allocation failed"); return false; }
    if (p.workers < WORKER_COUNT) {
      for (int i = p.workers; i < WORKER_COUNT; i++) {
        const char* name = i == 0 ? "px_netwk0" : "px_netwk1";
#if CONFIG_SPIRAM && CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM
        constexpr uint32_t stack_caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
#else
        constexpr uint32_t stack_caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
#endif
        if (xTaskCreatePinnedToCoreWithCaps(worker_entry, name, WORKER_STACK, nullptr, 5, nullptr,
                                          0, stack_caps) != pdPASS) {
          ESP_LOGE(TAG, "worker 任务创建失败: internal largest=%u PSRAM largest=%u",
                   (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                   (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
          break;
        }
        p.workers++;
        ESP_LOGI(TAG, "%s ready; stack=%u caps=0x%x", name, (unsigned)WORKER_STACK, (unsigned)stack_caps);
      }
    }
    // No job may be queued without a consumer. Later submissions retry allocation.
    if (!p.workers) return false;
    if (!cleanup && p.jobs.size() >= 16) { ESP_LOGW(TAG, "network work queue full (16 pending)"); return false; }
    p.jobs.push_back({std::move(job), jsvm::vm_generation(), esp_timer_get_time(), cleanup});
  }
  xSemaphoreGive(p.sem);
  return true;
}

}  // namespace pxjs
