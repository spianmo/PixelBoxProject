/**
 * mod_camera.cpp — px.camera 绑定(OV2640 DVP, Kconfig PX_ENABLE_CAMERA 默认关)
 *
 * 未启用时:available() === false, 其余方法抛 Error("ENOTSUP")。
 * 耗时操作(init/capture)在 hal 工作任务执行, 经 Promise 异步返回。
 */
#include <atomic>
#include <cstdlib>
#include <mutex>
#include <vector>

#include "esp_heap_caps.h"

#include "hal_periph/camera_hal.hpp"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

namespace {

// 取流回调与背压标志
std::mutex s_stream_mtx;
jsvm::Callback s_on_frame;
std::atomic<bool> s_frame_busy{false};

bool guard(JSContext* ctx) {
    if (hal_periph::camera_available()) return true;
    jsvm::throw_enotsup(ctx);
    return false;
}

JSValue js_available(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewBool(ctx, hal_periph::camera_available());
}

hal_periph::CamResolution parse_resolution(const std::string& s) {
    if (s == "QQVGA") return hal_periph::CamResolution::QQVGA;
    if (s == "VGA") return hal_periph::CamResolution::VGA;
    if (s == "SVGA") return hal_periph::CamResolution::SVGA;
    if (s == "XGA") return hal_periph::CamResolution::XGA;
    if (s == "720P") return hal_periph::CamResolution::P720;
    return hal_periph::CamResolution::QVGA;  // 默认
}

JSValue js_init(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;

    std::string res_str = "QVGA", fmt_str = "jpeg";
    int quality = 12;
    if (argc >= 1 && JS_IsObject(argv[0])) {
        pxb::opt_string(ctx, argv[0], "resolution", res_str);
        pxb::opt_string(ctx, argv[0], "format", fmt_str);
        quality = static_cast<int>(pxb::opt_number(ctx, argv[0], "quality", 12));
    }
    if (quality < 1) quality = 1;
    if (quality > 63) quality = 63;

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    esp_err_t err = hal_periph::camera_init_async(
        parse_resolution(res_str), quality,
        fmt_str == "rgb565" ? hal_periph::CamFormat::Rgb565 : hal_periph::CamFormat::Jpeg,
        [pp](esp_err_t rc) {
            // 工作任务上下文
            if (rc == ESP_OK) {
                pp.resolve_undefined();
            } else {
                pp.reject_error(std::string("摄像头初始化失败: ") + esp_err_to_name(rc));
            }
        });
    if (err != ESP_OK) pp.reject_error("摄像头任务不可用");
    return promise;
}

JSValue js_capture(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (!hal_periph::camera_inited()) {
        return JS_ThrowPlainError(ctx, "摄像头未初始化, 请先 await px.camera.init()");
    }

    pxb::PromisePair pp;
    JSValue promise = pxb::make_promise(ctx, pp);
    if (JS_IsException(promise)) return promise;

    esp_err_t err = hal_periph::camera_capture_async([pp](hal_periph::CamFrame f, esp_err_t rc) {
        if (rc != ESP_OK) {
            pp.reject_error("拍摄失败");
            return;
        }
        // 拷入 vector 后立即释放帧缓冲(避免 VM 重启时经由失效回调泄漏)
        std::vector<uint8_t> data(f.data, f.data + f.len);
        heap_caps_free(f.data);
        pp.resolve_with([data = std::move(data)](JSContext* ctx2, JSValue* argv2) -> int {
            argv2[0] = JS_NewArrayBufferCopy(ctx2, data.data(), data.size());
            return 1;
        });
    });
    if (err != ESP_OK) pp.reject_error("摄像头任务不可用");
    return promise;
}

JSValue js_start_stream(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "startStream(opts) 需要 { fps?, onFrame }");
    }
    jsvm::Callback on_frame = pxb::opt_callback(ctx, argv[0], "onFrame");
    if (!on_frame) return JS_ThrowTypeError(ctx, "opts.onFrame 须为函数");
    double fps = pxb::opt_number(ctx, argv[0], "fps", 10);

    {
        std::lock_guard<std::mutex> lk(s_stream_mtx);
        s_on_frame = on_frame;
    }
    s_frame_busy.store(false);

    esp_err_t err = hal_periph::camera_start_stream(
        static_cast<uint8_t>(fps),
        [](hal_periph::CamFrame f) {
            jsvm::Callback cb;
            {
                std::lock_guard<std::mutex> lk(s_stream_mtx);
                cb = s_on_frame;
            }
            std::vector<uint8_t> data(f.data, f.data + f.len);
            heap_caps_free(f.data);
            if (!cb) {
                s_frame_busy.store(false);
                return;
            }
            cb.invoke_with([data = std::move(data)](JSContext* ctx2, JSValue* argv2) -> int {
                // JS 线程:交付帧并释放背压
                argv2[0] = JS_NewArrayBufferCopy(ctx2, data.data(), data.size());
                s_frame_busy.store(false);
                return 1;
            });
        },
        &s_frame_busy);
    if (err != ESP_OK) {
        return JS_ThrowPlainError(ctx, "取流启动失败 (摄像头未初始化?)");
    }
    return JS_UNDEFINED;
}

JSValue js_stop_stream(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    hal_periph::camera_stop_stream();
    std::lock_guard<std::mutex> lk(s_stream_mtx);
    s_on_frame.reset();
    return JS_UNDEFINED;
}

JSValue js_deinit(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    {
        std::lock_guard<std::mutex> lk(s_stream_mtx);
        s_on_frame.reset();
    }
    hal_periph::camera_deinit_async(nullptr);
    return JS_UNDEFINED;
}

void camera_init_mod(JSContext* ctx, JSValue px) {
    // VM 重启:停掉上一代应用的取流, 复位背压标志
    hal_periph::camera_stop_stream();
    {
        std::lock_guard<std::mutex> lk(s_stream_mtx);
        s_on_frame.reset();
    }
    s_frame_busy.store(false);

    JSValue cam = JS_NewObject(ctx);
    pxb::def_fn(ctx, cam, "available", js_available, 0);
    pxb::def_fn(ctx, cam, "init", js_init, 1);
    pxb::def_fn(ctx, cam, "capture", js_capture, 0);
    pxb::def_fn(ctx, cam, "startStream", js_start_stream, 1);
    pxb::def_fn(ctx, cam, "stopStream", js_stop_stream, 0);
    pxb::def_fn(ctx, cam, "deinit", js_deinit, 0);
    JS_SetPropertyStr(ctx, px, "camera", cam);
}

const jsvm::Module s_module = {
    .name = "camera",
    .priority = 10,
    .init = camera_init_mod,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
