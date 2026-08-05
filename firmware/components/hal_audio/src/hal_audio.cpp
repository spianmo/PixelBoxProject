/**
 * PixelBox hal_audio — 核心实现
 *
 *   ES8311 (esp_codec_dev) + I2S std 双工
 *   采集任务:10ms 块读取 → fan-out 给订阅者
 *   播放任务:多源重采样混音 → codec 写入
 */
#include "hal_audio/hal_audio.hpp"

#include <cstring>
#include <mutex>
#include <utility>
#include <vector>

#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hal_common/board.h"
#include "sdkconfig.h"

namespace hal_audio {

static const char* TAG = "hal_audio";

namespace {

constexpr int kChunkMs = 10;          // 采集/混音块时长
constexpr uint32_t kMaxRate = 48000;  // 支持的最高设备采样率(缓冲按此预留)

struct State {
    bool ready = false;
    Config cfg;

    i2s_chan_handle_t tx = nullptr;
    i2s_chan_handle_t rx = nullptr;
    const audio_codec_data_if_t* data_if = nullptr;
    const audio_codec_ctrl_if_t* ctrl_if = nullptr;
    const audio_codec_gpio_if_t* gpio_if = nullptr;
    const audio_codec_if_t* codec_if = nullptr;
    esp_codec_dev_handle_t dev = nullptr;

    uint32_t rate = 16000;
    int volume = 70;
    int mic_gain = 70;

    // mic fan-out
    std::mutex mic_mtx;
    std::vector<std::pair<int, MicSink>> sinks;
    int next_sink_id = 1;
    uint32_t sinks_version = 0;
    volatile bool cap_run = false;
    TaskHandle_t cap_task = nullptr;
    SemaphoreHandle_t cap_done = nullptr;

