/**
 * button_input.hpp — 板载 BOOT 按键(基于组件注册表 espressif/button v4)
 *
 * 事件在 iot_button 内部任务/定时器上下文回调, 使用方负责投递到 JS 线程。
 */
#pragma once

#include <cstdint>
#include <functional>

#include "esp_err.h"

namespace hal_periph {

enum class ButtonEventType : uint8_t { Down, Up, Click, DoubleClick, LongPress };

/** 初始化 BOOT 按键(幂等) */
esp_err_t button_init();

/** 设置事件回调(任务上下文;传空函数清除) */
void button_set_callback(std::function<void(ButtonEventType)> cb);

}  // namespace hal_periph
