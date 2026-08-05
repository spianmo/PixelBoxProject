/**
 * led_hal.hpp — WS2812 灯带封装(espressif/led_strip RMT 后端, Kconfig PX_ENABLE_LED)
 *
 * 逻辑颜色缓冲保存原始 0xRRGGBB, show() 时按亮度缩放后提交,
 * 因此调亮度不会丢失原始颜色精度。
 */
#pragma once

#include <cstdint>

#include "esp_err.h"

namespace hal_periph {

/** 编译期是否启用灯带 */
bool led_available();

/** 灯珠数(未启用返回 0) */
int led_count();

/** 亮度 0-100(默认 100) */
void led_set_brightness(int percent);
int led_get_brightness();

/** 设置单颗逻辑颜色(不立即生效, 需 show) */
esp_err_t led_set(int index, uint32_t rgb);

/** 全部填充 */
esp_err_t led_fill(uint32_t rgb);

/** 全部清零(黑) */
esp_err_t led_clear();

/** 按亮度缩放提交到灯带 */
esp_err_t led_show();

}  // namespace hal_periph