    // player
    std::mutex ply_mtx;
    std::vector<std::shared_ptr<Source>> sources;
    TaskHandle_t ply_task = nullptr;
    volatile bool ply_run = false;
    SemaphoreHandle_t ply_done = nullptr;
};

State s;

// ---------------- 采集任务 ----------------

void capture_task(void*) {
    const size_t max_chunk = kMaxRate / 1000 * kChunkMs;
    auto* buf = static_cast<int16_t*>(heap_caps_malloc(max_chunk * 2, MALLOC_CAP_8BIT));
    // 本地快照,避免每次拷贝 std::function 列表
    std::vector<std::pair<int, MicSink>> snapshot;
    uint32_t seen_version = UINT32_MAX;

    while (s.cap_run) {
        const size_t chunk = s.rate / 1000 * kChunkMs;  // 设备率可能被重配,逐次计算
        if (!buf) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        const int err = esp_codec_dev_read(s.dev, buf, chunk * 2);
        if (err != ESP_CODEC_DEV_OK) {
            ESP_LOGW(TAG, "codec 读取失败: %d", err);
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        {
            std::lock_guard<std::mutex> lk(s.mic_mtx);
            if (seen_version != s.sinks_version) {
                snapshot = s.sinks;
                seen_version = s.sinks_version;
            }
        }
        for (auto& kv : snapshot) {
            if (kv.second) kv.second(buf, chunk);
        }
    }
    heap_caps_free(buf);
    xSemaphoreGive(s.cap_done);
    vTaskDelete(nullptr);
}

void start_capture_locked() {
    if (s.cap_run) return;
    if (s.cap_task) {
        // 上一个采集任务尚未收尾(自停路径),等它退出
        xSemaphoreTake(s.cap_done, pdMS_TO_TICKS(1000));
        s.cap_task = nullptr;
    }
    s.cap_run = true;
    const BaseType_t ok = xTaskCreatePinnedToCore(capture_task, "px_aud_cap", 4096, nullptr,
                                                  CONFIG_PX_AUDIO_CAPTURE_PRIO, &s.cap_task,
                                                  CONFIG_PX_AUDIO_TASK_CORE);
    if (ok != pdPASS) {
        s.cap_run = false;
        s.cap_task = nullptr;
        ESP_LOGE(TAG, "采集任务创建失败");
    }
}

void stop_capture() {
    if (!s.cap_run && !s.cap_task) return;
    s.cap_run = false;
    // 从采集回调内部触发的停止(如 record 到时长后取消订阅):
    // 不能在自身任务里等退出信号,返回后任务自然退出并给信号
    if (xTaskGetCurrentTaskHandle() == s.cap_task) return;
    xSemaphoreTake(s.cap_done, pdMS_TO_TICKS(1000));
    s.cap_task = nullptr;
}

// ---------------- 播放(混音)任务 ----------------

void playback_task(void*) {
    const size_t max_chunk = kMaxRate / 1000 * kChunkMs;
    auto* acc = static_cast<int32_t*>(heap_caps_malloc(max_chunk * 4, MALLOC_CAP_8BIT));
    auto* tmp = static_cast<int16_t*>(heap_caps_malloc(max_chunk * 2, MALLOC_CAP_8BIT));
    auto* out = static_cast<int16_t*>(heap_caps_malloc(max_chunk * 2, MALLOC_CAP_8BIT));
    std::vector<std::shared_ptr<Source>> local;
    std::vector<std::shared_ptr<Source>> done;

    while (s.ply_run) {
        const size_t chunk = s.rate / 1000 * kChunkMs;  // 设备率可能被重配,逐次计算
        if (!acc || !tmp || !out) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        {
            std::lock_guard<std::mutex> lk(s.ply_mtx);
            local = s.sources;
        }
        if (local.empty()) {
            // 写一小段静音让 DMA 收尾,然后休眠等待新源
            memset(out, 0, chunk * 2);
            esp_codec_dev_write(s.dev, out, chunk * 2);
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }

        memset(acc, 0, chunk * 4);
        done.clear();
        for (auto& src : local) {
            if (src->finished()) {
                done.push_back(src);
                continue;
            }
            if (src->paused()) continue;
            auto& rs = src->mixer_resampler();
            if (rs.src_rate() != src->sample_rate() || rs.dst_rate() != s.rate) {
                rs.reset(src->sample_rate(), s.rate);
            }
            Source* raw = src.get();
            const size_t n = rs.produce(tmp, chunk, [raw](int16_t* b, size_t m) {
                return raw->pull(b, m);
            });
            const float g = src->gain();
            for (size_t i = 0; i < n; i++) {
                acc[i] += static_cast<int32_t>(tmp[i] * g);
            }
            if (src->finished()) done.push_back(src);
        }
        for (size_t i = 0; i < chunk; i++) {
            int32_t v = acc[i];
            if (v > 32767) v = 32767;
            if (v < -32768) v = -32768;
            out[i] = static_cast<int16_t>(v);
        }
        esp_codec_dev_write(s.dev, out, chunk * 2);

        if (!done.empty()) {
            {
                std::lock_guard<std::mutex> lk(s.ply_mtx);
                for (auto& d : done) {
                    for (auto it = s.sources.begin(); it != s.sources.end(); ++it) {
                        if (*it == d) {
                            s.sources.erase(it);
                            break;
                        }
                    }
                    d->set_attached(false);
                }
            }
            for (auto& d : done) d->fire_finished();
        }
        local.clear();
    }
    heap_caps_free(acc);
    heap_caps_free(tmp);
    heap_caps_free(out);
    xSemaphoreGive(s.ply_done);
    vTaskDelete(nullptr);
}

esp_err_t open_codec(uint32_t rate) {
    esp_codec_dev_sample_info_t fs = {};
    fs.bits_per_sample = 16;
    fs.channel = 1;
    fs.channel_mask = 0;
    fs.sample_rate = rate;
    const int err = esp_codec_dev_open(s.dev, &fs);
    if (err != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "codec 打开失败: %d (rate=%u)", err, static_cast<unsigned>(rate));
        return ESP_FAIL;
    }
    return ESP_OK;
}

/** 共享 I2C 总线 RAII 锁(codec 控制寄存器读写期间持有) */
struct BoardI2cLock {
    bool locked;
    BoardI2cLock() : locked(board_i2c_lock(1000) == ESP_OK) {
        if (!locked) ESP_LOGW(TAG, "I2C 总线锁获取超时");
    }
    ~BoardI2cLock() {
        if (locked) board_i2c_unlock();
    }
};

}  // namespace

// ---------------- 公开接口 ----------------

esp_err_t init_from_board() {
    const board_caps_t* caps = board_caps();
    if (!caps->mic && !caps->speaker) return ESP_ERR_NOT_SUPPORTED;
    const board_audio_config_t* a = board_audio_config();
    Config cfg;
    cfg.i2s_port = a->i2s_port;
    cfg.pin_mclk = a->pin_mclk;
    cfg.pin_bclk = a->pin_bclk;
    cfg.pin_ws = a->pin_ws;
    cfg.pin_dout = a->pin_dout;
    cfg.pin_din = a->pin_din;
    cfg.pin_pa = a->pin_pa_enable;
    cfg.i2c_addr = a->es8311_addr;
    cfg.i2c_bus_handle = board_i2c_bus();
    cfg.i2c_port = board_i2c_config()->port;
    cfg.use_mclk = a->pin_mclk >= 0;
    return init(cfg);
}

esp_err_t init(const Config& cfg) {
    if (s.ready) return ESP_ERR_INVALID_STATE;
    s.cfg = cfg;
    s.rate = cfg.sample_rate ? cfg.sample_rate : 16000;

    // 1) I2S std 双工通道
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(static_cast<i2s_port_t>(cfg.i2s_port),
                                                            I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&chan_cfg, &s.tx, &s.rx), TAG, "i2s 通道创建失败");

