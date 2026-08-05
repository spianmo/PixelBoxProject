/**
 * gps_hal.hpp — GPS UART NMEA 驱动(定制板可选, Kconfig PX_ENABLE_GPS)
 *
 * 回调在 GPS 读取任务上下文, 使用方负责投递到 JS 线程。
 */
#pragma once

#include <cstdint>
#include <functional>

#include "esp_err.h"
#include "hal_periph/nmea_parser.hpp"

namespace hal_periph {

enum class GpsStatus : uint8_t { Searching, Fixed, Lost };

/** 编译期是否启用 GPS */
bool gps_available();

/**
 * 启动 GPS:安装 UART 驱动 + 读取解析任务。
 * @param interval_ms  onFix 最小回调间隔(节流)
 * @param on_fix       有效定位回调
 * @param on_status    状态变化回调(searching/fixed/lost), 可为空
 */
esp_err_t gps_start(uint32_t interval_ms,
                    std::function<void(const NmeaFix&)> on_fix,
                    std::function<void(GpsStatus)> on_status);

/** 停止 GPS(卸载 UART 驱动, 保留 last fix) */
void gps_stop();

/** 最近一次有效定位;无则返回 false */
bool gps_last(NmeaFix& out);

}  // namespace hal_periph
