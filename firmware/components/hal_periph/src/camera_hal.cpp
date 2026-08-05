/**
 * camera_hal.cpp — OV2640 DVP 摄像头实现(工作任务 + 命令队列)
 */
#include "hal_periph/camera_hal.hpp"

#include <atomic>
#include <cstring>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hal_common/board.h"
#include "sdkconfig.h"

#if CONFIG_PX_ENABLE_CAMERA
#include "esp_camera.h"
#endif

[[maybe_unused]] static const char* TAG = "px.cam";

namespace hal_periph {

#if CONFIG_PX_ENABLE_CAMERA

namespace {

enum class CmdType : uint8_t { Init, Capture, Deinit, Stop };

struct Cmd {
    CmdType type;
    // Init 参数
    CamResolution res;
    int quality;
    CamFormat fmt;
    // 回调(堆分配 std::function 指针, 队列只能传 POD)
    void* fn;
};

QueueHandle_t s_queue = nullptr;
TaskHandle_t s_task = nullptr;
std::atomic<bool> s_inited{false};
std::atomic<bool> s_streaming{false};
std::atomic<uint8_t> s_stream_fps{10};
std::function<void(CamFrame)> s_stream_cb;  // 仅工作任务读, 启停前后设置
std::atomic<bool>* s_stream_busy = nullptr;

framesize_t to_framesize(CamResolution r) {
    switch (r) {
        case CamResolution::QQVGA: return FRAMESIZE_QQVGA;
        case CamResolution::QVGA: return FRAMESIZE_QVGA;
        case CamResolution::VGA: return FRAMESIZE_VGA;
        case CamResolution::SVGA: return FRAMESIZE_SVGA;
        case CamResolution::XGA: return FRAMESIZE_XGA;
        case CamResolution::P720: return FRAMESIZE_HD;
    }
    return FRAMESIZE_QVGA;
}

esp_err_t do_init(const Cmd& c) {
    camera_config_t cfg = {};
    cfg.pin_xclk = CONFIG_PX_CAM_PIN_XCLK;
    cfg.pin_pclk = CONFIG_PX_CAM_PIN_PCLK;
    cfg.pin_vsync = CONFIG_PX_CAM_PIN_VSYNC;
    cfg.pin_href = CONFIG_PX_CAM_PIN_HREF;
    cfg.pin_sccb_sda = CONFIG_PX_CAM_PIN_SIOD;
    cfg.pin_sccb_scl = CONFIG_PX_CAM_PIN_SIOC;
    cfg.pin_d0 = CONFIG_PX_CAM_PIN_D0;
    cfg.pin_d1 = CONFIG_PX_CAM_PIN_D1;
    cfg.pin_d2 = CONFIG_PX_CAM_PIN_D2;
    cfg.pin_d3 = CONFIG_PX_CAM_PIN_D3;
    cfg.pin_d4 = CONFIG_PX_CAM_PIN_D4;
    cfg.pin_d5 = CONFIG_PX_CAM_PIN_D5;
    cfg.pin_d6 = CONFIG_PX_CAM_PIN_D6;
    cfg.pin_d7 = CONFIG_PX_CAM_PIN_D7;
    cfg.pin_pwdn = CONFIG_PX_CAM_PIN_PWDN;
    cfg.pin_reset = CONFIG_PX_CAM_PIN_RESET;
    cfg.xclk_freq_hz = 20000000;
    cfg.ledc_timer = LEDC_TIMER_1;
    cfg.ledc_channel = LEDC_CHANNEL_1;
    cfg.pixel_format = (c.fmt == CamFormat::Jpeg) ? PIXFORMAT_JPEG : PIXFORMAT_RGB565;
    cfg.frame_size = to_framesize(c.res);
    cfg.jpeg_quality = c.quality;
    cfg.fb_count = 2;                       // 双缓冲提升流畅度
    cfg.fb_location = CAMERA_FB_IN_PSRAM;   // 帧缓冲进 PSRAM
    cfg.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&cfg);
    if (err == ESP_OK) s_inited.store(true);
    return err;
}

/** 抓一帧并拷贝到 PSRAM 缓冲(fb 及时归还) */
esp_err_t grab_copy(CamFrame& out) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb == nullptr) return ESP_FAIL;
    uint8_t* buf = static_cast<uint8_t*>(
        heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (buf == nullptr) {
        buf = static_cast<uint8_t*>(heap_caps_malloc(fb->len, MALLOC_CAP_8BIT));
    }
    if (buf == nullptr) {
        esp_camera_fb_return(fb);
        return ESP_ERR_NO_MEM;
    }
    memcpy(buf, fb->buf, fb->len);
    out.data = buf;
    out.len = fb->len;
    esp_camera_fb_return(fb);
    return ESP_OK;
}

