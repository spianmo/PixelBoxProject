/**
 * gps_hal.cpp — GPS UART NMEA 驱动实现
 */
#include "hal_periph/gps_hal.hpp"

#include <atomic>
#include <mutex>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal_common/board.h"
#include "sdkconfig.h"

#if CONFIG_PX_ENABLE_GPS
#include "driver/uart.h"
#endif

static const char* TAG = "px.gps";

namespace hal_periph {

#if CONFIG_PX_ENABLE_GPS

namespace {

constexpr int64_t LOST_TIMEOUT_US = 5 * 1000 * 1000;  // 5s 无有效语句 → lost

TaskHandle_t s_task = nullptr;
std::atomic<bool> s_running{false};
std::atomic<bool> s_stop_req{false};

std::mutex s_mtx;
std::function<void(const NmeaFix&)> s_on_fix;
std::function<void(GpsStatus)> s_on_status;
uint32_t s_interval_ms = 1000;

NmeaFix s_last_fix;      // 仅任务写, 读取加锁
bool s_has_last = false;
std::mutex s_fix_mtx;

GpsStatus s_status = GpsStatus::Searching;

void set_status(GpsStatus st) {
    if (st == s_status) return;
    s_status = st;
    std::function<void(GpsStatus)> cb;
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        cb = s_on_status;
    }
    if (cb) cb(st);
}

void gps_task(void*) {
    NmeaParser parser;
    int64_t last_valid_us = 0;
    int64_t last_emit_us = 0;
    bool ever_fixed = false;

    parser.on_sentence = [&](bool has_fix) {
        if (has_fix) last_valid_us = esp_timer_get_time();
    };
    parser.on_fix = [&](const NmeaFix& fix) {
        ever_fixed = true;
        {
            std::lock_guard<std::mutex> lk(s_fix_mtx);
            s_last_fix = fix;
            s_has_last = true;
        }
        set_status(GpsStatus::Fixed);
        int64_t now = esp_timer_get_time();
        uint32_t interval;
        std::function<void(const NmeaFix&)> cb;
        {
            std::lock_guard<std::mutex> lk(s_mtx);
            interval = s_interval_ms;
            cb = s_on_fix;
        }
        if (cb && now - last_emit_us >= static_cast<int64_t>(interval) * 1000) {
            last_emit_us = now;
            cb(fix);
        }
    };

    uint8_t buf[256];
    while (!s_stop_req.load()) {
        int n = uart_read_bytes(static_cast<uart_port_t>(CONFIG_PX_GPS_UART_NUM), buf,
                                sizeof(buf), pdMS_TO_TICKS(200));
        if (n > 0) {
            parser.feed(reinterpret_cast<const char*>(buf), static_cast<size_t>(n));
        }
        // 失锁判定
        if (s_status == GpsStatus::Fixed &&
            esp_timer_get_time() - last_valid_us > LOST_TIMEOUT_US) {
            set_status(GpsStatus::Lost);
        } else if (s_status == GpsStatus::Lost && !ever_fixed) {
            set_status(GpsStatus::Searching);
        }
    }

    uart_driver_delete(static_cast<uart_port_t>(CONFIG_PX_GPS_UART_NUM));
    s_running.store(false);
    s_task = nullptr;
    vTaskDelete(nullptr);
}

}  // namespace

// 运行期可用性 = 编译开关 AND 板级能力位
bool gps_available() { return board_caps()->gps; }

esp_err_t gps_start(uint32_t interval_ms,
                    std::function<void(const NmeaFix&)> on_fix,
                    std::function<void(GpsStatus)> on_status) {
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_interval_ms = interval_ms == 0 ? 1000 : interval_ms;
        s_on_fix = std::move(on_fix);
        s_on_status = std::move(on_status);
    }
    // stop() 后立刻 start():等旧任务退出(≤500ms)再重新安装驱动
    if (s_running.load() && s_stop_req.load()) {
        for (int i = 0; i < 50 && s_running.load(); i++) {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
    if (s_running.load()) return ESP_OK;  // 已运行, 仅更新回调/间隔

    const auto port = static_cast<uart_port_t>(CONFIG_PX_GPS_UART_NUM);
    uart_config_t cfg = {};
    cfg.baud_rate = CONFIG_PX_GPS_BAUD;
    cfg.data_bits = UART_DATA_8_BITS;
    cfg.parity = UART_PARITY_DISABLE;
    cfg.stop_bits = UART_STOP_BITS_1;
    cfg.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    cfg.source_clk = UART_SCLK_DEFAULT;

    esp_err_t err = uart_driver_install(port, 2048, 0, 0, nullptr, 0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "uart_driver_install: %s", esp_err_to_name(err));
        return err;
    }
    uart_param_config(port, &cfg);
    uart_set_pin(port, CONFIG_PX_GPS_TX_GPIO, CONFIG_PX_GPS_RX_GPIO,
                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);

    s_stop_req.store(false);
    s_status = GpsStatus::Searching;
    {
        std::function<void(GpsStatus)> cb;
        {
            std::lock_guard<std::mutex> lk(s_mtx);
            cb = s_on_status;
        }
        if (cb) cb(GpsStatus::Searching);
    }
    if (xTaskCreatePinnedToCore(gps_task, "px_gps", 4096, nullptr, 5, &s_task, 0) != pdPASS) {
        uart_driver_delete(port);
        return ESP_ERR_NO_MEM;
    }
    s_running.store(true);
    return ESP_OK;
}

void gps_stop() {
    if (!s_running.load()) return;
    s_stop_req.store(true);
    // 任务自会退出并卸载驱动
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_on_fix = nullptr;
        s_on_status = nullptr;
    }
}

bool gps_last(NmeaFix& out) {
    std::lock_guard<std::mutex> lk(s_fix_mtx);
    if (!s_has_last) return false;
    out = s_last_fix;
    return true;
}

#else  // !CONFIG_PX_ENABLE_GPS —— 桩实现

bool gps_available() { return false; }

esp_err_t gps_start(uint32_t, std::function<void(const NmeaFix&)>, std::function<void(GpsStatus)>) {
    ESP_LOGW(TAG, "GPS 未启用 (PX_ENABLE_GPS=n)");
    return ESP_ERR_NOT_SUPPORTED;
}

void gps_stop() {}

bool gps_last(NmeaFix&) { return false; }

#endif  // CONFIG_PX_ENABLE_GPS

}  // namespace hal_periph
