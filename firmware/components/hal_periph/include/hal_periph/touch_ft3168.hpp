/**
 * touch_ft3168.hpp — FT3168 电容触摸驱动(I2C, FocalTech FT6x36 兼容寄存器)
 *
 * 事件在内部轮询任务上下文回调, 使用方(bindings)负责投递到 JS 线程。
 * INT 引脚可用时作为"有触摸活动"的低功耗门控, 无 INT 则纯轮询。
 */
#pragma once

#include <cstdint>
#include <functional>

#include "esp_err.h"

namespace hal_periph {

enum class TouchEventType : uint8_t { Down, Move, Up };

struct TouchEvent {
    TouchEventType type;
    uint16_t x;
    uint16_t y;
};

/** 初始化触摸(幂等):挂 I2C 设备 + 启动轮询任务。失败返回错误码 */
esp_err_t touch_init();

/** 触摸是否可用(init 成功且芯片应答) */
bool touch_available();

/** 设置事件回调(任务上下文;传空函数清除) */
void touch_set_callback(std::function<void(const TouchEvent&)> cb);

}  // namespace hal_periph
