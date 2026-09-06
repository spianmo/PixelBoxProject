#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>

namespace speech {

constexpr const char* kWakePhrase = "你好小川";
constexpr const char* kWakePinyin = "ni hao xiao chuan";
constexpr int kRate = 16000;

template <typename Interface>
bool has_required_multinet_api(const Interface* iface) {
    // MultiNet7 的 switch_loader_mode/open_log 是可选空指针，不纳入可用性判断或调用。
    return iface && iface->create && iface->destroy && iface->get_samp_rate && iface->get_samp_chunksize
        && iface->set_det_threshold && iface->detect && iface->get_results && iface->clean
        && iface->set_speech_commands && iface->check_speech_command;
}

struct ModelPayload { const uint8_t* data = nullptr; size_t size = 0; };
using ModelPayloads = std::array<ModelPayload, 4>;

/** ESP-SR pack_model.py 的定长目录表；在 vendor 解析器分配内存前校验计数、字符串与数据边界。 */
inline bool valid_model_archive(const uint8_t* data, size_t size, ModelPayloads* payloads = nullptr) {
    if (!data || size < 4) return false;
    const auto u32 = [data](size_t at) {
        return uint32_t(data[at]) | (uint32_t(data[at + 1]) << 8)
            | (uint32_t(data[at + 2]) << 16) | (uint32_t(data[at + 3]) << 24);
    };
    const auto name_ok = [data](size_t at) {
        if (!data[at]) return false;
        for (size_t i = 0; i < 32; i++) {
            const uint8_t ch = data[at + i];
            if (!ch) return true;
            if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
                    || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '.')) return false;
        }
        return false;
    };
    const uint32_t models = u32(0);
    if (!models || models > 16) return false;
    size_t offset = 4;
    size_t first_payload = size;
    bool has_mn7 = false;
    for (uint32_t i = 0; i < models; i++) {
        if (offset > size || size - offset < 36 || !name_ok(offset)) return false;
        const bool mn7 = std::strcmp(reinterpret_cast<const char*>(data + offset), "mn7_cn") == 0;
        if (mn7 && has_mn7) return false;
        const uint32_t files = u32(offset + 32);
        if (!files || files > 32) return false;
        offset += 36;
        if (files > (size - offset) / 40) return false;
        unsigned required = 0;
        for (uint32_t j = 0; j < files; j++, offset += 40) {
            if (!name_ok(offset)) return false;
            const char* name = reinterpret_cast<const char*>(data + offset);
            const uint32_t begin = u32(offset + 32), bytes = u32(offset + 36);
            if (!bytes || begin > size || bytes > size - begin) return false;
            if (std::strcmp(name, "_MODEL_INFO_") == 0 && bytes > 4096) return false;
            first_payload = std::min(first_payload, static_cast<size_t>(begin));
            int slot = -1;
            if (std::strcmp(name, "mn7_index") == 0) slot = 0;
            else if (std::strcmp(name, "mn7_data") == 0) slot = 1;
            else if (std::strcmp(name, "vocab") == 0) slot = 2;
            else if (std::strcmp(name, "_MODEL_INFO_") == 0) slot = 3;
            if (mn7 && slot >= 0) {
                if (required & (1u << slot)) return false;
                required |= 1u << slot;
                if (payloads) (*payloads)[slot] = {data + begin, bytes};
            }
        }
        if (mn7 && required == 15) has_mn7 = true;
    }
    return has_mn7 && offset <= first_payload;
}

inline bool digest_matches(const uint8_t* digest, const char* expected) {
    static constexpr const char* hex = "0123456789abcdef";
    for (size_t i = 0; i < 32; i++) {
        if (expected[i * 2] != hex[digest[i] >> 4] || expected[i * 2 + 1] != hex[digest[i] & 15]) return false;
    }
    return expected[64] == '\0';
}

inline bool valid_region(const std::string& value) {
    if (value.empty() || value.size() > 40) return false;
    return std::all_of(value.begin(), value.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); });
}

