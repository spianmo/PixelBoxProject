/**
 * imu_qmi8658.cpp — QMI8658 驱动实现
 *
 * 寄存器摘要(QMI8658A datasheet):
 *   0x00 WHO_AM_I   = 0x05
 *   0x02 CTRL1      bit6 ADDR_AI 地址自增, bit5 BE 大端(0=小端)
 *   0x03 CTRL2      aFS[6:4] (010=±8g), aODR[3:0] (0011=1000Hz,0100=500,0101=250,0110=125,0111=62.5,1000=31.25)
 *   0x04 CTRL3      gFS[6:4] (101=±512dps), gODR[3:0] (0011=896.8,0100=448.4,0101=224.2,0110=112.1,0111=56.05)
 *   0x08 CTRL7      bit0 aEN, bit1 gEN
 *   0x35..0x40      AX_L..GZ_H (int16 小端)
 *   0x60 RESET      写 0xB0 软复位
 *
 * 量程换算:±8g → 4096 LSB/g;±512dps → 64 LSB/dps
 */
#include "hal_periph/imu_qmi8658.hpp"

#include <atomic>
#include <cmath>
#include <mutex>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal_common/board.h"

#include "hal_periph/i2c_bus.hpp"

static const char* TAG = "px.imu";

namespace hal_periph {

namespace {

constexpr float ACC_LSB_PER_G = 4096.0f;   // ±8g
constexpr float GYR_LSB_PER_DPS = 64.0f;   // ±512dps
constexpr uint16_t DETECT_RATE_HZ = 50;    // 摇一摇/姿态检测采样率
constexpr float SHAKE_THRESH_G = 1.8f;     // 模长阈值 (2.3g 在 50Hz+LPF 下峰值常落采样间隙,真机实测调低)
constexpr int64_t SHAKE_DEBOUNCE_US = 700 * 1000;
constexpr float ORIENT_THRESH_G = 0.70f;   // 姿态判定主轴阈值(带滞回)

i2c_master_dev_handle_t s_dev = nullptr;
std::atomic<bool> s_available{false};
TaskHandle_t s_task = nullptr;

std::mutex s_mtx;  // 保护下列回调与速率配置
std::function<void(const ImuSample&)> s_stream_cb;
std::function<void()> s_shake_cb;
std::function<void(ImuOrientation)> s_orient_cb;
uint16_t s_stream_rate = 0;  // 0 = 数据流关闭

// 检测状态(仅采样任务访问)
float s_lp_ax = 0, s_lp_ay = 0, s_lp_az = 1.0f;  // 重力低通
std::atomic<int> s_cur_orient{static_cast<int>(ImuOrientation::Flat)};
int64_t s_last_shake_us = 0;

/** 由期望速率选 ODR 档位;返回寄存器低 4 位值与实际速率 */
void pick_acc_odr(uint16_t want, uint8_t& odr_bits, uint16_t& actual) {
    struct { uint8_t bits; uint16_t hz; } table[] = {
        {0b1000, 31}, {0b0111, 62}, {0b0110, 125}, {0b0101, 250}, {0b0100, 500}, {0b0011, 1000},
    };
    for (auto& t : table) {
        if (want <= t.hz) { odr_bits = t.bits; actual = t.hz; return; }
    }
    odr_bits = 0b0011;
    actual = 1000;
}

esp_err_t configure_chip(uint16_t sample_hz) {
    uint8_t odr_bits;
    uint16_t actual;
    pick_acc_odr(sample_hz, odr_bits, actual);

    esp_err_t err = ESP_OK;
    // CTRL1: 地址自增 + 小端
    err |= i2c_write_reg8(s_dev, 0x02, 0x40);
    // CTRL2: ±8g | ODR
    err |= i2c_write_reg8(s_dev, 0x03, static_cast<uint8_t>((0b010 << 4) | odr_bits));
    // CTRL3: ±512dps | 448.4Hz(陀螺档位固定, 读取由任务节流)
    err |= i2c_write_reg8(s_dev, 0x04, static_cast<uint8_t>((0b101 << 4) | 0b0100));
    // CTRL5: 开加速度/陀螺低通(模式 A)
    err |= i2c_write_reg8(s_dev, 0x06, 0x11);
    // CTRL7: 使能 accel + gyro
    err |= i2c_write_reg8(s_dev, 0x08, 0x03);
    return err == ESP_OK ? ESP_OK : ESP_FAIL;
}

bool read_sample(ImuSample& out) {
    uint8_t raw[12];
    if (i2c_read_reg(s_dev, 0x35, raw, sizeof(raw)) != ESP_OK) return false;
    auto s16 = [&](int i) {
        return static_cast<int16_t>(static_cast<uint16_t>(raw[i]) | (static_cast<uint16_t>(raw[i + 1]) << 8));
    };
    out.ax = s16(0) / ACC_LSB_PER_G;
    out.ay = s16(2) / ACC_LSB_PER_G;
    out.az = s16(4) / ACC_LSB_PER_G;
    out.gx = s16(6) / GYR_LSB_PER_DPS;
    out.gy = s16(8) / GYR_LSB_PER_DPS;
    out.gz = s16(10) / GYR_LSB_PER_DPS;
    return true;
}

/**
 * 姿态六态判定(重力低通后取主导轴)。
 * 轴向假设(2.16 板贴装经官方原理图第 3 页轴标 + 04_Immersive_block demo 双重证实:
 * 芯片 +X=屏幕右, +Y=屏幕顶边, +Z=出屏; 1.8 板同向):
 *   +Z 朝屏幕外(朝上=Flat, 朝下=FaceDown)
 *   +Y 朝设备顶边(顶边朝上=Up, 朝下=Down)
 *   +X 朝设备右边(右边朝上=Right, 左边朝上=Left)
 * 若定制板轴向不同, 只需调整此函数的映射。
 */
ImuOrientation classify_orientation(float ax, float ay, float az, ImuOrientation prev) {
    float fx = std::fabs(ax), fy = std::fabs(ay), fz = std::fabs(az);
    if (fz >= fx && fz >= fy && fz > ORIENT_THRESH_G) {
        return az > 0 ? ImuOrientation::Flat : ImuOrientation::FaceDown;
    }
    if (fy >= fx && fy > ORIENT_THRESH_G) {
        return ay > 0 ? ImuOrientation::Up : ImuOrientation::Down;
    }
    if (fx > ORIENT_THRESH_G) {
        return ax > 0 ? ImuOrientation::Right : ImuOrientation::Left;
    }
    return prev;  // 处于中间地带 → 保持原状态(滞回)
}

void detect_step(const ImuSample& s) {
    // ---- 摇一摇:加速度模长阈值 + 去抖 ----
    float mag = std::sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az);
    if (mag > SHAKE_THRESH_G) {
        int64_t now = esp_timer_get_time();
        if (now - s_last_shake_us > SHAKE_DEBOUNCE_US) {
            s_last_shake_us = now;
            std::function<void()> cb;
            {
                std::lock_guard<std::mutex> lk(s_mtx);
                cb = s_shake_cb;
            }
            if (cb) cb();
        }
    }

