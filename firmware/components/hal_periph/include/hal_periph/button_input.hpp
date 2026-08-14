/**
 * button_input.hpp — 板载按键(基于组件注册表 espressif/button v4)
 *
 * 多键: Boot(BOOT/GPIO0) / User(用户键, 2.16 板 KEY3) / Power(电源键状态感知)。
 * 事件在 iot_button 内部任务/定时器上下文回调, 使用方负责投递到 JS 线程。
 */
#pragma once

#include <cstdint>
#include <functional>

#include "esp_err.h"

namespace hal_periph {

enum class ButtonEventType : uint8_t { Down, Up, Click, DoubleClick, LongPress };

enum class ButtonKey : uint8_t { Boot, User, Power };

/** 初始化全部板载按键(幂等); 板型未配置的键自动跳过 */
esp_err_t button_init();

/** 追加事件回调(任务上下文; 多消费者: JS 绑定 + 系统按键动作), 不支持移除 */
void button_add_callback(std::function<void(ButtonKey, ButtonEventType)> cb);

/** 分发由 PMU 等非 GPIO 来源产生的按键事件。 */
void button_emit(ButtonKey key, ButtonEventType type);

}  // namespace hal_periph