void cam_task(void*) {
    for (;;) {
        Cmd c;
        TickType_t wait = portMAX_DELAY;
        if (s_streaming.load()) {
            uint8_t fps = s_stream_fps.load();
            if (fps == 0) fps = 1;
            wait = pdMS_TO_TICKS(1000 / fps);
        }
        if (xQueueReceive(s_queue, &c, wait) == pdTRUE) {
            switch (c.type) {
                case CmdType::Init: {
                    auto* done = static_cast<std::function<void(esp_err_t)>*>(c.fn);
                    esp_err_t err = do_init(c);
                    if (done) {
                        (*done)(err);
                        delete done;
                    }
                    break;
                }
                case CmdType::Capture: {
                    auto* done = static_cast<std::function<void(CamFrame, esp_err_t)>*>(c.fn);
                    CamFrame f{nullptr, 0};
                    esp_err_t err = s_inited.load() ? grab_copy(f) : ESP_ERR_INVALID_STATE;
                    if (done) {
                        (*done)(f, err);
                        delete done;
                    } else if (f.data) {
                        heap_caps_free(f.data);
                    }
                    break;
                }
                case CmdType::Deinit: {
                    auto* done = static_cast<std::function<void()>*>(c.fn);
                    s_streaming.store(false);
                    if (s_inited.load()) {
                        esp_camera_deinit();
                        s_inited.store(false);
                    }
                    if (done) {
                        (*done)();
                        delete done;
                    }
                    break;
                }
                case CmdType::Stop:
                    s_streaming.store(false);
                    break;
            }
            continue;
        }

        // 队列超时 → 取流节拍
        if (s_streaming.load() && s_inited.load()) {
            // 背压:上一帧尚未被 JS 消费则跳过
            if (s_stream_busy != nullptr && s_stream_busy->load()) continue;
            CamFrame f{nullptr, 0};
            if (grab_copy(f) == ESP_OK) {
                if (s_stream_busy != nullptr) s_stream_busy->store(true);
                if (s_stream_cb) {
                    s_stream_cb(f);
                } else {
                    heap_caps_free(f.data);
                    if (s_stream_busy != nullptr) s_stream_busy->store(false);
                }
            }
        }
    }
}

esp_err_t ensure_task() {
    if (s_task != nullptr) return ESP_OK;
    s_queue = xQueueCreate(8, sizeof(Cmd));
    if (s_queue == nullptr) return ESP_ERR_NO_MEM;
    // 摄像头任务栈稍大(esp_camera_init 内部启动 DMA/ISR)
    if (xTaskCreatePinnedToCore(cam_task, "px_cam", 6144, nullptr, 7, &s_task, 0) != pdPASS) {
        vQueueDelete(s_queue);
        s_queue = nullptr;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

}  // namespace

// 运行期可用性 = 编译开关 AND 板级能力位
bool camera_available() { return board_caps()->camera; }
bool camera_inited() { return s_inited.load(); }

esp_err_t camera_init_async(CamResolution res, int jpeg_quality, CamFormat fmt,
                            std::function<void(esp_err_t)> done) {
    esp_err_t err = ensure_task();
    if (err != ESP_OK) return err;
    Cmd c = {};
    c.type = CmdType::Init;
    c.res = res;
    c.quality = jpeg_quality;
    c.fmt = fmt;
    c.fn = new std::function<void(esp_err_t)>(std::move(done));
    if (xQueueSend(s_queue, &c, pdMS_TO_TICKS(100)) != pdTRUE) {
        delete static_cast<std::function<void(esp_err_t)>*>(c.fn);
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

esp_err_t camera_capture_async(std::function<void(CamFrame, esp_err_t)> done) {
    if (s_task == nullptr) return ESP_ERR_INVALID_STATE;
    Cmd c = {};
    c.type = CmdType::Capture;
    c.fn = new std::function<void(CamFrame, esp_err_t)>(std::move(done));
    if (xQueueSend(s_queue, &c, pdMS_TO_TICKS(100)) != pdTRUE) {
        delete static_cast<std::function<void(CamFrame, esp_err_t)>*>(c.fn);
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

esp_err_t camera_start_stream(uint8_t fps, std::function<void(CamFrame)> on_frame,
                              std::atomic<bool>* busy) {
    if (s_task == nullptr || !s_inited.load()) return ESP_ERR_INVALID_STATE;
    s_stream_cb = std::move(on_frame);
    s_stream_busy = busy;
    s_stream_fps.store(fps == 0 ? 10 : fps);
    s_streaming.store(true);
    return ESP_OK;
}

void camera_stop_stream() {
    s_streaming.store(false);
    if (s_queue != nullptr) {
        Cmd c = {};
        c.type = CmdType::Stop;
        xQueueSend(s_queue, &c, 0);
    }
}

void camera_deinit_async(std::function<void()> done) {
    if (s_task == nullptr) {
        if (done) done();
        return;
    }
    Cmd c = {};
    c.type = CmdType::Deinit;
    c.fn = new std::function<void()>(std::move(done));
    if (xQueueSend(s_queue, &c, pdMS_TO_TICKS(100)) != pdTRUE) {
        delete static_cast<std::function<void()>*>(c.fn);
    }
}

#else  // !CONFIG_PX_ENABLE_CAMERA —— 桩实现

bool camera_available() { return false; }
bool camera_inited() { return false; }

esp_err_t camera_init_async(CamResolution, int, CamFormat, std::function<void(esp_err_t)>) {
    ESP_LOGW(TAG, "摄像头未启用 (PX_ENABLE_CAMERA=n)");
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t camera_capture_async(std::function<void(CamFrame, esp_err_t)>) {
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t camera_start_stream(uint8_t, std::function<void(CamFrame)>, std::atomic<bool>*) {
    return ESP_ERR_NOT_SUPPORTED;
}

void camera_stop_stream() {}

void camera_deinit_async(std::function<void()> done) {
    if (done) done();
}

#endif  // CONFIG_PX_ENABLE_CAMERA

}  // namespace hal_periph
