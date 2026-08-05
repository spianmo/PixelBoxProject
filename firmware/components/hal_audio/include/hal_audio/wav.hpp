/**
 * PixelBox hal_audio — WAV(RIFF)流式解析器与写入器
 *
 * 解析器面向「边下载边播」场景:任意大小分块 push,自动跳过无关 chunk,
 * fmt 解析完成后 data chunk 的 PCM 载荷通过回调切出。
 * 支持 PCM 16bit 与 8bit(8bit 由上层转换),其余格式报错。
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <vector>

namespace hal_audio {

struct WavInfo {
    uint32_t sample_rate = 0;
    uint16_t channels = 0;
    uint16_t bits = 0;
    uint32_t data_bytes = 0;  ///< data chunk 声明大小(流式可能为 0xFFFFFFFF)
};

class WavStreamParser {
public:
    using PcmSink = std::function<void(const uint8_t* pcm, size_t len)>;

    /**
     * 喂入一块字节流;data 区载荷经 on_pcm 回调切出。
     * 返回 false 表示格式错误(error() 为 true)。
     */
    bool push(const uint8_t* data, size_t len, const PcmSink& on_pcm);

    bool header_ready() const { return header_ready_; }
    bool error() const { return error_; }
    const WavInfo& info() const { return info_; }

private:
    enum class St { RIFF, CHUNK_HDR, FMT_BODY, SKIP, DATA };

    St st_ = St::RIFF;
    std::vector<uint8_t> hold_;   // 头部字节暂存
    uint32_t skip_left_ = 0;
    uint32_t data_left_ = 0;
    WavInfo info_;
    bool header_ready_ = false;
    bool error_ = false;
};

/** WAV 文件写入器(PCM16LE);finalize 时回填 RIFF/data 长度 */
class WavWriter {
public:
    ~WavWriter();
    bool open(const char* path, uint32_t sample_rate, uint16_t channels);
    bool write(const int16_t* samples, size_t count);
    /** 已写入的 PCM 字节数 */
    uint32_t data_bytes() const { return data_bytes_; }
    /** 回填长度并关闭;返回是否成功 */
    bool finalize();

private:
    FILE* fp_ = nullptr;
    uint32_t data_bytes_ = 0;
};

}  // namespace hal_audio
