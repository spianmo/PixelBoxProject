/**
 * i2c_bus.cpp — 外设共享 I2C 总线实现
 *
 * 总线由 boards 组件创建 (board_init), 本模块只负责:
 *   - 通过 hal_common/board.h 的 board_i2c_bus() 取句柄
 *   - 挂设备、读写寄存器时统一走 board_i2c_lock/unlock 互斥
 */
#include "hal_periph/i2c_bus.hpp"

#include "esp_log.h"
#include "hal_common/board.h"

static const char* TAG = "px.i2c";

namespace hal_periph {

i2c_master_bus_handle_t i2c_bus_get() {
    auto bus = reinterpret_cast<i2c_master_bus_handle_t>(board_i2c_bus());
    if (bus == nullptr) {
        ESP_LOGE(TAG, "board_i2c_bus() 为空 — board_init() 是否已执行?");
    }
    return bus;
}

i2c_master_dev_handle_t i2c_bus_add_device(uint8_t addr7, uint32_t speed_hz) {
    i2c_master_bus_handle_t bus = i2c_bus_get();
    if (bus == nullptr) return nullptr;

    i2c_device_config_t dev_cfg = {};
    dev_cfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dev_cfg.device_address = addr7;
    dev_cfg.scl_speed_hz = speed_hz;

    i2c_master_dev_handle_t dev = nullptr;
    if (board_i2c_lock(1000) != ESP_OK) return nullptr;
    esp_err_t err = i2c_master_bus_add_device(bus, &dev_cfg, &dev);
    board_i2c_unlock();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "add_device 0x%02X 失败: %s", addr7, esp_err_to_name(err));
        return nullptr;
    }
    return dev;
}

esp_err_t i2c_write_reg(i2c_master_dev_handle_t dev, uint8_t reg, const uint8_t* data, size_t len) {
    if (dev == nullptr) return ESP_ERR_INVALID_STATE;
    uint8_t buf[1 + 16];
    if (len > sizeof(buf) - 1) return ESP_ERR_INVALID_SIZE;
    buf[0] = reg;
    for (size_t i = 0; i < len; i++) buf[1 + i] = data[i];

    esp_err_t err = board_i2c_lock(200);
    if (err != ESP_OK) return err;
    err = i2c_master_transmit(dev, buf, 1 + len, 100 /*ms*/);
    board_i2c_unlock();
    return err;
}

esp_err_t i2c_read_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t* data, size_t len) {
    if (dev == nullptr) return ESP_ERR_INVALID_STATE;
    esp_err_t err = board_i2c_lock(200);
    if (err != ESP_OK) return err;
    err = i2c_master_transmit_receive(dev, &reg, 1, data, len, 100 /*ms*/);
    board_i2c_unlock();
    return err;
}

}  // namespace hal_periph
