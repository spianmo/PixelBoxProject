#pragma once
#include <cstdint>
using TickType_t = uint32_t;
using BaseType_t = int;
using StackType_t = uint8_t;
struct StaticTask_t {};
constexpr BaseType_t pdTRUE = 1, pdFALSE = 0, pdPASS = 1;
constexpr TickType_t portMAX_DELAY = UINT32_MAX;
constexpr uint32_t configTICK_RATE_HZ = 1000;
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
