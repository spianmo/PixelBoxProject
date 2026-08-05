/**
 * PixelBox voicechat — wakenet 唤醒词检测实现(Kconfig 条件编译)
 */
#include "wakeword.hpp"

#include <algorithm>
#include <cstring>

#include "esp_log.h"

#if CONFIG_PX_ENABLE_WAKEWORD
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "hal_audio/audio_source.hpp"
#include "model_path.h"
#endif

namespace voicechat {

static const char* TAG = "px.voice.wake";

#if CONFIG_PX_ENABLE_WAKEWORD

bool WakewordDetector::init() {
    if (inited_) return true;
    auto* models = esp_srmodel_init("model");
    if (!models) {
        ESP_LOGE(TAG, "esp-sr 模型分区加载失败(检查分区表 model 分区)");
        return false;
    }
    models_ = models;
    char* wn_name = esp_srmodel_filter(models, ESP_WN_PREFIX, nullptr);
    if (!wn_name) {
        ESP_LOGE(TAG, "未找到 wakenet 模型");
        return false;
    }
    const esp_wn_iface_t* iface = esp_wn_handle_from_name(wn_name);
    if (!iface) {
        ESP_LOGE(TAG, "wakenet 接口获取失败: %s", wn_name);
        return false;
    }
    model_iface_data_t* data = iface->create(wn_name, DET_MODE_90);
    if (!data) {
        ESP_LOGE(TAG, "wakenet 模型创建失败");
        return false;
    }
    iface_ = iface;
    model_data_ = data;
    chunk_size_ = static_cast<size_t>(iface->get_samp_chunksize(data));
    chunk_buf_ = static_cast<int16_t*>(hal_audio::big_alloc(chunk_size_ * 2));
    chunk_fill_ = 0;
    if (!chunk_buf_) {
        ESP_LOGE(TAG, "wakenet 缓冲分配失败");
        iface->destroy(data);
        model_data_ = nullptr;
        return false;
    }
    inited_ = true;
    ESP_LOGI(TAG, "唤醒词已启用: %s (chunk=%u)", wn_name, static_cast<unsigned>(chunk_size_));
    return true;
}

void WakewordDetector::deinit() {
    if (!inited_) return;
    inited_ = false;
    auto* iface = static_cast<const esp_wn_iface_t*>(iface_);
    if (iface && model_data_) iface->destroy(static_cast<model_iface_data_t*>(model_data_));
    model_data_ = nullptr;
    iface_ = nullptr;
    hal_audio::big_free(chunk_buf_);
    chunk_buf_ = nullptr;
}

bool WakewordDetector::feed(const int16_t* samples, size_t count) {
    if (!inited_) return false;
    auto* iface = static_cast<const esp_wn_iface_t*>(iface_);
    auto* data = static_cast<model_iface_data_t*>(model_data_);
    bool detected = false;
    size_t off = 0;
    while (off < count) {
        const size_t take = std::min(count - off, chunk_size_ - chunk_fill_);
        memcpy(chunk_buf_ + chunk_fill_, samples + off, take * 2);
        chunk_fill_ += take;
        off += take;
        if (chunk_fill_ == chunk_size_) {
            chunk_fill_ = 0;
            if (iface->detect(data, chunk_buf_) > 0) detected = true;
        }
    }
    return detected;
}

#else  // !CONFIG_PX_ENABLE_WAKEWORD

bool WakewordDetector::init() {
    ESP_LOGD(TAG, "唤醒词未编译(PX_ENABLE_WAKEWORD=n)");
    return false;
}

void WakewordDetector::deinit() {}

bool WakewordDetector::feed(const int16_t*, size_t) { return false; }

#endif

}  // namespace voicechat
