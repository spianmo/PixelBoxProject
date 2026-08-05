/**
 * i2c_bus.hpp — 外设共享 I2C 总线 (IDF 5.x 新 i2c_master 驱动)
 *
 * 板上 FT3168 / QMI8658 / AXP2101 / PCF85063 / ES8311 挂在同一条 I2C 总线。
 * 默认由 hal_periph 惰性创建一次总线;若集成后由 hal_common/boards 统一建总线,
 * 打开 Kconfig PX_PERIPH_I2C_EXTERNAL_BUS, 本模块转而调用弱符号
 * pxhal_shared_i2c_bus() 获取现成句柄(boards/hal_common 提供实现即可)。
 */
#pragma once

#include "driver/i2c_master.h"
#include "esp_err.h"

namespace hal_periph {

/** 获取共享 I2C 总线句柄(线程安全, 惰性初始化);失败返回 nullptr */
i2c_master_bus_handle_t i2c_bus_get();

/** 在共享总线上添加设备(7 位地址);失败返回 nullptr */
i2c_master_dev_handle_t i2c_bus_add_device(uint8_t addr7, uint32_t speed_hz);

/** 写寄存器(reg 单字节地址) */
esp_err_t i2c_write_reg(i2c_master_dev_handle_t dev, uint8_t reg, const uint8_t* data, size_t len);

/** 读寄存器(reg 单字节地址, 自动 repeated-start) */
esp_err_t i2c_read_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t* data, size_t len);

/** 写单字节寄存器 */
inline esp_err_t i2c_write_reg8(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t val) {
    return i2c_write_reg(dev, reg, &val, 1);
}

}  // namespace hal_periph
