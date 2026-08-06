/**
 * PixelBox hal_audio — 播放源实现(重采样 / 缓冲源 / 环形流源 / 正弦源)
 */
#include "hal_audio/audio_source.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "hal_common/px_alloc.h"
#include "freertos/task.h"

namespace hal_audio {

static const char* TAG = "hal_audio.src";

void* big_alloc(size_t size) {
    // PSRAM 优先, 无 PSRAM 目标或耗尽时自动落内部堆 (hal_common/px_alloc.h)
    return px_alloc_prefer_psram(size);
}

void big_free(void* p) {
    if (p) heap_caps_free(p);
}

// ---------------- LinearResampler ----------------

void LinearResampler::reset(uint32_t src_rate, uint32_t dst_rate) {
    src_ = src_rate ? src_rate : 16000;
    dst_ = dst_rate ? dst_rate : 16000;
    t_ = 0.0;
    prev_ = next_ = 0;
    primed_ = false;
    blen_ = bpos_ = 0;
}

bool LinearResampler::fetch(const PullFn& pull, int16_t& s) {
    if (bpos_ >= blen_) {
        blen_ = pull(buf_, sizeof(buf_) / sizeof(buf_[0]));
        bpos_ = 0;
        if (blen_ == 0) return false;
    }
    s = buf_[bpos_++];
    return true;
}

size_t LinearResampler::produce(int16_t* out, size_t want, const PullFn& pull) {
    if (src_ == dst_) {
        // 直通:先倒出内部残留,再直接拉取
        size_t n = 0;
        while (n < want && bpos_ < blen_) out[n++] = buf_[bpos_++];
        if (n < want) n += pull(out + n, want - n);
        return n;
    }
    const double step = static_cast<double>(src_) / static_cast<double>(dst_);
    size_t n = 0;
    if (!primed_) {
        if (!fetch(pull, prev_)) return 0;
        if (!fetch(pull, next_)) next_ = prev_;
        primed_ = true;
        t_ = 0.0;
    }
    while (n < want) {
        while (t_ >= 1.0) {
            int16_t s;
            if (!fetch(pull, s)) return n;  // 源暂尽,状态保留
            prev_ = next_;
            next_ = s;
            t_ -= 1.0;
        }
        out[n++] = static_cast<int16_t>(prev_ + (next_ - prev_) * t_);
        t_ += step;
    }
    return n;
}

// ---------------- Source ----------------

void Source::on_finished(std::function<void()> cb) {
    std::lock_guard<std::mutex> lk(cb_mtx_);
    finished_cb_ = std::move(cb);
}

void Source::fire_finished() {
    std::function<void()> cb;
    {
        std::lock_guard<std::mutex> lk(cb_mtx_);
        if (finished_fired_) return;
        finished_fired_ = true;
        // move 走并清空,断开「源 → 回调 → 句柄 → 源」的引用环
        cb = std::move(finished_cb_);
        finished_cb_ = nullptr;
    }
    if (cb) cb();
}

// ---------------- PcmBufferSource ----------------

std::shared_ptr<PcmBufferSource> PcmBufferSource::create(const uint8_t* pcm, size_t bytes,
                                                         uint32_t sample_rate, uint8_t channels) {
    if (!pcm || bytes < 2 || (channels != 1 && channels != 2)) return nullptr;
    auto s = std::shared_ptr<PcmBufferSource>(new PcmBufferSource());
    const size_t frame = channels * 2u;
    const size_t frames = bytes / frame;
    s->data_ = static_cast<int16_t*>(big_alloc(frames * frame));
    if (!s->data_) {
        ESP_LOGE(TAG, "playPcm 缓冲分配失败 (%u 字节)", static_cast<unsigned>(bytes));
        return nullptr;
    }
    memcpy(s->data_, pcm, frames * frame);
    s->total_samples_ = frames;
    s->ch_ = channels;
    s->rate_ = sample_rate ? sample_rate : 16000;
    return s;
}

PcmBufferSource::~PcmBufferSource() { big_free(data_); }

size_t PcmBufferSource::pull(int16_t* out, size_t max) {
    if (stopped()) return 0;
    size_t n = 0;
    if (ch_ == 1) {
        while (n < max && pos_ < total_samples_) out[n++] = data_[pos_++];
    } else {
        while (n < max && pos_ < total_samples_) {
            const int32_t l = data_[pos_ * 2];
            const int32_t r = data_[pos_ * 2 + 1];
            out[n++] = static_cast<int16_t>((l + r) / 2);
            pos_++;
        }
    }
    return n;
}

bool PcmBufferSource::finished() { return stopped() || pos_ >= total_samples_; }

// ---------------- PcmRingSource ----------------

std::shared_ptr<PcmRingSource> PcmRingSource::create(uint32_t sample_rate, uint8_t channels,
                                                     size_t capacity_bytes) {
    if ((channels != 1 && channels != 2) || capacity_bytes < 1024) return nullptr;
    auto s = std::shared_ptr<PcmRingSource>(new PcmRingSource());
    s->buf_ = static_cast<uint8_t*>(big_alloc(capacity_bytes));
    if (!s->buf_) {
        ESP_LOGE(TAG, "PCM 环形缓冲分配失败 (%u 字节)", static_cast<unsigned>(capacity_bytes));
        return nullptr;
    }
    s->cap_ = capacity_bytes - capacity_bytes % (static_cast<size_t>(channels) * 2);
    s->ch_ = channels;
    s->rate_ = sample_rate ? sample_rate : 16000;
    return s;
}

PcmRingSource::~PcmRingSource() { big_free(buf_); }

size_t PcmRingSource::feed(const uint8_t* data, size_t len) {
    if (!data || !len) return 0;
    std::lock_guard<std::mutex> lk(mtx_);
    if (stopped() || eos_) return 0;
    size_t accepted = 0;
    const size_t fb = frame_bytes();

    // 先补齐上次残留的半帧
    if (stash_len_ > 0) {
        while (stash_len_ < fb && accepted < len) stash_[stash_len_++] = data[accepted++];
        if (stash_len_ < fb) return accepted;  // 仍不足一帧
        if (cap_ - used_ >= fb) {
            for (size_t i = 0; i < fb; i++) {
                buf_[wr_] = stash_[i];
                wr_ = (wr_ + 1) % cap_;
            }
            used_ += fb;
        }
        stash_len_ = 0;
    }

    size_t remain = len - accepted;
    size_t whole = remain - remain % fb;
    size_t space = cap_ - used_;
    space -= space % fb;
    const size_t to_copy = whole < space ? whole : space;
    size_t src = accepted;
    size_t copied = 0;
    while (copied < to_copy) {
        const size_t chunk = std::min(to_copy - copied, cap_ - wr_);
        memcpy(buf_ + wr_, data + src, chunk);
        wr_ = (wr_ + chunk) % cap_;
        src += chunk;
        copied += chunk;
    }
    used_ += copied;
    accepted += copied;

    // 空间满时丢弃多余整帧;残余不足一帧的尾巴进 stash
    if (copied == whole) {
        size_t tail = len - accepted;
        if (tail > 0 && tail < fb) {
            memcpy(stash_, data + accepted, tail);
            stash_len_ = tail;
            accepted += tail;
        }
    }
    return accepted;
}

size_t PcmRingSource::feed_blocking(const uint8_t* data, size_t len, uint32_t timeout_ms) {
    size_t done = 0;
    uint32_t waited = 0;
    while (done < len) {
        const size_t n = feed(data + done, len - done);
        done += n;
        if (done >= len) break;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (stopped() || eos_) break;
        }
        if (n == 0) {
            if (waited >= timeout_ms) break;
            vTaskDelay(pdMS_TO_TICKS(10));
            waited += 10;
        } else {
            waited = 0;
        }
    }
    return done;
}

