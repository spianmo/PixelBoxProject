/**
 * PixelBox hal_audio — 播放源与重采样器
 *
 * Source 抽象:混音器(playback 任务)通过 pull() 拉取「源采样率下的单声道 int16」样本,
 * 由混音器内的 LinearResampler 统一重采样到设备输出采样率后叠加混音。
 *
 * 线程约定:
 *   - pull()/finished() 仅由 playback 任务调用
 *   - feed()/end()/stop()/pause() 可从任意任务调用(内部加锁)
 */
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>

namespace hal_audio {

/** 大缓冲分配:优先 PSRAM,失败回退内部 RAM;返回 nullptr 表示失败 */
void* big_alloc(size_t size);
void big_free(void* p);

/** 线性插值重采样器(单声道 int16) */
class LinearResampler {
public:
    using PullFn = std::function<size_t(int16_t* out, size_t max)>;

    void reset(uint32_t src_rate, uint32_t dst_rate);
    uint32_t src_rate() const { return src_; }
    uint32_t dst_rate() const { return dst_; }

    /**
     * 从 pull 拉取源样本,产出最多 want 个目标采样率样本。
     * 返回实际产出数;不足说明源数据暂时耗尽(状态保留,下次继续)。
     */
    size_t produce(int16_t* out, size_t want, const PullFn& pull);

private:
    bool fetch(const PullFn& pull, int16_t& s);

    uint32_t src_ = 16000;
    uint32_t dst_ = 16000;
    double t_ = 0.0;
    int16_t prev_ = 0;
    int16_t next_ = 0;
    bool primed_ = false;
    int16_t buf_[256];
    size_t blen_ = 0;
    size_t bpos_ = 0;
};

/** 播放源基类 */
class Source {
public:
    virtual ~Source() = default;

    /** 拉取最多 max 个「源采样率、单声道」样本,返回实际数(0 = 暂无数据) */
    virtual size_t pull(int16_t* out, size_t max) = 0;
    /** 数据是否已终结(耗尽或被 stop)——终结后混音器移除并触发 on_finished */
    virtual bool finished() = 0;

    uint32_t sample_rate() const { return rate_; }
    float gain() const { return gain_.load(std::memory_order_relaxed); }
    void set_gain(float g) { gain_.store(g, std::memory_order_relaxed); }

    void pause() { paused_.store(true, std::memory_order_relaxed); }
    void resume() { paused_.store(false, std::memory_order_relaxed); }
    bool paused() const { return paused_.load(std::memory_order_relaxed); }

    virtual void stop() { stopped_.store(true, std::memory_order_relaxed); }
    bool stopped() const { return stopped_.load(std::memory_order_relaxed); }

    /** 是否仍挂在混音器上(近似「正在播放」;暂停中也视为在播) */
    bool attached() const { return attached_.load(std::memory_order_relaxed); }

    /**
     * 播放结束回调(数据耗尽或被 stop 后,由 playback 任务调用,至多一次)。
     * 回调运行在 playback 任务上下文,禁止阻塞;投递 JS 请走 jsvm::post。
     */
    void on_finished(std::function<void()> cb);

    // ---- 以下仅供混音器内部使用 ----
    LinearResampler& mixer_resampler() { return rs_; }
    void set_attached(bool v) { attached_.store(v, std::memory_order_relaxed); }
    void fire_finished();

protected:
    uint32_t rate_ = 16000;
    std::atomic<float> gain_{1.0f};
    std::atomic<bool> paused_{false};
    std::atomic<bool> stopped_{false};
    std::atomic<bool> attached_{false};

private:
    std::mutex cb_mtx_;
    std::function<void()> finished_cb_;
    bool finished_fired_ = false;
    LinearResampler rs_;
};

/** 一次性 PCM 缓冲源(playPcm):整块数据拷贝到 PSRAM */
class PcmBufferSource : public Source {
public:
    /** channels 1/2;立体声在 pull 时均值降混为单声道 */
    static std::shared_ptr<PcmBufferSource> create(const uint8_t* pcm, size_t bytes,
                                                   uint32_t sample_rate, uint8_t channels);
    ~PcmBufferSource() override;

    size_t pull(int16_t* out, size_t max) override;
    bool finished() override;

private:
    PcmBufferSource() = default;
    int16_t* data_ = nullptr;
    size_t total_samples_ = 0;   // 按帧计(单声道样本数)
    size_t pos_ = 0;
    uint8_t ch_ = 1;
};

/**
 * 环形缓冲流式源(openPcmStream / TTS 下行 / 解码器输出)。
 * 缓冲位于 PSRAM;feed 非阻塞(满则截断),feed_blocking 供解码任务背压使用。
 */
class PcmRingSource : public Source {
public:
    static std::shared_ptr<PcmRingSource> create(uint32_t sample_rate, uint8_t channels,
                                                 size_t capacity_bytes);
    ~PcmRingSource() override;

    /** 写入 PCM16LE 交错数据,返回实际接受字节数(可能小于 len) */
    size_t feed(const uint8_t* data, size_t len);
    /** 阻塞写入(等待消费腾出空间),用于解码任务;stop/超时后返回已写字节 */
    size_t feed_blocking(const uint8_t* data, size_t len, uint32_t timeout_ms);
    /** 声明流结束:缓冲播完后 finished() 变 true 并触发 on_finished */
    void end();
    void stop() override;

    /** 当前缓冲的毫秒数 */
    uint32_t buffered_ms() const;
    size_t free_bytes() const;
    bool ended() const;

    size_t pull(int16_t* out, size_t max) override;
    bool finished() override;

private:
    PcmRingSource() = default;
    size_t frame_bytes() const { return static_cast<size_t>(ch_) * 2; }

    uint8_t* buf_ = nullptr;
    size_t cap_ = 0;
    size_t rd_ = 0;
    size_t wr_ = 0;
    size_t used_ = 0;
    uint8_t ch_ = 1;
    bool eos_ = false;
    // feed 数据不足一帧时暂存,保证环内始终整帧对齐
    uint8_t stash_[4] = {0};
    size_t stash_len_ = 0;
    mutable std::mutex mtx_;
};

/** 正弦蜂鸣源(tone):5ms 淡入淡出防爆音 */
class ToneSource : public Source {
public:
    /** volume 0-100 */
    static std::shared_ptr<ToneSource> create(uint32_t sample_rate, float freq_hz,
                                              uint32_t duration_ms, int volume);

    size_t pull(int16_t* out, size_t max) override;
    bool finished() override;

private:
    ToneSource() = default;
    float freq_ = 440.0f;
    float amp_ = 0.5f;
    uint32_t total_ = 0;   // 总样本数
    uint32_t fade_ = 0;    // 淡入淡出样本数
    uint32_t pos_ = 0;
    float phase_ = 0.0f;
};

}  // namespace hal_audio
