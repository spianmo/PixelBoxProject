/**
 * touch_cst9220.cpp — CST9220 电容触摸驱动实现 (Hynitron CST92xx 协议)
 *
 * 实现 touch_ft3168.hpp 声明的统一触摸接口 (板型 Kconfig 二选一编译)。
 * 协议对齐微雪官方 esp_lcd_touch_cst9217 驱动 (Waveshare-ESP32-components):
 *   - 16 位寄存器寻址; 触摸数据帧在 0xD000, 读 7 字节:
 *       [0] 点1状态 (低 4 位 == 0x06 表示按下)
 *       [1] 点1 X[11:4]   [2] 点1 Y[11:4]   [3] X[3:0]<<4 | Y[3:0]
 *       [5] 触点数 (bit6..0)   [6] 帧校验, 恒为 0xAB
 *   - 复位: RST 低 10ms → 高, ≥50ms 后方可通信 (board_init 已做)
 *
 * 引脚/地址来自 boards (hal_common/board.h), 禁止硬编码。
 */
#include "hal_periph/touch_ft3168.hpp"

#include <atomic>
#include <mutex>

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal_common/board.h"
#include "sdkconfig.h"

#include "hal_periph/i2c_bus.hpp"

static const char* TAG = "px.touch";

namespace hal_periph {

namespace {

constexpr uint16_t kDataReg = 0xD000;
constexpr uint8_t kAckValue = 0xAB;

i2c_master_dev_handle_t s_dev = nullptr;
std::atomic<bool> s_available{false};
std::function<void(const TouchEvent&)> s_cb;
std::mutex s_cb_mtx;
TaskHandle_t s_task = nullptr;
int s_int_pin = -1;

/** 16 位寄存器读 (大端寄存器地址 + repeated-start) */
esp_err_t read_reg16(uint16_t reg, uint8_t* data, size_t len) {
    const uint8_t addr[2] = {static_cast<uint8_t>(reg >> 8), static_cast<uint8_t>(reg & 0xFF)};
    return i2c_master_transmit_receive(s_dev, addr, sizeof(addr), data, len, 100);
}

/** INT 高电平 = 空闲 (CST92xx 有触摸时拉低); 无 INT 引脚时永远轮询 */
bool int_gated_idle() {
    if (s_int_pin < 0) return false;
    return gpio_get_level(static_cast<gpio_num_t>(s_int_pin)) != 0;
}

void emit(const TouchEvent& ev) {
    std::function<void(const TouchEvent&)> cb;
    {
        std::lock_guard<std::mutex> lk(s_cb_mtx);
        cb = s_cb;
    }
    if (cb) cb(ev);
}

void touch_task(void*) {
    bool was_down = false;
    uint16_t last_x = 0, last_y = 0;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(CONFIG_PX_TOUCH_POLL_MS));

        // 空闲期且 INT 未触发 → 跳过 I2C 读, 省总线带宽
        if (!was_down && int_gated_idle()) continue;

        uint8_t buf[7] = {};
        if (read_reg16(kDataReg, buf, sizeof(buf)) != ESP_OK) continue;
        if (buf[6] != kAckValue) continue;  // 帧无效 (芯片未就绪), 丢弃

        const uint8_t points = buf[5] & 0x7F;
        const bool pressed = (buf[0] & 0x0F) == 0x06;
        const bool now_down = points > 0 && pressed;

        if (now_down) {
            const uint16_t x = static_cast<uint16_t>((buf[1] << 4) | (buf[3] >> 4));
            const uint16_t y = static_cast<uint16_t>((buf[2] << 4) | (buf[3] & 0x0F));
            if (!was_down) {
                emit({TouchEventType::Down, x, y});
            } else if (x != last_x || y != last_y) {
                emit({TouchEventType::Move, x, y});
            }
            last_x = x;
            last_y = y;
        } else if (was_down) {
            emit({TouchEventType::Up, last_x, last_y});
        }
        was_down = now_down;
    }
}

}  // namespace

esp_err_t touch_init() {
    if (s_task != nullptr) return s_available.load() ? ESP_OK : ESP_FAIL;
    if (!board_caps()->touch) return ESP_ERR_NOT_SUPPORTED;

    const board_touch_config_t* cfg = board_touch_config();
    s_int_pin = cfg->pin_int;

    s_dev = i2c_bus_add_device(cfg->i2c_addr, 400000);
    if (s_dev == nullptr) return ESP_FAIL;

    // 探测: 读一帧触摸数据, I2C 应答即认为在位 (帧校验仅对有效帧断言)
    uint8_t probe[7] = {};
    if (read_reg16(kDataReg, probe, sizeof(probe)) != ESP_OK) {
        ESP_LOGW(TAG, "CST9220 无应答 (addr=0x%02X)", cfg->i2c_addr);
        return ESP_ERR_NOT_FOUND;
    }
    ESP_LOGI(TAG, "CST9220 在位 (ack=0x%02X)", probe[6]);

    if (s_int_pin >= 0) {
        gpio_config_t io = {};
        io.pin_bit_mask = 1ULL << s_int_pin;
        io.mode = GPIO_MODE_INPUT;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        gpio_config(&io);
    }

    // 轮询任务: core0, 低优先级即可 (10ms 周期)
    if (xTaskCreatePinnedToCore(touch_task, "px_touch", 3072, nullptr, 5, &s_task, 0) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    s_available.store(true);
    return ESP_OK;
}

bool touch_available() { return s_available.load(); }

void touch_set_callback(std::function<void(const TouchEvent&)> cb) {
    std::lock_guard<std::mutex> lk(s_cb_mtx);
    s_cb = std::move(cb);
}

}  // namespace hal_periph
