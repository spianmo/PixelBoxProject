#pragma once
#include "FreeRTOS.h"
#include <atomic>
#include <deque>
#include <mutex>
struct HostQueue { size_t capacity; std::deque<void *> jobs; std::mutex mutex; };
using QueueHandle_t = HostQueue *;
namespace host { inline std::atomic<int> blocking_sends{0}; }
inline QueueHandle_t xQueueCreate(size_t capacity, size_t) { return new HostQueue{capacity}; }
inline void vQueueDelete(QueueHandle_t queue) { delete queue; }
inline BaseType_t xQueueSend(QueueHandle_t queue, const void *item, TickType_t wait) {
    std::lock_guard<std::mutex> lock(queue->mutex);
    if (queue->jobs.size() >= queue->capacity) {
        if (wait) ++host::blocking_sends;
        return pdFALSE;
    }
    queue->jobs.push_back(*static_cast<void *const *>(item));
    return pdTRUE;
}
inline BaseType_t xQueueReceive(QueueHandle_t queue, void *item, TickType_t) {
    std::lock_guard<std::mutex> lock(queue->mutex);
    if (queue->jobs.empty()) return pdFALSE;
    *static_cast<void **>(item) = queue->jobs.front();
    queue->jobs.pop_front();
    return pdTRUE;
}
inline size_t uxQueueMessagesWaiting(QueueHandle_t queue) {
    std::lock_guard<std::mutex> lock(queue->mutex);
    return queue->jobs.size();
}
