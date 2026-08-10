/**
 * axp2101_stub.c — 无 PMU 板型的 AXP2101 接口桩 (BOARD_GENERIC_SPI / BOARD_HEADLESS)
 *
 * 存在理由: `main/system_keys.cpp` 的键2 轮询任务直接调 `axp2101_available()` /
 * `axp2101_poll_pkey()` (PWR 键事件在 2.16 板上只能从 PMU 的 PKEY IRQ 状态寄存器读,
 * 见 axp2101.h)。这两个符号原本只在编入 axp2101.c 的 S3 板型下存在, 于是
 * BOARD_HEADLESS (P4 默认) 链接期缺符号。
 *
 * 沿用组件既有的多目标做法 (CMake 源文件级切换 + 桩实现): 板上无 PMU 时编本文件,
 * `available()` 恒 false —— 调用方据此跳过, 无需按板型 #if 枚举。
 */
#include "boards/axp2101.h"

esp_err_t axp2101_init(board_i2c_bus_handle_t bus, uint8_t addr)
{
    (void)bus;
    (void)addr;
    return ESP_ERR_NOT_SUPPORTED;
}

bool axp2101_available(void) { return false; }

esp_err_t axp2101_read_battery(board_battery_info_t *out)
{
    if (!out) {
        return ESP_ERR_INVALID_ARG;
    }
    // 与真实实现的"未初始化"约定一致 (axp2101.c: level=-1 + INVALID_STATE)
    out->level = -1;
    out->charging = false;
    out->voltage_mv = 0;
    return ESP_ERR_INVALID_STATE;
}

esp_err_t axp2101_poll_pkey(bool *short_press, bool *long_press)
{
    if (short_press) *short_press = false;
    if (long_press) *long_press = false;
    return ESP_ERR_INVALID_STATE;
}
