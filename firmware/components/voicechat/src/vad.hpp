/**
 * PixelBox voicechat — 能量 VAD(自适应噪声底)
 *
 * 以 20ms 帧为单位计算 RMS 能量:
 *   - 静音期噪声底快速跟随(EMA 0.95/0.05),语音期缓慢上浮,适应环境噪声变化
 *   - 语音判定:能量 > max(噪声底 × 倍率, 绝对下限)
 * speechStart/speechEnd/barge-in 的时序判定由引擎按帧计数完成。
 */
#pragma once

#include <cstddef>
#include <cstdint>

namespace voicechat {

class EnergyVad {
public:
    /** 每帧样本数(16kHz 下 20ms = 320) */
    static constexpr size_t kFrameSamples = 320;
    static constexpr uint32_t kFrameMs = 20;

    /** 处理一帧,返回是否判定为语音帧 */
    bool process(const int16_t* samples, size_t count);

    /** 新一轮对话开始时调用(不清噪声底,只清帧状态) */
    void reset_round() { last_rms_ = 0.0f; }
    /** 完全复位(含噪声底) */
    void reset_all() {
        noise_ = 0.0f;
        last_rms_ = 0.0f;
    }

    float last_rms() const { return last_rms_; }
    float noise_floor() const { return noise_; }

    /** 语音判定倍率(默认 3.0;barge-in 场景引擎另用更高倍率自行比较) */
    void set_factor(float f) { factor_ = f; }
    /** 绝对能量下限(过滤电噪声) */
    void set_min_energy(float e) { min_energy_ = e; }

    /** 实时音量 0-100(sqrt 映射,便于 UI 律动) */
    int level() const;

private:
    float noise_ = 0.0f;
    float last_rms_ = 0.0f;
    float factor_ = 3.0f;
    float min_energy_ = 120.0f;
};

}  // namespace voicechat
