/**
 * mod_gps.cpp — px.gps 绑定(UART NMEA, Kconfig PX_ENABLE_GPS 默认关)
 *
 * 未启用时:available() === false, 其余方法抛 Error("ENOTSUP")。
 */
#include <mutex>

#include "hal_periph/gps_hal.hpp"

#include "binding_util.hpp"
#include "jsvm/jsvm.hpp"
#include "quickjs.h"

namespace {

// onFix/onStatus 单回调(JS 线程写, GPS 任务读)→ 加锁
std::mutex s_cb_mtx;
jsvm::Callback s_on_fix;
jsvm::Callback s_on_status;

bool guard(JSContext* ctx) {
    if (hal_periph::gps_available()) return true;
    jsvm::throw_enotsup(ctx);
    return false;
}

/** NmeaFix → PxGpsFix 对象 */
JSValue make_fix_obj(JSContext* ctx, const hal_periph::NmeaFix& f) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "lat", JS_NewFloat64(ctx, f.lat));
    JS_SetPropertyStr(ctx, o, "lng", JS_NewFloat64(ctx, f.lng));
    JS_SetPropertyStr(ctx, o, "altitudeM", JS_NewFloat64(ctx, f.altitude_m));
    JS_SetPropertyStr(ctx, o, "speedMps", JS_NewFloat64(ctx, f.speed_mps));
    JS_SetPropertyStr(ctx, o, "course", JS_NewFloat64(ctx, f.course));
    JS_SetPropertyStr(ctx, o, "satellites", JS_NewInt32(ctx, f.satellites));
    JS_SetPropertyStr(ctx, o, "hdop", JS_NewFloat64(ctx, f.hdop));
    JS_SetPropertyStr(ctx, o, "timestamp", JS_NewInt64(ctx, f.timestamp_ms));
    return o;
}

const char* status_str(hal_periph::GpsStatus s) {
    switch (s) {
        case hal_periph::GpsStatus::Searching: return "searching";
        case hal_periph::GpsStatus::Fixed: return "fixed";
        case hal_periph::GpsStatus::Lost: return "lost";
    }
    return "searching";
}

JSValue js_available(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewBool(ctx, hal_periph::gps_available());
}

JSValue js_start(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!guard(ctx)) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "start(opts) 需要 { intervalMs?, onFix, onStatus? }");
    }
    jsvm::Callback on_fix = pxb::opt_callback(ctx, argv[0], "onFix");
    if (!on_fix) return JS_ThrowTypeError(ctx, "opts.onFix 须为函数");
    jsvm::Callback on_status = pxb::opt_callback(ctx, argv[0], "onStatus");
    double interval = pxb::opt_number(ctx, argv[0], "intervalMs", 1000);

    {
        std::lock_guard<std::mutex> lk(s_cb_mtx);
        s_on_fix = on_fix;
        s_on_status = on_status;
    }

    esp_err_t err = hal_periph::gps_start(
        static_cast<uint32_t>(interval),
        [](const hal_periph::NmeaFix& fix) {
            jsvm::Callback cb;
            {
                std::lock_guard<std::mutex> lk(s_cb_mtx);
                cb = s_on_fix;
            }
            if (!cb) return;
            hal_periph::NmeaFix f = fix;
            cb.invoke_with([f](JSContext* ctx2, JSValue* argv2) -> int {
                argv2[0] = make_fix_obj(ctx2, f);
                return 1;
            });
        },
        [](hal_periph::GpsStatus st) {
            jsvm::Callback cb;
            {
                std::lock_guard<std::mutex> lk(s_cb_mtx);
                cb = s_on_status;
            }
            if (!cb) return;
            const char* s = status_str(st);
            cb.invoke_with([s](JSContext* ctx2, JSValue* argv2) -> int {
                argv2[0] = JS_NewString(ctx2, s);
                return 1;
            });
        });
    if (err != ESP_OK) return JS_ThrowInternalError(ctx, "GPS 启动失败");
    return JS_UNDEFINED;
}

JSValue js_stop(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    hal_periph::gps_stop();
    std::lock_guard<std::mutex> lk(s_cb_mtx);
    s_on_fix.reset();
    s_on_status.reset();
    return JS_UNDEFINED;
}

JSValue js_last(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    if (!guard(ctx)) return JS_EXCEPTION;
    hal_periph::NmeaFix f;
    if (!hal_periph::gps_last(f)) return JS_NULL;
    return make_fix_obj(ctx, f);
}

void gps_init(JSContext* ctx, JSValue px) {
    // VM 重启:停掉上一代应用的 GPS 并清回调
    hal_periph::gps_stop();
    {
        std::lock_guard<std::mutex> lk(s_cb_mtx);
        s_on_fix.reset();
        s_on_status.reset();
    }

    JSValue gps = JS_NewObject(ctx);
    pxb::def_fn(ctx, gps, "available", js_available, 0);
    pxb::def_fn(ctx, gps, "start", js_start, 1);
    pxb::def_fn(ctx, gps, "stop", js_stop, 0);
    pxb::def_fn(ctx, gps, "last", js_last, 0);
    JS_SetPropertyStr(ctx, px, "gps", gps);
}

const jsvm::Module s_module = {
    .name = "gps",
    .priority = 10,
    .init = gps_init,
    .prelude = nullptr,
};

}  // namespace

JSVM_REGISTER_MODULE(s_module);
