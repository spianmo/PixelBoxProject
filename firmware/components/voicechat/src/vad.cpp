/**
 * PixelBox voicechat — 能量 VAD 实现
 */
#include "vad.hpp"

#include <cmath>

namespace voicechat {

bool EnergyVad::process(const int16_t* samples, size_t count) {
    if (!samples || count == 0) return false;
    // RMS
    uint64_t acc = 0;
    for (size_t i = 0; i < count; i++) {
        const int32_t v = samples[i];
        acc += static_cast<uint64_t>(v * v);
    }
    const float rms = sqrtf(static_cast<float>(acc) / static_cast<float>(count));
    last_rms_ = rms;

    if (noise_ <= 0.0f) {
        // 首帧:以当前能量为噪声底起点(避免开机大声导致永远判语音)
        noise_ = rms > 1.0f ? rms : 100.0f;
    }
    const float threshold = noise_ * factor_ > min_energy_ ? noise_ * factor_ : min_energy_;
    const bool speech = rms > threshold;
    if (speech) {
        noise_ = noise_ * 0.999f + rms * 0.001f;  // 语音期缓慢上浮
    } else {
        noise_ = noise_ * 0.95f + rms * 0.05f;    // 静音期快速跟随
    }
    return speech;
}

int EnergyVad::level() const {
    // sqrt 压缩映射:低音量段更灵敏,适合 UI 律动
    float v = last_rms_ / 32768.0f;
    if (v < 0.0f) v = 0.0f;
    v = sqrtf(v) * 140.0f;
    if (v > 100.0f) v = 100.0f;
    return static_cast<int>(v);
}

}  // namespace voicechat
