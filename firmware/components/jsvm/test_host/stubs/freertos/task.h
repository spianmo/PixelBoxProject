#pragma once
#include "FreeRTOS.h"
#include "esp_timer.h"
using TaskHandle_t = void *;
namespace host { inline thread_local int task_id; inline std::atomic<int> notifications{0}; }
inline TaskHandle_t xTaskGetCurrentTaskHandle() { return &host::task_id; }
inline TaskHandle_t xTaskCreateStaticPinnedToCore(void (*)(void *), const char *, uint32_t,
    void *, int, StackType_t *, StaticTask_t *, int) { return xTaskGetCurrentTaskHandle(); }
inline void xTaskNotifyGive(TaskHandle_t) { ++host::notifications; }
inline uint32_t ulTaskNotifyTake(BaseType_t, TickType_t) { return host::notifications.exchange(0); }
inline void vTaskDelay(TickType_t ticks) { host::now_us += ticks * 1000; }