void PcmRingSource::end() {
    std::lock_guard<std::mutex> lk(mtx_);
    eos_ = true;
}

void PcmRingSource::stop() {
    Source::stop();
    std::lock_guard<std::mutex> lk(mtx_);
    used_ = 0;
    rd_ = wr_ = 0;
    stash_len_ = 0;
}

uint32_t PcmRingSource::buffered_ms() const {
    std::lock_guard<std::mutex> lk(mtx_);
    const size_t bytes_per_ms = rate_ / 1000 * frame_bytes();
    return bytes_per_ms ? static_cast<uint32_t>(used_ / bytes_per_ms) : 0;
}

size_t PcmRingSource::free_bytes() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return cap_ - used_;
}

bool PcmRingSource::ended() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return eos_;
}

size_t PcmRingSource::pull(int16_t* out, size_t max) {
    std::lock_guard<std::mutex> lk(mtx_);
    if (stopped()) return 0;
    const size_t fb = frame_bytes();
    size_t frames_avail = used_ / fb;
    size_t n = 0;
    while (n < max && frames_avail > 0) {
        int32_t acc = 0;
        for (int c = 0; c < ch_; c++) {
            // 环内数据保证整帧,逐字节取避免跨界处理复杂化
            const uint8_t lo = buf_[rd_];
            const uint8_t hi = buf_[(rd_ + 1) % cap_];
            rd_ = (rd_ + 2) % cap_;
            acc += static_cast<int16_t>(lo | (hi << 8));
        }
        used_ -= fb;
        frames_avail--;
        out[n++] = static_cast<int16_t>(acc / ch_);
    }
    return n;
}

bool PcmRingSource::finished() {
    std::lock_guard<std::mutex> lk(mtx_);
    return stopped() || (eos_ && used_ < frame_bytes());
}

// ---------------- ToneSource ----------------

std::shared_ptr<ToneSource> ToneSource::create(uint32_t sample_rate, float freq_hz,
                                               uint32_t duration_ms, int volume) {
    auto s = std::shared_ptr<ToneSource>(new ToneSource());
    s->rate_ = sample_rate ? sample_rate : 16000;
    s->freq_ = freq_hz > 20.0f ? freq_hz : 20.0f;
    if (volume < 0) volume = 0;
    if (volume > 100) volume = 100;
    s->amp_ = volume / 100.0f * 0.8f * 32767.0f;
    s->total_ = static_cast<uint32_t>(static_cast<uint64_t>(s->rate_) * duration_ms / 1000);
    s->fade_ = s->rate_ / 200;  // 5ms
    if (s->fade_ * 2 > s->total_) s->fade_ = s->total_ / 4;
    return s;
}

size_t ToneSource::pull(int16_t* out, size_t max) {
    if (stopped()) return 0;
    const float step = 2.0f * static_cast<float>(M_PI) * freq_ / rate_;
    size_t n = 0;
    while (n < max && pos_ < total_) {
        float env = 1.0f;
        if (fade_ > 0) {
            if (pos_ < fade_) env = static_cast<float>(pos_) / fade_;
            else if (total_ - pos_ < fade_) env = static_cast<float>(total_ - pos_) / fade_;
        }
        out[n++] = static_cast<int16_t>(sinf(phase_) * amp_ * env);
        phase_ += step;
        if (phase_ > 2.0f * static_cast<float>(M_PI)) phase_ -= 2.0f * static_cast<float>(M_PI);
        pos_++;
    }
    return n;
}

bool ToneSource::finished() { return stopped() || pos_ >= total_; }

}  // namespace hal_audio
