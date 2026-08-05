/**
 * PixelBox voicechat — wakenet 唤醒词检测实现(Kconfig 条件编译)
 *
 * esp-sr v2 真实 API 路径:
 *   esp_srmodel_init("model")  → mmap 模型分区(srmodels.bin,esp-sr 构建
 *                                系统由 menuconfig 所选模型打包生成)
 *   esp_srmodel_filter(wn 前缀) → 取第一个 wakenet 模型名(如 wn9_hilexin)
 *   esp_wn_handle_from_name    → 模型接口表 → create/detect/destroy
 */
#include "wakeword.hpp"

#include <algorithm>
#include <cstring>

#include "esp_log.h"

#if CONFIG_PX_ENABLE_WAKEWORD
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "hal_audio/audio_source.hpp"
#include "model_path.h"
#endif

namespace voicechat {

static const char* TAG = "px.voice.wake";

#if CONFIG_PX_ENABLE_WAKEWORD

namespace {
// wakenet 工作区为大块 PSRAM(wn9 约 500KB 量级);esp-sr 内部分配失败
// 可能直接 abort,故 create 前先做保守的最大连续空闲块预检,不足则优雅降级。
constexpr size_t kMinPsramFreeBlock = 640 * 1024;
// 采集→检测任务的 PCM 流缓冲:约 128ms @16k(4 个 wn9 chunk),满则丢帧
constexpr size_t kStreamBufBytes = 4096;
// 检测任务:推理吃栈(8KB)、低优先级、绑到音频对侧核,避免抢占采集/混音
constexpr uint32_t kDetectTaskStack = 8192;
constexpr UBaseType_t kDetectTaskPrio = 5;
constexpr BaseType_t kDetectTaskCore = 1 - CONFIG_PX_AUDIO_TASK_CORE;
}  // namespace

bool WakewordDetector::init() {
    if (inited_) return true;

    // 1) PSRAM 预检(见上)
    const size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
    if (largest < kMinPsramFreeBlock) {
        ESP_LOGE(TAG, "PSRAM 不足(最大连续块 %u < %u),唤醒词降级关闭",
                 static_cast<unsigned>(largest), static_cast<unsigned>(kMinPsramFreeBlock));
        return false;
    }

    // 2) mmap 模型分区(partitions_wakeword.csv 的 model 分区)
    auto* models = esp_srmodel_init("model");
    if (!models) {
        ESP_LOGE(TAG, "esp-sr 模型分区加载失败(需用 sdkconfig.wakeword 构建并烧录 model 分区)");
        return false;
    }
    models_ = models;
    char* wn_name = esp_srmodel_filter(models, ESP_WN_PREFIX, nullptr);
    if (!wn_name) {
        ESP_LOGE(TAG, "model 分区中未找到 wakenet 模型(检查 menuconfig 模型选择)");
        deinit_partial_();
        return false;
    }
    const esp_wn_iface_t* iface = esp_wn_handle_from_name(wn_name);
    if (!iface) {
        ESP_LOGE(TAG, "wakenet 接口获取失败: %s", wn_name);
        deinit_partial_();
        return false;
    }
    model_iface_data_t* data = iface->create(wn_name, DET_MODE_90);
    if (!data) {
        ESP_LOGE(TAG, "wakenet 模型创建失败(PSRAM 工作区分配失败?)");
        deinit_partial_();
        return false;
    }
    iface_ = iface;
    model_data_ = data;
    chunk_size_ = static_cast<size_t>(iface->get_samp_chunksize(data));

    // 3) 组包缓冲 + 流缓冲 + 检测任务
    chunk_buf_ = static_cast<int16_t*>(hal_audio::big_alloc(chunk_size_ * sizeof(int16_t)));
    sb_ = chunk_buf_ ? xStreamBufferCreate(kStreamBufBytes, 1) : nullptr;
    task_done_ = sb_ ? xSemaphoreCreateBinary() : nullptr;
    bool task_ok = false;
    if (task_done_) {
        run_.store(true);
        detected_.store(false);
        task_ok = xTaskCreatePinnedToCore(
                      [](void* arg) { static_cast<WakewordDetector*>(arg)->detect_main(); },
                      "px_wakenet", kDetectTaskStack, this, kDetectTaskPrio, &task_,
                      kDetectTaskCore) == pdPASS;
    }
    if (!task_ok) {
        ESP_LOGE(TAG, "wakenet 检测任务/缓冲创建失败");
        run_.store(false);
        deinit_partial_();
        return false;
    }
    inited_ = true;
    ESP_LOGI(TAG, "唤醒词已启用: %s (chunk=%u, PSRAM 余 %u KB)", wn_name,
             static_cast<unsigned>(chunk_size_),
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
    return true;
}

/** init 失败中途回滚 / deinit 公共收尾(不含检测任务停止) */
void WakewordDetector::deinit_partial_() {
    auto* iface = static_cast<const esp_wn_iface_t*>(iface_);
    if (iface && model_data_) iface->destroy(static_cast<model_iface_data_t*>(model_data_));
    model_data_ = nullptr;
    iface_ = nullptr;
    if (models_) {
        esp_srmodel_deinit(static_cast<srmodel_list_t*>(models_));
        models_ = nullptr;
    }
    hal_audio::big_free(chunk_buf_);
    chunk_buf_ = nullptr;
    if (sb_) {
        vStreamBufferDelete(sb_);
        sb_ = nullptr;
    }
    if (task_done_) {
        vSemaphoreDelete(task_done_);
        task_done_ = nullptr;
    }
    chunk_size_ = 0;
}

void WakewordDetector::deinit() {
    if (!inited_) return;
    inited_ = false;
    // 先停检测任务(它从不锁引擎互斥量,持锁 join 安全)
    run_.store(false);
    if (task_) {
        xSemaphoreTake(task_done_, pdMS_TO_TICKS(1000));
        task_ = nullptr;
    }
    deinit_partial_();
    detected_.store(false);
    ESP_LOGI(TAG, "唤醒词已停止,工作区已释放");
}

bool WakewordDetector::feed(const int16_t* samples, size_t count) {
    if (!inited_) return false;
    // 非阻塞入流:检测任务积压时丢最新帧(唤醒场景可容忍,绝不拖慢采集)
    const size_t bytes = count * sizeof(int16_t);
    const size_t sent = xStreamBufferSend(sb_, samples, bytes, 0);
    if (sent < bytes) {
        const int64_t now = esp_timer_get_time();
        if (now - last_drop_warn_us_ > 5000000) {
            last_drop_warn_us_ = now;
            ESP_LOGW(TAG, "wakenet 推理积压,丢弃 %u 字节拾音",
                     static_cast<unsigned>(bytes - sent));
        }
    }
    return detected_.exchange(false);
}

void WakewordDetector::clear_pending() {
    detected_.store(false);
}

/** 检测任务主循环:凑满模型 chunk → detect,命中置原子标志 */
void WakewordDetector::detect_main() {
    auto* iface = static_cast<const esp_wn_iface_t*>(iface_);
    auto* data = static_cast<model_iface_data_t*>(model_data_);
    size_t fill_bytes = 0;
    const size_t chunk_bytes = chunk_size_ * sizeof(int16_t);
    auto* raw = reinterpret_cast<uint8_t*>(chunk_buf_);
    while (run_.load()) {
        const size_t got = xStreamBufferReceive(sb_, raw + fill_bytes,
                                                chunk_bytes - fill_bytes, pdMS_TO_TICKS(100));
        fill_bytes += got;
        if (fill_bytes < chunk_bytes) continue;
        fill_bytes = 0;
        if (iface->detect(data, chunk_buf_) > 0) {
            ESP_LOGI(TAG, "wakenet 命中");
            detected_.store(true);
        }
    }
    xSemaphoreGive(task_done_);
    vTaskDelete(nullptr);
}

#else  // !CONFIG_PX_ENABLE_WAKEWORD

bool WakewordDetector::init() {
    ESP_LOGD(TAG, "唤醒词未编译(PX_ENABLE_WAKEWORD=n)");
    return false;
}

void WakewordDetector::deinit() {}

bool WakewordDetector::feed(const int16_t*, size_t) { return false; }

void WakewordDetector::clear_pending() {}

#endif

}  // namespace voicechat