inline bool valid_name(const std::string& value) {
    if (value.empty() || value.size() > 80) return false;
    return std::all_of(value.begin(), value.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-'; });
}

inline std::string xml_escape(const std::string& text) {
    std::string result;
    for (char c : text) {
        switch (c) {
            case '&': result += "&amp;"; break;
            case '<': result += "&lt;"; break;
            case '>': result += "&gt;"; break;
            case '\"': result += "&quot;"; break;
            case '\'': result += "&apos;"; break;
            default: result += c;
        }
    }
    return result;
}

inline void wav_header(uint8_t* header, uint32_t bytes) {
    std::memset(header, 0, 44);
    const auto u16 = [header](int at, uint16_t value) { header[at] = value & 255; header[at + 1] = value >> 8; };
    const auto u32 = [header](int at, uint32_t value) { for (int i = 0; i < 4; i++) header[at + i] = (value >> (8 * i)) & 255; };
    std::memcpy(header, "RIFF", 4); u32(4, bytes + 36); std::memcpy(header + 8, "WAVEfmt ", 8);
    u32(16, 16); u16(20, 1); u16(22, 1); u32(24, kRate); u32(28, kRate * 2); u16(32, 2); u16(34, 16);
    std::memcpy(header + 36, "data", 4); u32(40, bytes);
}

// One microphone producer publishes an immutable PCM prefix for the VAD reader.
// Capture continues into the final WAV storage even when the reader is delayed.
class PcmCapture {
public:
    PcmCapture(int16_t* samples, size_t capacity) : samples_(samples), capacity_(capacity) {}
    void feed(const int16_t* samples, size_t count) {
        if (!enabled_.load() || !samples_) return;
        const size_t used = used_.load(std::memory_order_relaxed);
        const size_t copied = std::min(count, capacity_ - used);
        if (!copied) return;
        std::memcpy(samples_ + used, samples, copied * sizeof(int16_t));
        used_.store(used + copied, std::memory_order_release);
    }
    size_t size() const { return used_.load(std::memory_order_acquire); }
    void stop() { enabled_.store(false); }
private:
    int16_t* samples_;
    size_t capacity_;
    std::atomic<size_t> used_{0};
    std::atomic<bool> enabled_{true};
};

/** 本地能量 VAD：要求连续有效语音后再按静音结束，不把环境底噪上传为一句话。 */
class Vad {
public:
    explicit Vad(int silence_ms) : silence_ms_(silence_ms) {}
    bool feed(const int16_t* samples, size_t count) {
        double sum = 0;
        for (size_t i = 0; i < count; i++) { const double sample = samples[i] / 32768.0; sum += sample * sample; }
        const double rms = count ? std::sqrt(sum / count) : 0;
        level = static_cast<int>(std::min(100.0, rms * 400));
        const int ms = static_cast<int>(count * 1000 / kRate);
        // Normal desk-distance ES7210 speech can have RMS below 0.012.
        // Do not learn candidate speech as noise; quieter syllables use hysteresis.
        const bool voice = rms > (heard ? std::max(0.0025, noise_ * 1.8)
                                       : std::max(0.004, noise_ * 2.5));
        if (!heard && !voice) noise_ = noise_ * 0.97 + std::min(rms, 0.003) * 0.03;
        if (voice) {
            if (!heard && voiced_ms_ == 0) speech_start_ = processed_samples_;
            voiced_ms_ += ms; quiet_ms_ = 0;
        }
        else { quiet_ms_ += ms; if (!heard && quiet_ms_ > 120) voiced_ms_ = 0; }
        processed_samples_ += count;
        if (voiced_ms_ >= 180) heard = true;
        return heard && quiet_ms_ >= silence_ms_;
    }
    bool heard = false;
    int level = 0;
    size_t speech_start() const { return speech_start_; }
private:
    int silence_ms_;
    int voiced_ms_ = 0;
    int quiet_ms_ = 0;
    double noise_ = 0.001;
    size_t processed_samples_ = 0, speech_start_ = 0;
};

}  // namespace speech
