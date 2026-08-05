/**
 * PixelBox voicechat — esp-sr wakenet 唤醒词检测(可选)
 *
 * Kconfig `PX_ENABLE_WAKEWORD` 条件编译,默认关闭:
 *   - 开启前需手动为 voicechat 添加 espressif/esp-sr 组件依赖,
 *     并在分区表中放置模型分区(model),详见组件 README。
 *   - 关闭时本类退化为空实现(available() == false)。
 */
#pragma once

#include <cstddef>
#include <cstdint>

#include "sdkconfig.h"

namespace voicechat {

class WakewordDetector {
public:
    ~WakewordDetector() { deinit(); }

    /** 初始化 wakenet 模型;失败/未编译返回 false */
    bool init();
    void deinit();
    bool available() const { return inited_; }

    /**
     * 喂入 16kHz 单声道 PCM,内部按模型 chunk 缓冲;
     * 检测到唤醒词返回 true(单次触发)。
     */
    bool feed(const int16_t* samples, size_t count);

private:
    bool inited_ = false;
#if CONFIG_PX_ENABLE_WAKEWORD
    void* model_data_ = nullptr;      // model_iface_data_t*
    const void* iface_ = nullptr;     // esp_wn_iface_t*
    void* models_ = nullptr;          // srmodel_list_t*
    int16_t* chunk_buf_ = nullptr;
    size_t chunk_size_ = 0;           // 模型要求的每次样本数
    size_t chunk_fill_ = 0;
#endif
};

}  // namespace voicechat
