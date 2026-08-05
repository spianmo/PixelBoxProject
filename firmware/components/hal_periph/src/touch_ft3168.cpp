/**
 * touch_ft3168.cpp — FT3168 触摸驱动实现
 *
 * 寄存器(FocalTech FT6x36/FT3168 系列通用):
 *   0x02 TD_STATUS   低 4 位 = 当前触点数
 *   0x03 P1_XH       [3:0]=X[11:8], [7:6]=事件标志
 *   0x04 P1_XL       X[7:0]
 *   0x05 P1_YH       [3:0]=Y[11:8]
 *   0x06 P1_YL       Y[7:0]
 *   0xA8 CHIP_VENDOR
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

i2c_master_dev_handle_t s_dev = nullptr;
std::atomic<bool> s_available{false};
std::function<void(const TouchEvent&)> s_cb;
std::mutex s_cb_mtx;
TaskHandle_t s_task = nullptr;
int s_int_pin = -1;

/** INT 高电平 = 空闲(FT 系列有触摸时拉低);无 INT 引脚时永远轮询 */
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

        uint8_t buf[5] = {};
        if (i2c_read_reg(s_dev, 0x02, buf, sizeof(buf)) != ESP_OK) continue;

        uint8_t touches = buf[0] & 0x0F;
        bool now_down = (touches > 0 && touches <= 2);

        if (now_down) {
            uint16_t x = static_cast<uint16_t>(((buf[1] & 0x0F) << 8) | buf[2]);
            uint16_t y = static_cast<uint16_t>(((buf[3] & 0x0F) << 8) | buf[4]);
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

    // 探测:读厂商寄存器判断芯片在位
    uint8_t vendor = 0;
    if (i2c_read_reg(s_dev, 0xA8, &vendor, 1) != ESP_OK) {
        ESP_LOGW(TAG, "FT3168 无应答 (addr=0x%02X)", cfg->i2c_addr);
        return ESP_ERR_NOT_FOUND;
    }
    ESP_LOGI(TAG, "FT3168 在位, vendor=0x%02X", vendor);

    if (s_int_pin >= 0) {
        gpio_config_t io = {};
        io.pin_bit_mask = 1ULL << s_int_pin;
        io.mode = GPIO_MODE_INPUT;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        gpio_config(&io);
    }

    // 轮询任务:core0, 低优先级即可(10ms 周期)
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
