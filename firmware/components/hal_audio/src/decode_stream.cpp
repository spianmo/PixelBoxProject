/**
 * PixelBox hal_audio — 音频解码流实现
 *
 * 解码任务:Reader(文件/HTTP) → 嗅探(WAV/MP3) → 解码 → PcmRingSource(背压)
 */
#include "hal_audio/decode_stream.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <memory>

#include "esp_audio_simple_dec.h"
#include "esp_audio_simple_dec_default.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal_audio/wav.hpp"
#include "sdkconfig.h"

namespace hal_audio {

static const char* TAG = "hal_audio.dec";

namespace {
constexpr size_t kReadChunk = 4096;
constexpr uint32_t kFeedTimeoutMs = 30000;  // 环满时最长等待(混音器消费)
}  // namespace

// ---------------- 字节流读取抽象 ----------------

struct DecodeStream::Reader {
    virtual ~Reader() = default;
    /** 返回读取字节数;0 = EOF;<0 = 错误 */
    virtual int read(uint8_t* buf, size_t len) = 0;
};

namespace {

struct FileReader final : DecodeStream::Reader {
    FILE* fp = nullptr;
    ~FileReader() override {
        if (fp) fclose(fp);
    }
    bool open(const char* path) {
        fp = fopen(path, "rb");
        return fp != nullptr;
    }
    int read(uint8_t* buf, size_t len) override {
        if (!fp) return -1;
        const size_t n = fread(buf, 1, len, fp);
        if (n == 0) return ferror(fp) ? -1 : 0;
        return static_cast<int>(n);
    }
};

struct HttpReader final : DecodeStream::Reader {
    esp_http_client_handle_t h = nullptr;
    ~HttpReader() override {
        if (h) {
            esp_http_client_close(h);
            esp_http_client_cleanup(h);
        }
    }
    bool open(const char* url) {
        esp_http_client_config_t cfg = {};
        cfg.url = url;
        cfg.timeout_ms = 15000;
        cfg.buffer_size = 4096;
        cfg.crt_bundle_attach = esp_crt_bundle_attach;
        h = esp_http_client_init(&cfg);
        if (!h) return false;
        // 手动 open/read 模式不自动跟随重定向,这里最多跟 4 跳
        for (int i = 0; i < 4; i++) {
            if (esp_http_client_open(h, 0) != ESP_OK) return false;
            esp_http_client_fetch_headers(h);
            const int st = esp_http_client_get_status_code(h);
            if (st == 301 || st == 302 || st == 303 || st == 307 || st == 308) {
                esp_http_client_set_redirection(h);
                esp_http_client_close(h);
                continue;
            }
            if (st == 200 || st == 206) return true;
            ESP_LOGE(TAG, "HTTP 状态码 %d", st);
            return false;
        }
        ESP_LOGE(TAG, "HTTP 重定向次数过多");
        return false;
    }
    int read(uint8_t* buf, size_t len) override {
        if (!h) return -1;
        const int n = esp_http_client_read(h, reinterpret_cast<char*>(buf), static_cast<int>(len));
        return n;  // 0=EOF, <0=错误
    }
};

bool looks_like_http(const std::string& s) {
    return s.rfind("http://", 0) == 0 || s.rfind("https://", 0) == 0;
}

enum class Fmt { UNKNOWN, WAV, MP3 };

Fmt sniff(const uint8_t* d, size_t n, const std::string& src) {
    if (n >= 4 && memcmp(d, "RIFF", 4) == 0) return Fmt::WAV;
    if (n >= 3 && memcmp(d, "ID3", 3) == 0) return Fmt::MP3;
    if (n >= 2 && d[0] == 0xFF && (d[1] & 0xE0) == 0xE0) return Fmt::MP3;
    // 兜底按扩展名
    const auto dot = src.find_last_of('.');
    if (dot != std::string::npos) {
        std::string ext = src.substr(dot + 1);
        for (auto& c : ext) c = static_cast<char>(tolower(c));
        if (ext == "wav") return Fmt::WAV;
        if (ext.rfind("mp3", 0) == 0) return Fmt::MP3;
    }
    return Fmt::UNKNOWN;
}

bool mp3_decoder_registered() {
    static bool done = false;
    if (!done) {
        done = esp_audio_simple_dec_register_default() == ESP_AUDIO_ERR_OK;
    }
    return done;
}

}  // namespace

// ---------------- DecodeStream ----------------

DecodeStream::Ptr DecodeStream::open(const std::string& src, StartedCb on_started) {
    auto self = Ptr(new DecodeStream());
    self->src_ = src;
    self->started_cb_ = std::move(on_started);
    // 任务持有一份 shared_ptr,保证解码期间对象存活
    auto* holder = new Ptr(self);
    if (xTaskCreatePinnedToCore(task_tramp, "px_aud_dec", 8192, holder, CONFIG_PX_AUDIO_DECODE_PRIO,
                                nullptr, CONFIG_PX_AUDIO_TASK_CORE) != pdPASS) {
        delete holder;
        ESP_LOGE(TAG, "解码任务创建失败");
        return nullptr;
    }
    return self;
}

DecodeStream::~DecodeStream() = default;

void DecodeStream::abort() {
    abort_.store(true);
    if (ring_) ring_->stop();
}

void DecodeStream::task_tramp(void* arg) {
    auto* holder = static_cast<Ptr*>(arg);
    Ptr self = *holder;
    delete holder;
    self->task_main();
    self.reset();
    vTaskDelete(nullptr);
}

void DecodeStream::task_main() {
    esp_err_t err = ESP_FAIL;
    std::unique_ptr<Reader> rd;
    if (looks_like_http(src_)) {
        auto r = std::make_unique<HttpReader>();
        if (r->open(src_.c_str())) rd = std::move(r);
    } else {
        auto r = std::make_unique<FileReader>();
        if (r->open(src_.c_str())) rd = std::move(r);
        else ESP_LOGE(TAG, "无法打开文件: %s", src_.c_str());
    }

    if (rd && !abort_.load()) {
        pump(*rd, err);
    } else if (!rd) {
        err = ESP_ERR_NOT_FOUND;
    }

    if (!started_ok_) {
        // 头都没解析出来:通知失败
        if (started_cb_) started_cb_(err);
    } else if (ring_) {
        ring_->end();  // 正常/中途结束:声明 EOS,播完由混音器收尾
    }
    started_cb_ = nullptr;
}

bool DecodeStream::pump(Reader& rd, esp_err_t& err_out) {
    uint8_t probe[16];
    size_t got = 0;
    while (got < sizeof(probe)) {
        const int n = rd.read(probe + got, sizeof(probe) - got);
        if (n < 0) {
            err_out = ESP_FAIL;
            return false;
        }
        if (n == 0) break;
        got += static_cast<size_t>(n);
    }
    if (got < 4) {
        err_out = ESP_ERR_INVALID_SIZE;
        return false;
    }
    switch (sniff(probe, got, src_)) {
        case Fmt::WAV:
            return pump_wav(rd, probe, got, err_out);
        case Fmt::MP3:
            return pump_mp3(rd, probe, got, err_out);
        default:
            ESP_LOGE(TAG, "无法识别的音频格式: %s", src_.c_str());
            err_out = ESP_ERR_NOT_SUPPORTED;
            return false;
    }
}

bool DecodeStream::ring_write(const uint8_t* pcm, size_t len) {
    if (!ring_ || abort_.load()) return false;
    const size_t n = ring_->feed_blocking(pcm, len, kFeedTimeoutMs);
    return n == len;
}

bool DecodeStream::pump_wav(Reader& rd, const uint8_t* pre, size_t pre_len, esp_err_t& err_out) {
    WavStreamParser parser;
    bool write_fail = false;

    auto on_pcm = [this, &parser, &write_fail](const uint8_t* pcm, size_t len) {
        if (write_fail || abort_.load()) return;
        if (!ring_) return;  // 理论上 header_ready 后才有 data
        if (parser.info().bits == 16) {
            if (!ring_write(pcm, len)) write_fail = true;
        } else {
            // 8bit 无符号 → 16bit
            int16_t tmp[256];
            size_t i = 0;
            while (i < len && !write_fail) {
                size_t n = std::min(len - i, sizeof(tmp) / sizeof(tmp[0]));
                for (size_t k = 0; k < n; k++) {
                    tmp[k] = static_cast<int16_t>((static_cast<int>(pcm[i + k]) - 128) << 8);
                }
                if (!ring_write(reinterpret_cast<const uint8_t*>(tmp), n * 2)) write_fail = true;
                i += n;
            }
        }
    };

    auto* buf = static_cast<uint8_t*>(big_alloc(kReadChunk));
    if (!buf) {
        err_out = ESP_ERR_NO_MEM;
        return false;
    }

    bool ok = parser.push(pre, pre_len, on_pcm);
    while (ok && !abort_.load() && !write_fail) {
        if (parser.header_ready() && !ring_) {
            const auto& wi = parser.info();
            ring_ = PcmRingSource::create(wi.sample_rate, static_cast<uint8_t>(wi.channels),
                                          static_cast<size_t>(CONFIG_PX_AUDIO_DECODE_RING_KB) * 1024);
            if (!ring_) {
                err_out = ESP_ERR_NO_MEM;
                break;
            }
            started_ok_ = true;
            if (started_cb_) started_cb_(ESP_OK);
        }
        const int n = rd.read(buf, kReadChunk);
        if (n < 0) {
            err_out = ESP_FAIL;
            break;
        }
        if (n == 0) {  // EOF
            big_free(buf);
            if (!started_ok_) {
                err_out = parser.error() ? ESP_ERR_INVALID_ARG : ESP_ERR_INVALID_SIZE;
                return false;
            }
            return true;
        }
        ok = parser.push(buf, static_cast<size_t>(n), on_pcm);
    }
    big_free(buf);
    if (!ok) err_out = ESP_ERR_INVALID_ARG;
    return started_ok_;
}

bool DecodeStream::pump_mp3(Reader& rd, const uint8_t* pre, size_t pre_len, esp_err_t& err_out) {
    if (!mp3_decoder_registered()) {
        err_out = ESP_ERR_NOT_SUPPORTED;
        return false;
    }
    esp_audio_simple_dec_cfg_t cfg = {};
    cfg.dec_type = ESP_AUDIO_SIMPLE_DEC_TYPE_MP3;
    esp_audio_simple_dec_handle_t dec = nullptr;
    if (esp_audio_simple_dec_open(&cfg, &dec) != ESP_AUDIO_ERR_OK) {
        ESP_LOGE(TAG, "MP3 解码器打开失败");
        err_out = ESP_FAIL;
        return false;
    }

    auto* in_buf = static_cast<uint8_t*>(big_alloc(kReadChunk));
    size_t out_cap = 8192;
    auto* out_buf = static_cast<uint8_t*>(big_alloc(out_cap));
    bool ok = true;
    bool eof = false;

    // 先消化嗅探时预读的字节
    memcpy(in_buf, pre, pre_len);
    size_t in_len = pre_len;

    while (ok && !abort_.load()) {
        if (!eof && in_len < kReadChunk) {
            const int n = rd.read(in_buf + in_len, kReadChunk - in_len);
            if (n < 0) {
                err_out = ESP_FAIL;
                ok = false;
                break;
            }
            if (n == 0) eof = true;
            else in_len += static_cast<size_t>(n);
        }
        if (in_len == 0 && eof) break;

        esp_audio_simple_dec_raw_t raw = {};
        raw.buffer = in_buf;
        raw.len = static_cast<uint32_t>(in_len);
        raw.eos = eof;
        esp_audio_simple_dec_out_t frame = {};
        frame.buffer = out_buf;
        frame.len = static_cast<uint32_t>(out_cap);

        const esp_audio_err_t ret = esp_audio_simple_dec_process(dec, &raw, &frame);
        if (ret == ESP_AUDIO_ERR_BUFF_NOT_ENOUGH) {
            const size_t need = frame.needed_size > 0 ? frame.needed_size : out_cap * 2;
            auto* nb = static_cast<uint8_t*>(big_alloc(need));
            if (!nb) {
                err_out = ESP_ERR_NO_MEM;
                ok = false;
                break;
            }
            big_free(out_buf);
            out_buf = nb;
            out_cap = need;
            continue;
        }
        if (ret != ESP_AUDIO_ERR_OK) {
            ESP_LOGE(TAG, "MP3 解码错误: %d", ret);
            err_out = ESP_FAIL;
            ok = false;
            break;
        }

        if (frame.decoded_size > 0) {
            if (!ring_) {
                esp_audio_simple_dec_info_t info = {};
                esp_audio_simple_dec_get_info(dec, &info);
                if (info.sample_rate == 0 || info.channel == 0) {
                    err_out = ESP_FAIL;
                    ok = false;
                    break;
                }
                ring_ = PcmRingSource::create(info.sample_rate, static_cast<uint8_t>(info.channel),
                                              static_cast<size_t>(CONFIG_PX_AUDIO_DECODE_RING_KB) * 1024);
                if (!ring_) {
                    err_out = ESP_ERR_NO_MEM;
                    ok = false;
                    break;
                }
                started_ok_ = true;
                if (started_cb_) started_cb_(ESP_OK);
            }
            if (!ring_write(out_buf, frame.decoded_size)) {
                ok = ring_ && ring_->stopped();  // 被 stop 属正常中止
                break;
            }
        }

        // 移除已消耗的输入
        const uint32_t consumed = raw.consumed;
        if (consumed >= in_len) {
            in_len = 0;
        } else if (consumed > 0) {
            memmove(in_buf, in_buf + consumed, in_len - consumed);
            in_len -= consumed;
        } else if (frame.decoded_size == 0) {
            // 无消耗也无产出:数据不足,继续读;EOF 时退出防死循环
            if (eof) break;
        }
    }

    esp_audio_simple_dec_close(dec);
    big_free(in_buf);
    big_free(out_buf);
    if (!started_ok_ && ok) err_out = ESP_ERR_INVALID_SIZE;
    return started_ok_;
}

}  // namespace hal_audio
