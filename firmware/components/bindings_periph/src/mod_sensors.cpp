/**
 * mod_sensors.cpp — px.sensors 绑定(IMU QMI8658)
 *
 * - start/stop:原始数据流(单回调, 重复 start 覆盖)
 * - onShake / onOrientation:订阅列表, 由 hal 内部 50Hz 检测采样驱动
 */
#include "esp_log.h"
#include <algorithm>
#include <cmath>

#include "hal_periph/imu_qmi8658.hpp"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "jsvm/latest_value.hpp"
#include "quickjs.h"

static const char* TAG = "px.sensors";

namespace {

pxb::CallbackRegistry s_shake_reg;
pxb::CallbackRegistry s_orient_reg;

// Callback ownership stays on the JS thread; only POD samples cross tasks.
jsvm::Callback s_stream_cb;
jsvm::LatestValue<hal_periph::ImuSample> s_latest;

int64_t stream_deadline() { return s_latest.pending() ? 0 : -1; }

void stream_poll(JSContext*) {
    hal_periph::ImuSample sample;
    if (!s_latest.take(sample) || !s_stream_cb) return;
    s_stream_cb.invoke_now([&sample](JSContext* ctx, JSValue* argv) -> int {
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "ax", JS_NewFloat64(ctx, sample.ax));
        JS_SetPropertyStr(ctx, o, "ay", JS_NewFloat64(ctx, sample.ay));
        JS_SetPropertyStr(ctx, o, "az", JS_NewFloat64(ctx, sample.az));
        JS_SetPropertyStr(ctx, o, "gx", JS_NewFloat64(ctx, sample.gx));
        JS_SetPropertyStr(ctx, o, "gy", JS_NewFloat64(ctx, sample.gy));
        JS_SetPropertyStr(ctx, o, "gz", JS_NewFloat64(ctx, sample.gz));
        argv[0] = o;
        return 1;
    });
}

void stop_stream() {
    s_latest.reset();
    hal_periph::imu_stop_stream();
    s_stream_cb.reset();
}

void sensors_teardown(JSContext*) {
    stop_stream();
    s_shake_reg.clear();
    s_orient_reg.clear();
}

const char* orient_str(hal_periph::ImuOrientation o) {
    switch (o) {
        case hal_periph::ImuOrientation::Up: return "up";
        case hal_periph::ImuOrientation::Down: return "down";
        case hal_periph::ImuOrientation::Left: return "left";
        case hal_periph::ImuOrientation::Right: return "right";
        case hal_periph::ImuOrientation::Flat: return "flat";
        case hal_periph::ImuOrientation::FaceDown: return "faceDown";
    }
    return "flat";
}

JSValue js_available(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewBool(ctx, hal_periph::imu_available());
}

JSValue js_start(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!hal_periph::imu_available()) return jsvm::throw_enotsup(ctx);
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "start(opts) 需要 { rateHz?, onData }");
    }
    jsvm::Callback on_data = pxb::opt_callback(ctx, argv[0], "onData");
    if (!on_data) return JS_ThrowTypeError(ctx, "opts.onData 须为函数");
    double rate = pxb::opt_number(ctx, argv[0], "rateHz", 50);
    if (JS_HasException(ctx)) return JS_EXCEPTION;
    if (!std::isfinite(rate)) return JS_ThrowRangeError(ctx, "rateHz must be finite");
    rate = std::max(5.0, std::min(500.0, rate));
    const uint32_t epoch = s_latest.reset();
    s_stream_cb = on_data;
    esp_err_t err = hal_periph::imu_start_stream(
        static_cast<uint16_t>(rate), [epoch](const hal_periph::ImuSample& sample) {
            if (s_latest.publish(epoch, sample)) jsvm::wake();
        });
    if (err != ESP_OK) {
        stop_stream();
        return JS_ThrowInternalError(ctx, "IMU 启动失败");
    }
    return JS_UNDEFINED;
}

JSValue js_stop(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    (void)ctx;
    stop_stream();
    return JS_UNDEFINED;
}

JSValue js_on_shake(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!hal_periph::imu_available()) return jsvm::throw_enotsup(ctx);
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "onShake 需要回调函数");
    }
    uint64_t id = s_shake_reg.add(ctx, argv[0]);
    return pxb::make_unsubscribe(ctx, &s_shake_reg, id);
}

JSValue js_on_orientation(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!hal_periph::imu_available()) return jsvm::throw_enotsup(ctx);
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "onOrientation 需要回调函数");
    }
    uint64_t id = s_orient_reg.add(ctx, argv[0]);

    // 立即向新订阅者投递当前姿态(便于 UI 初始化)
    const char* cur = orient_str(hal_periph::imu_current_orientation());
    jsvm::Callback cb(ctx, argv[0]);
    cb.invoke_with([cur](JSContext* c, JSValue* argv2) -> int {
        argv2[0] = JS_NewString(c, cur);
        return 1;
    });

    return pxb::make_unsubscribe(ctx, &s_orient_reg, id);
}

void sensors_init(JSContext* ctx, JSValue px) {
    s_shake_reg.clear();
    s_orient_reg.clear();
    stop_stream();
    jsvm::add_loop_source({0, stream_deadline, stream_poll});
    static bool hooked = false;
    if (!hooked) {
        jsvm::add_teardown_hook(sensors_teardown);
        hooked = true;
    }

    esp_err_t err = hal_periph::imu_init();
    if (err != ESP_OK && err != ESP_ERR_NOT_SUPPORTED) {
        ESP_LOGW(TAG, "IMU 初始化失败: %s", esp_err_to_name(err));
    }

    // 检测回调常驻(注册表为空时 active()=false, 不投递)
    hal_periph::imu_set_shake_callback([]() {
        if (!s_shake_reg.active()) return;
        s_shake_reg.invoke_all(nullptr);
    });
    hal_periph::imu_set_orientation_callback([](hal_periph::ImuOrientation o) {
        if (!s_orient_reg.active()) return;
        const char* s = orient_str(o);
        s_orient_reg.invoke_all([s](JSContext* ctx2, JSValue* argv) -> int {
            argv[0] = JS_NewString(ctx2, s);
            return 1;
        });
    });

    JSValue sensors = JS_NewObject(ctx);
    JSValue imu = JS_NewObject(ctx);
    pxb::def_fn(ctx, imu, "available", js_available, 0);
    pxb::def_fn(ctx, imu, "start", js_start, 1);
    pxb::def_fn(ctx, imu, "stop", js_stop, 0);
    pxb::def_fn(ctx, imu, "onShake", js_on_shake, 1);
    pxb::def_fn(ctx, imu, "onOrientation", js_on_orientation, 1);
    JS_SetPropertyStr(ctx, sensors, "imu", imu);
    JS_SetPropertyStr(ctx, px, "sensors", sensors);
}

const jsvm::Module s_module = {
    .name = "sensors",
    .priority = 10,
    .init = sensors_init,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
