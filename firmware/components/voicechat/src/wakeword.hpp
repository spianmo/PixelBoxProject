/**
 * PixelBox voicechat — esp-sr wakenet 唤醒词检测(可选)
 *
 * Kconfig `PX_ENABLE_WAKEWORD` 条件编译,默认关闭:
 *   - esp-sr 为 voicechat 的常驻依赖(取舍见 idf_component.yml 注释),
 *     但仅在本开关开启时才引用其符号 → 关闭时链接器完全裁剪,零体积影响。
 *   - 开启需配合 `sdkconfig.wakeword`(切换含 model 分区的
 *     partitions_wakeword.csv + 选择 wn9 模型),见 firmware/README.md。
 *   - 关闭时本类退化为空实现(available() == false)。
 *
 * 线程模型(开启时):
 *   - wakenet 推理开销大(每 32ms chunk 约数 ms)且吃栈,不能在 4KB 栈的
 *     音频采集任务里跑 → 独立检测任务(8KB 栈,低优先级,绑到音频对侧核)。
 *   - 采集任务经 `feed()` 把 16kHz PCM 写入 StreamBuffer(满则丢帧,不阻塞
 *     采集);检测任务凑满模型 chunk 后跑 detect,命中置原子标志。
 *   - `feed()` 返回值即"自上次调用以来是否命中"(原子交换取走),引擎在
 *     采集线程侧消费 → 检测任务从不反向锁引擎互斥量,deinit() join 无死锁。
 */
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

#include "sdkconfig.h"

#if CONFIG_PX_ENABLE_WAKEWORD
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#endif

namespace voicechat {

class WakewordDetector {
public:
    ~WakewordDetector() { deinit(); }

    /**
     * 初始化 wakenet:加载 model 分区 → 创建模型(大块 PSRAM 工作区)→
     * 启动检测任务。任一步失败(分区缺失/PSRAM 不足/任务创建失败)返回
     * false 并完整回滚,调用方应降级为手动模式并上报 error 事件。
     * 未编译(PX_ENABLE_WAKEWORD=n)时恒返回 false。
     */
    bool init();
    void deinit();
    bool available() const { return inited_; }

    /**
     * 喂入 16kHz 单声道 PCM(采集任务上下文,非阻塞,缓冲满丢帧);
     * 返回自上次调用以来检测任务是否命中过唤醒词(单次触发)。
     */
    bool feed(const int16_t* samples, size_t count);

    /** 丢弃未消费的命中标志(会话结束回 idle 时调用,防陈旧触发) */
    void clear_pending();

private:
    bool inited_ = false;
#if CONFIG_PX_ENABLE_WAKEWORD
    void detect_main();
    void deinit_partial_();

    const void* iface_ = nullptr;              // esp_wn_iface_t*
    void* model_data_ = nullptr;               // model_iface_data_t*
    void* models_ = nullptr;                   // srmodel_list_t*
    int16_t* chunk_buf_ = nullptr;             // 模型 chunk 组包缓冲
    size_t chunk_size_ = 0;                    // 模型要求的每次样本数
    StreamBufferHandle_t sb_ = nullptr;        // 采集→检测 PCM 流缓冲
    TaskHandle_t task_ = nullptr;
    SemaphoreHandle_t task_done_ = nullptr;    // 检测任务退出信号
    std::atomic<bool> run_{false};
    std::atomic<bool> detected_{false};
    int64_t last_drop_warn_us_ = 0;
#endif
};

}  // namespace voicechat
