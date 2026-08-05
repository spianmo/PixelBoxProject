/**
 * PixelBox hal_audio — 音频解码流(文件 / http(s) → PCM 环形源)
 *
 * player.play() 的底层:独立解码任务从文件或 esp_http_client 拉取字节流,
 * 按内容嗅探(RIFF→WAV,ID3/FF-sync→MP3)选择解码路径:
 *   - WAV:自带流式解析器(16bit 直通,8bit 转 16bit)
 *   - MP3:esp_audio_codec 的 simple decoder
 * 解码 PCM 以 feed_blocking 背压方式写入内部 PcmRingSource,由混音器消费。
 */
#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <string>

#include "esp_err.h"
#include "hal_audio/audio_source.hpp"

namespace hal_audio {

class DecodeStream : public std::enable_shared_from_this<DecodeStream> {
public:
    using Ptr = std::shared_ptr<DecodeStream>;
    /**
     * 头部解析结果回调(恰好一次,运行在解码任务上下文):
     * err==ESP_OK 时 source() 已就绪(采样率/声道已知),可挂入混音器。
     */
    using StartedCb = std::function<void(esp_err_t err)>;

    /** src:本地绝对路径(/flash/...)或 http(s):// URL。失败返回 nullptr(不回调) */
    static Ptr open(const std::string& src, StartedCb on_started);

    /** 字节流读取抽象(文件 / HTTP;实现在 .cpp 内) */
    struct Reader;

    ~DecodeStream();

    /** 头部解析成功后有效 */
    std::shared_ptr<PcmRingSource> source() const { return ring_; }

    /** 中止解码并停止播放源 */
    void abort();

private:
    DecodeStream() = default;
    void task_main();
    static void task_tramp(void* arg);

    bool pump(Reader& rd, esp_err_t& err_out);
    bool pump_wav(Reader& rd, const uint8_t* pre, size_t pre_len, esp_err_t& err_out);
    bool pump_mp3(Reader& rd, const uint8_t* pre, size_t pre_len, esp_err_t& err_out);
    bool ring_write(const uint8_t* pcm, size_t len);

    std::string src_;
    StartedCb started_cb_;
    std::atomic<bool> abort_{false};
    std::shared_ptr<PcmRingSource> ring_;
    bool started_ok_ = false;
};

}  // namespace hal_audio