    i2s_std_config_t std_cfg = {};
    std_cfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(s.rate);
    std_cfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                           I2S_SLOT_MODE_MONO);
    std_cfg.gpio_cfg.mclk = cfg.use_mclk ? static_cast<gpio_num_t>(cfg.pin_mclk) : I2S_GPIO_UNUSED;
    std_cfg.gpio_cfg.bclk = static_cast<gpio_num_t>(cfg.pin_bclk);
    std_cfg.gpio_cfg.ws = static_cast<gpio_num_t>(cfg.pin_ws);
    std_cfg.gpio_cfg.dout = static_cast<gpio_num_t>(cfg.pin_dout);
    std_cfg.gpio_cfg.din = static_cast<gpio_num_t>(cfg.pin_din);
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s.tx, &std_cfg), TAG, "i2s tx 初始化失败");
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s.rx, &std_cfg), TAG, "i2s rx 初始化失败");

    // 2) esp_codec_dev 接口对象
    audio_codec_i2s_cfg_t i2s_if_cfg = {};
    i2s_if_cfg.port = static_cast<uint8_t>(cfg.i2s_port);
    i2s_if_cfg.rx_handle = s.rx;
    i2s_if_cfg.tx_handle = s.tx;
    s.data_if = audio_codec_new_i2s_data(&i2s_if_cfg);

    audio_codec_i2c_cfg_t i2c_if_cfg = {};
    i2c_if_cfg.port = static_cast<uint8_t>(cfg.i2c_port);
    i2c_if_cfg.addr = cfg.i2c_addr << 1;  // esp_codec_dev 使用 8bit 写地址
    i2c_if_cfg.bus_handle = cfg.i2c_bus_handle;
    s.ctrl_if = audio_codec_new_i2c_ctrl(&i2c_if_cfg);

    s.gpio_if = audio_codec_new_gpio();
    if (!s.data_if || !s.ctrl_if || !s.gpio_if) {
        ESP_LOGE(TAG, "codec 接口创建失败");
        return ESP_FAIL;
    }

    // 3) ES8311(控制走共享 I2C 总线,寄存器配置期间持锁)
    BoardI2cLock i2c_lk;
    es8311_codec_cfg_t es_cfg = {};
    es_cfg.ctrl_if = s.ctrl_if;
    es_cfg.gpio_if = s.gpio_if;
    es_cfg.codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH;
    es_cfg.pa_pin = static_cast<int16_t>(cfg.pin_pa);
    es_cfg.use_mclk = cfg.use_mclk;
    es_cfg.hw_gain.pa_voltage = 5.0f;
    es_cfg.hw_gain.codec_dac_voltage = 3.3f;
    es_cfg.hw_gain.pa_gain = 0.0f;
    s.codec_if = es8311_codec_new(&es_cfg);
    if (!s.codec_if) {
        ESP_LOGE(TAG, "ES8311 初始化失败(检查 I2C 总线/地址)");
        return ESP_FAIL;
    }

    esp_codec_dev_cfg_t dev_cfg = {};
    dev_cfg.dev_type = ESP_CODEC_DEV_TYPE_IN_OUT;
    dev_cfg.codec_if = s.codec_if;
    dev_cfg.data_if = s.data_if;
    s.dev = esp_codec_dev_new(&dev_cfg);
    if (!s.dev) {
        ESP_LOGE(TAG, "esp_codec_dev 创建失败");
        return ESP_FAIL;
    }

    ESP_RETURN_ON_ERROR(open_codec(s.rate), TAG, "codec open 失败");
    esp_codec_dev_set_out_vol(s.dev, s.volume);
    esp_codec_dev_set_in_gain(s.dev, s.mic_gain * 0.42f);

    // 4) 任务与同步原语
    s.cap_done = xSemaphoreCreateBinary();
    s.ply_done = xSemaphoreCreateBinary();
    s.ply_run = true;
    if (xTaskCreatePinnedToCore(playback_task, "px_aud_mix", 6144, nullptr,
                                CONFIG_PX_AUDIO_PLAYBACK_PRIO, &s.ply_task,
                                CONFIG_PX_AUDIO_TASK_CORE) != pdPASS) {
        ESP_LOGE(TAG, "播放任务创建失败");
        s.ply_run = false;
        return ESP_FAIL;
    }

    s.ready = true;
    ESP_LOGI(TAG, "音频就绪: %u Hz 单声道 16bit, 音量 %d", static_cast<unsigned>(s.rate), s.volume);
    return ESP_OK;
}

