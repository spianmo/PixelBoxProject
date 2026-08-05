/**
 * imu_qmi8658.hpp — QMI8658 六轴 IMU 寄存器级驱动(I2C)
 *
 * - 数据流:start(rate_hz, cb) 启动采样任务, 按用户速率回调原始样本
 * - 摇一摇 / 姿态检测:独立于数据流, 由内部低速采样(50Hz)驱动;
 *   数据流与检测共享同一个采样任务(取二者所需的最高速率)
 * - 所有回调在采样任务上下文, 使用方负责投递到 JS 线程
 *
 * 单位约定:加速度 g;角速度 dps(与 d.ts PxImuData 注释保持一致)
 */
#pragma once

#include <cstdint>
#include <functional>

#include "esp_err.h"

namespace hal_periph {

struct ImuSample {
    float ax, ay, az;  ///< g
    float gx, gy, gz;  ///< dps
};

/** 重力方向六态(与 d.ts onOrientation 字面量一一对应) */
enum class ImuOrientation : uint8_t { Up, Down, Left, Right, Flat, FaceDown };

/** 初始化 IMU(幂等):探测 WHO_AM_I 并完成基础配置 */
esp_err_t imu_init();

/** IMU 是否在位可用 */
bool imu_available();

/** 启动数据流(rate_hz 5~500, 内部就近取 ODR);重复调用覆盖旧配置 */
esp_err_t imu_start_stream(uint16_t rate_hz, std::function<void(const ImuSample&)> cb);

/** 停止数据流(检测若在用会继续采样) */
void imu_stop_stream();

/** 开/关摇一摇检测;cb 在检测命中时回调(内部已做 700ms 去抖) */
void imu_set_shake_callback(std::function<void()> cb);

/** 开/关姿态检测;姿态变化时回调 */
void imu_set_orientation_callback(std::function<void(ImuOrientation)> cb);

/** 读取当前姿态(未知/未采样时返回 Flat) */
ImuOrientation imu_current_orientation();

}  // namespace hal_periph
