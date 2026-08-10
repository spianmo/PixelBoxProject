/**
 * axp2101.h — AXP2101 PMU 最小 I2C 驱动 (寄存器级自写)
 *
 * 仅覆盖 PixelBox 需要的能力:
 *   - 初始化: 芯片识别、电池检测/电压 ADC/电量计使能
 *   - 电池状态: 电量百分比 / 充电状态 / 电压
 *
 * 寄存器参考 X-Powers AXP2101 datasheet (与 XPowersLib 对齐):
 *   0x00 PMU 状态1 (bit3 电池在位)      0x01 PMU 状态2 (bit[6:5] 充电状态)
 *   0x03 芯片 ID                        0x30 ADC 通道使能 (bit0 VBAT)
 *   0x34/0x35 VBAT ADC (高6位/低8位, mV) 0x68 电量计/电池检测控制
 *   0xA4 电池电量百分比
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "hal_common/board.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AXP2101_I2C_ADDR_DEFAULT 0x34

/** 挂到共享总线并做最小初始化; 探测失败返回错误 */
esp_err_t axp2101_init(board_i2c_bus_handle_t bus, uint8_t addr);

/** 是否已成功初始化 (无 PMU 的板子返回 false) */
bool axp2101_available(void);

/** 读取电池状态; 未初始化时 level=-1 且返回 ESP_ERR_INVALID_STATE */
esp_err_t axp2101_read_battery(board_battery_info_t *out);

/**
 * 轮询电源键 (PWR/PWRON) 事件并清除中断标志。
 * 2.16 板 SYS_OUT 感知线路不可用, PWR 键事件唯一可靠来源是 PMU 的
 * PKEY IRQ (INTSTS2/0x49: bit3 短按, bit2 长按; 读取后写 0xFF 清除)。
 * 调用方周期轮询 (100-300ms)。未初始化时返回 ESP_ERR_INVALID_STATE。
 */
esp_err_t axp2101_poll_pkey(bool *short_press, bool *long_press);

#ifdef __cplusplus
}
#endif