esp_err_t deinit() {
    if (!s.ready) return ESP_ERR_INVALID_STATE;
    s.ready = false;
    stop_capture();
    player_stop_all();
    if (s.ply_run) {
        s.ply_run = false;
        xTaskNotifyGive(s.ply_task);
        xSemaphoreTake(s.ply_done, pdMS_TO_TICKS(1000));
        s.ply_task = nullptr;
    }
    if (s.dev) {
        esp_codec_dev_close(s.dev);
        esp_codec_dev_delete(s.dev);
        s.dev = nullptr;
    }
    if (s.codec_if) { audio_codec_delete_codec_if(s.codec_if); s.codec_if = nullptr; }
    if (s.ctrl_if) { audio_codec_delete_ctrl_if(s.ctrl_if); s.ctrl_if = nullptr; }
    if (s.gpio_if) { audio_codec_delete_gpio_if(s.gpio_if); s.gpio_if = nullptr; }
    if (s.data_if) { audio_codec_delete_data_if(s.data_if); s.data_if = nullptr; }
    if (s.tx) { i2s_del_channel(s.tx); s.tx = nullptr; }
    if (s.rx) { i2s_del_channel(s.rx); s.rx = nullptr; }
    return ESP_OK;
}

bool ready() { return s.ready; }

uint32_t device_rate() { return s.rate; }

esp_err_t set_device_rate(uint32_t rate) {
    if (!s.ready) return ESP_ERR_INVALID_STATE;
    if (mic_running() || player_active()) return ESP_ERR_INVALID_STATE;
    if (rate == s.rate) return ESP_OK;
    BoardI2cLock i2c_lk;
    esp_codec_dev_close(s.dev);
    const esp_err_t err = open_codec(rate);
    if (err == ESP_OK) {
        s.rate = rate;
        esp_codec_dev_set_out_vol(s.dev, s.volume);
        esp_codec_dev_set_in_gain(s.dev, s.mic_gain * 0.42f);
    } else {
        open_codec(s.rate);  // 尝试恢复
    }
    return err;
}

void set_volume(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    s.volume = percent;
    if (s.ready) {
        BoardI2cLock i2c_lk;
        esp_codec_dev_set_out_vol(s.dev, percent);
    }
}

int get_volume() { return s.volume; }

void set_mic_gain(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    s.mic_gain = percent;
    // 0-100% 线性映射到 0-42dB ADC 增益
    if (s.ready) {
        BoardI2cLock i2c_lk;
        esp_codec_dev_set_in_gain(s.dev, percent * 0.42f);
    }
}

int get_mic_gain() { return s.mic_gain; }

int mic_subscribe(MicSink sink) {
    if (!s.ready || !sink) return -1;
    std::lock_guard<std::mutex> lk(s.mic_mtx);
    const int id = s.next_sink_id++;
    s.sinks.emplace_back(id, std::move(sink));
    s.sinks_version++;
    start_capture_locked();
    return id;
}

void mic_unsubscribe(int id) {
    bool empty = false;
    {
        std::lock_guard<std::mutex> lk(s.mic_mtx);
        for (auto it = s.sinks.begin(); it != s.sinks.end(); ++it) {
            if (it->first == id) {
                s.sinks.erase(it);
                break;
            }
        }
        s.sinks_version++;
        empty = s.sinks.empty();
    }
    if (empty) stop_capture();
}

bool mic_running() { return s.cap_run; }

esp_err_t player_add(const std::shared_ptr<Source>& src) {
    if (!s.ready || !src) return ESP_ERR_INVALID_STATE;
    {
        std::lock_guard<std::mutex> lk(s.ply_mtx);
        for (auto& e : s.sources) {
            if (e == src) return ESP_ERR_INVALID_STATE;
        }
        src->set_attached(true);
        s.sources.push_back(src);
    }
    if (s.ply_task) xTaskNotifyGive(s.ply_task);
    return ESP_OK;
}

void player_stop_all() {
    std::vector<std::shared_ptr<Source>> snapshot;
    {
        std::lock_guard<std::mutex> lk(s.ply_mtx);
        snapshot = s.sources;
    }
    for (auto& e : snapshot) e->stop();
    if (s.ply_task) xTaskNotifyGive(s.ply_task);
}

bool player_active() {
    std::lock_guard<std::mutex> lk(s.ply_mtx);
    return !s.sources.empty();
}

}  // namespace hal_audio
