/**
 * tca9554.h — TCA9554 8 位 I2C IO 扩展器最小驱动
 *
 * 微雪 AMOLED-1.8 板上, 屏幕/触摸复位与部分按键/中断走 TCA9554 (地址 0x20)。
 * 寄存器: 0x00 输入 / 0x01 输出 / 0x02 极性 / 0x03 方向(1=输入)。
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "hal_common/board.h"

#ifdef __cplusplus
extern "C" {
#endif

#define TCA9554_I2C_ADDR_DEFAULT 0x20

/** 挂到共享总线上; 探测失败返回错误 (调用方自行决定是否容忍) */
esp_err_t tca9554_init(board_i2c_bus_handle_t bus, uint8_t addr);

/** 配置某个 EXIO (0-7) 方向; output=true 输出 */
esp_err_t tca9554_set_direction(uint8_t pin, bool output);

/** 输出电平 */
esp_err_t tca9554_write(uint8_t pin, bool level);

/** 读输入电平 */
esp_err_t tca9554_read(uint8_t pin, bool *level);

/** 是否已成功初始化 */
bool tca9554_available(void);

#ifdef __cplusplus
}
#endif
