/**
 * PixelBox hal_audio — WAV 流式解析器与写入器实现
 */
#include "hal_audio/wav.hpp"

#include <algorithm>
#include <cstring>

#include "esp_log.h"

namespace hal_audio {

static const char* TAG = "hal_audio.wav";

namespace {
uint32_t rd_u32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t rd_u16(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}
void wr_u32(uint8_t* p, uint32_t v) {
    p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; p[2] = (v >> 16) & 0xFF; p[3] = (v >> 24) & 0xFF;
}
void wr_u16(uint8_t* p, uint16_t v) {
    p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF;
}
}  // namespace

// ---------------- WavStreamParser ----------------

bool WavStreamParser::push(const uint8_t* data, size_t len, const PcmSink& on_pcm) {
    if (error_) return false;
    size_t off = 0;
    while (off < len) {
        switch (st_) {
            case St::RIFF: {
                // 需要 12 字节:RIFF <size> WAVE
                const size_t need = 12 - hold_.size();
                const size_t take = std::min(need, len - off);
                hold_.insert(hold_.end(), data + off, data + off + take);
                off += take;
                if (hold_.size() < 12) return true;
                if (memcmp(hold_.data(), "RIFF", 4) != 0 || memcmp(hold_.data() + 8, "WAVE", 4) != 0) {
                    ESP_LOGE(TAG, "非 RIFF/WAVE 文件");
                    error_ = true;
                    return false;
                }
                hold_.clear();
                st_ = St::CHUNK_HDR;
                break;
            }
            case St::CHUNK_HDR: {
                const size_t need = 8 - hold_.size();
                const size_t take = std::min(need, len - off);
                hold_.insert(hold_.end(), data + off, data + off + take);
                off += take;
                if (hold_.size() < 8) return true;
                const uint32_t sz = rd_u32(hold_.data() + 4);
                if (memcmp(hold_.data(), "fmt ", 4) == 0) {
                    skip_left_ = sz;
                    hold_.clear();
                    st_ = St::FMT_BODY;
                } else if (memcmp(hold_.data(), "data", 4) == 0) {
                    if (info_.sample_rate == 0) {
                        ESP_LOGE(TAG, "data 块先于 fmt 块出现");
                        error_ = true;
                        return false;
                    }
                    info_.data_bytes = sz;
                    data_left_ = sz ? sz : 0xFFFFFFFF;  // 流式 WAV 可能填 0
                    header_ready_ = true;
                    hold_.clear();
                    st_ = St::DATA;
                } else {
                    // 其他 chunk(LIST/fact 等)跳过;注意 RIFF 偶数对齐
                    skip_left_ = sz + (sz & 1);
                    hold_.clear();
                    st_ = St::SKIP;
                }
                break;
            }
            case St::FMT_BODY: {
                // fmt 至少 16 字节;多余部分(扩展)跳过
                const size_t need = (skip_left_ < 16 ? skip_left_ : 16) - hold_.size();
                const size_t take = std::min(need, len - off);
                hold_.insert(hold_.end(), data + off, data + off + take);
                off += take;
                if (hold_.size() < 16) {
                    if (skip_left_ < 16) {
                        error_ = true;
                        return false;
                    }
                    return true;
                }
                const uint16_t fmt = rd_u16(hold_.data());
                info_.channels = rd_u16(hold_.data() + 2);
                info_.sample_rate = rd_u32(hold_.data() + 4);
                info_.bits = rd_u16(hold_.data() + 14);
                if (fmt != 1 || (info_.bits != 16 && info_.bits != 8) ||
                    (info_.channels != 1 && info_.channels != 2) || info_.sample_rate == 0) {
                    ESP_LOGE(TAG, "不支持的 WAV 格式: fmt=%u bits=%u ch=%u", fmt, info_.bits,
                             info_.channels);
                    error_ = true;
                    return false;
                }
                const uint32_t extra = skip_left_ - 16 + (skip_left_ & 1);
                hold_.clear();
                if (extra > 0) {
                    skip_left_ = extra;
                    st_ = St::SKIP;
                } else {
                    st_ = St::CHUNK_HDR;
                }
                break;
            }
            case St::SKIP: {
                const size_t take = std::min(static_cast<size_t>(skip_left_), len - off);
                off += take;
                skip_left_ -= take;
                if (skip_left_ == 0) st_ = St::CHUNK_HDR;
                break;
            }
            case St::DATA: {
                const size_t take = std::min(static_cast<size_t>(data_left_), len - off);
                if (take > 0 && on_pcm) on_pcm(data + off, take);
                off += take;
                if (data_left_ != 0xFFFFFFFF) {
                    data_left_ -= take;
                    if (data_left_ == 0) st_ = St::CHUNK_HDR;  // 后续 chunk 忽略也无妨
                }
                break;
            }
        }
    }
    return true;
}

// ---------------- WavWriter ----------------

WavWriter::~WavWriter() {
    if (fp_) fclose(fp_);
}

bool WavWriter::open(const char* path, uint32_t sample_rate, uint16_t channels) {
    if (fp_) return false;
    fp_ = fopen(path, "wb");
    if (!fp_) {
        ESP_LOGE(TAG, "无法创建文件: %s", path);
        return false;
    }
    uint8_t hdr[44];
    memcpy(hdr, "RIFF", 4);
    wr_u32(hdr + 4, 36);  // 占位,finalize 回填
    memcpy(hdr + 8, "WAVEfmt ", 8);
    wr_u32(hdr + 16, 16);
    wr_u16(hdr + 20, 1);  // PCM
    wr_u16(hdr + 22, channels);
    wr_u32(hdr + 24, sample_rate);
    wr_u32(hdr + 28, sample_rate * channels * 2);
    wr_u16(hdr + 32, static_cast<uint16_t>(channels * 2));
    wr_u16(hdr + 34, 16);
    memcpy(hdr + 36, "data", 4);
    wr_u32(hdr + 40, 0);  // 占位
    if (fwrite(hdr, 1, 44, fp_) != 44) {
        fclose(fp_);
        fp_ = nullptr;
        return false;
    }
    data_bytes_ = 0;
    return true;
}

bool WavWriter::write(const int16_t* samples, size_t count) {
    if (!fp_) return false;
    const size_t n = fwrite(samples, 2, count, fp_);
    data_bytes_ += static_cast<uint32_t>(n * 2);
    return n == count;
}

bool WavWriter::finalize() {
    if (!fp_) return false;
    uint8_t sz[4];
    bool ok = true;
    wr_u32(sz, 36 + data_bytes_);
    ok = ok && fseek(fp_, 4, SEEK_SET) == 0 && fwrite(sz, 1, 4, fp_) == 4;
    wr_u32(sz, data_bytes_);
    ok = ok && fseek(fp_, 40, SEEK_SET) == 0 && fwrite(sz, 1, 4, fp_) == 4;
    fclose(fp_);
    fp_ = nullptr;
    return ok;
}

}  // namespace hal_audio