    // ---- 姿态:重力低通 + 主导轴 ----
    constexpr float alpha = 0.15f;
    s_lp_ax += alpha * (s.ax - s_lp_ax);
    s_lp_ay += alpha * (s.ay - s_lp_ay);
    s_lp_az += alpha * (s.az - s_lp_az);
    auto prev = static_cast<ImuOrientation>(s_cur_orient.load(std::memory_order_relaxed));
    ImuOrientation cur = classify_orientation(s_lp_ax, s_lp_ay, s_lp_az, prev);
    if (cur != prev) {
        s_cur_orient.store(static_cast<int>(cur), std::memory_order_relaxed);
        std::function<void(ImuOrientation)> cb;
        {
            std::lock_guard<std::mutex> lk(s_mtx);
            cb = s_orient_cb;
        }
        if (cb) cb(cur);
    }
}

void imu_task(void*) {
    int64_t next_stream_us = 0;
    for (;;) {
        uint16_t stream_rate;
        std::function<void(const ImuSample&)> stream_cb;
        bool detect_on;
        {
            std::lock_guard<std::mutex> lk(s_mtx);
            stream_rate = s_stream_rate;
            stream_cb = s_stream_cb;
            detect_on = static_cast<bool>(s_shake_cb) || static_cast<bool>(s_orient_cb);
        }

        uint16_t rate = stream_rate;
        if (detect_on && rate < DETECT_RATE_HZ) rate = DETECT_RATE_HZ;
        if (rate == 0) {
            // 无消费者 → 挂起等待唤醒
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }

        ImuSample s;
        if (read_sample(s)) {
            if (detect_on) detect_step(s);
            if (stream_cb && stream_rate > 0) {
                int64_t now = esp_timer_get_time();
                if (now >= next_stream_us) {
                    next_stream_us = now + 1000000 / stream_rate;
                    stream_cb(s);
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000 / rate > 0 ? 1000 / rate : 1));
    }
}

void wake_task() {
    if (s_task) xTaskNotifyGive(s_task);
}

}  // namespace

esp_err_t imu_init() {
    if (s_dev != nullptr) return s_available.load() ? ESP_OK : ESP_FAIL;
    if (!board_caps()->imu) return ESP_ERR_NOT_SUPPORTED;

    // 地址来自 boards (hal_common/board.h)
    s_dev = i2c_bus_add_device(board_imu_config()->i2c_addr, 400000);
    if (s_dev == nullptr) return ESP_FAIL;

    uint8_t who = 0;
    if (i2c_read_reg(s_dev, 0x00, &who, 1) != ESP_OK || who != 0x05) {
        ESP_LOGW(TAG, "QMI8658 无应答/ID 不符 (who=0x%02X)", who);
        return ESP_ERR_NOT_FOUND;
    }

    // 软复位后重新配置
    i2c_write_reg8(s_dev, 0x60, 0xB0);
    vTaskDelay(pdMS_TO_TICKS(15));
    if (configure_chip(DETECT_RATE_HZ) != ESP_OK) return ESP_FAIL;

    if (xTaskCreatePinnedToCore(imu_task, "px_imu", 4096, nullptr, 6, &s_task, 0) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    s_available.store(true);
    ESP_LOGI(TAG, "QMI8658 就绪");
    return ESP_OK;
}

bool imu_available() { return s_available.load(); }

esp_err_t imu_start_stream(uint16_t rate_hz, std::function<void(const ImuSample&)> cb) {
    if (!s_available.load()) return ESP_ERR_INVALID_STATE;
    if (rate_hz < 5) rate_hz = 5;
    if (rate_hz > 500) rate_hz = 500;
    configure_chip(rate_hz);
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_stream_rate = rate_hz;
        s_stream_cb = std::move(cb);
    }
    wake_task();
    return ESP_OK;
}

void imu_stop_stream() {
    std::lock_guard<std::mutex> lk(s_mtx);
    s_stream_rate = 0;
    s_stream_cb = nullptr;
}

void imu_set_shake_callback(std::function<void()> cb) {
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_shake_cb = std::move(cb);
    }
    wake_task();
}

void imu_set_orientation_callback(std::function<void(ImuOrientation)> cb) {
    {
        std::lock_guard<std::mutex> lk(s_mtx);
        s_orient_cb = std::move(cb);
    }
    wake_task();
}

ImuOrientation imu_current_orientation() {
    return static_cast<ImuOrientation>(s_cur_orient.load(std::memory_order_relaxed));
}

}  // namespace hal_periph
