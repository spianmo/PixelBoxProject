/**
 * camera_hal.hpp — OV2640 DVP 摄像头封装(esp32-camera, Kconfig PX_ENABLE_CAMERA)
 *
 * 所有耗时操作(init/capture/stream)在内部工作任务执行, 完成后经调用方
 * 提供的回调返回(回调在工作任务上下文, bindings 负责投递到 JS 线程)。
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>

#include "esp_err.h"

namespace hal_periph {

enum class CamResolution : uint8_t { QQVGA, QVGA, VGA, SVGA, XGA, P720 };
enum class CamFormat : uint8_t { Jpeg, Rgb565 };

struct CamFrame {
    uint8_t* data;  ///< heap_caps 分配(PSRAM 优先), 接收方负责 heap_caps_free
    size_t len;
};

/** 编译期是否启用摄像头 */
bool camera_available();

/** 异步初始化;done(err) 在工作任务回调, ESP_OK 表示成功 */
esp_err_t camera_init_async(CamResolution res, int jpeg_quality, CamFormat fmt,
                            std::function<void(esp_err_t)> done);

/** 异步拍一帧;done(frame, err):err==ESP_OK 时 frame.data 有效(接收方释放) */
esp_err_t camera_capture_async(std::function<void(CamFrame, esp_err_t)> done);

/**
 * 启动连续取流;on_frame 在工作任务回调。
 * 内部背压:若 busy 标志被置位(上一帧还未被 JS 消费), 该帧丢弃。
 * @param busy  由 bindings 维护的原子标志(可为空 = 不做背压)
 */
esp_err_t camera_start_stream(uint8_t fps, std::function<void(CamFrame)> on_frame,
                              std::atomic<bool>* busy);

void camera_stop_stream();

/** 异步反初始化 */
void camera_deinit_async(std::function<void()> done);

/** 是否已完成 init */
bool camera_inited();

}  // namespace hal_periph
