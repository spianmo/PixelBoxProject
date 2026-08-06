/**
 * mod_system.cpp — px.system 模块 (fw-core 部分)
 *
 * 提供: info / memory / battery / restart / deepSleep / now / setTimezone /
 *       temperature / on('lowBattery'|'chargingChange')
 *
 * 注意: ntpSync / otaCheck / otaApply 由 bindings_net 组件后续补挂到
 * 同一 px.system 对象 (本模块 priority=0 保证 px.system 先建好)。
 */
#include "jsvm_internal.hpp"

#include <ctime>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sys/time.h>
#include <vector>

#include "driver/temperature_sensor.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal_common/board.h"
#include "sdkconfig.h"
#include "soc/soc_caps.h"

static const char *TAG = "px.system";

namespace {

using jsvm::Callback;

/* ------------------------------------------------------------
 * 电池事件监视 (独立低优先级任务轮询 PMU, 事件经 Callback 投递到 JS)
 * ------------------------------------------------------------ */

constexpr int kLowBatteryThreshold = 15; /* 低电量阈值 (%) */

struct BatterySub {
    int id;
    bool low_battery; /* true=lowBattery, false=chargingChange */
    Callback cb;
};

std::mutex s_sub_mutex;
std::vector<BatterySub> s_subs;
int s_next_sub_id = 1;
bool s_monitor_started = false;

/** 构造 PxBatteryInfo JS 对象的参数 builder */
Callback::ArgBuilder battery_arg_builder(const board_battery_info_t &bi)
{
    board_battery_info_t copy = bi;
    return [copy](JSContext *ctx, JSValue *argv) -> int {
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "level", JS_NewInt32(ctx, copy.level));
        JS_SetPropertyStr(ctx, o, "charging", JS_NewBool(ctx, copy.charging));
        JS_SetPropertyStr(ctx, o, "voltageMv", JS_NewInt32(ctx, copy.voltage_mv));
        argv[0] = o;
        return 1;
    };
}

void battery_monitor_task(void *arg)
{
    (void)arg;
    board_battery_info_t last = {};
    bool have_last = false;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(3000));
        {
            std::lock_guard<std::mutex> lk(s_sub_mutex);
            if (s_subs.empty()) {
                have_last = false;
                continue; /* 无订阅时不读 I2C */
            }
        }
        board_battery_info_t bi;
        if (board_battery(&bi) != ESP_OK) {
            continue;
        }

        bool fire_low = false;
        bool fire_charge = false;
        if (bi.level >= 0) {
            if (!have_last && bi.level <= kLowBatteryThreshold) {
                fire_low = true; /* 首次采样即低电量 */
            } else if (have_last && last.level > kLowBatteryThreshold &&
                       bi.level <= kLowBatteryThreshold) {
                fire_low = true; /* 跨越阈值 */
            }
        }
        if (have_last && bi.charging != last.charging) {
            fire_charge = true;
        }

        if (fire_low || fire_charge) {
            std::vector<Callback> targets;
            {
                std::lock_guard<std::mutex> lk(s_sub_mutex);
                for (auto &s : s_subs) {
                    if ((s.low_battery && fire_low) || (!s.low_battery && fire_charge)) {
                        targets.push_back(s.cb);
                    }
                }
            }
            for (auto &cb : targets) {
                cb.invoke_with(battery_arg_builder(bi));
            }
        }
        last = bi;
        have_last = true;
    }
}

void ensure_monitor_started()
{
    if (s_monitor_started) {
        return;
    }
    s_monitor_started = true;
    xTaskCreatePinnedToCore(battery_monitor_task, "px_batmon", 3072, nullptr, 2, nullptr, 0);
}

/** VM 拆除时清空订阅 (Callback 引用释放会自动投递回 JS 线程) */
void system_teardown(JSContext *ctx)
{
    (void)ctx;
    std::lock_guard<std::mutex> lk(s_sub_mutex);
    s_subs.clear();
}

/* ------------------------------------------------------------
 * 方法实现
 * ------------------------------------------------------------ */

JSValue js_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "model", JS_NewString(ctx, board_model()));
    JS_SetPropertyStr(ctx, o, "firmwareVersion",
                      JS_NewString(ctx, esp_app_get_description()->version));
    JS_SetPropertyStr(ctx, o, "chip", JS_NewString(ctx, CONFIG_IDF_TARGET));

    uint8_t mac[6] = {};
#if SOC_WIFI_SUPPORTED
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
#else
    /* 无片上 WiFi 目标 (P4): 用 eFuse 基础 MAC 派生 deviceId */
    esp_read_mac(mac, ESP_MAC_BASE);
#endif
    char devid[24];
    snprintf(devid, sizeof(devid), "pxb-%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    JS_SetPropertyStr(ctx, o, "deviceId", JS_NewString(ctx, devid));

    const board_display_config_t *disp = board_display_config();
    JSValue screen = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, screen, "width", JS_NewInt32(ctx, disp->width));
    JS_SetPropertyStr(ctx, screen, "height", JS_NewInt32(ctx, disp->height));
    JS_SetPropertyStr(ctx, o, "screen", screen);

    const board_caps_t *caps = board_caps();
    JSValue c = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, c, "camera", JS_NewBool(ctx, caps->camera));
    JS_SetPropertyStr(ctx, c, "gps", JS_NewBool(ctx, caps->gps));
    JS_SetPropertyStr(ctx, c, "ble", JS_NewBool(ctx, caps->ble));
    JS_SetPropertyStr(ctx, c, "led", JS_NewBool(ctx, caps->led));
    JS_SetPropertyStr(ctx, c, "imu", JS_NewBool(ctx, caps->imu));
    JS_SetPropertyStr(ctx, c, "touch", JS_NewBool(ctx, caps->touch));
    JS_SetPropertyStr(ctx, c, "battery", JS_NewBool(ctx, caps->battery));
    JS_SetPropertyStr(ctx, c, "mic", JS_NewBool(ctx, caps->mic));
    JS_SetPropertyStr(ctx, c, "speaker", JS_NewBool(ctx, caps->speaker));
    JS_SetPropertyStr(ctx, o, "capabilities", c);
    return o;
}

JSValue js_memory(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "heapFree",
                      JS_NewFloat64(ctx, (double)heap_caps_get_free_size(MALLOC_CAP_INTERNAL)));
    JS_SetPropertyStr(ctx, o, "psramFree",
                      JS_NewFloat64(ctx, (double)heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
    JS_SetPropertyStr(ctx, o, "jsHeapUsed", JS_NewFloat64(ctx, (double)jsvm::js_heap_used()));
    return o;
}

JSValue js_battery(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    board_battery_info_t bi = {};
    bi.level = -1;
    board_battery(&bi);
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "level", JS_NewInt32(ctx, bi.level));
    JS_SetPropertyStr(ctx, o, "charging", JS_NewBool(ctx, bi.charging));
    JS_SetPropertyStr(ctx, o, "voltageMv", JS_NewInt32(ctx, bi.voltage_mv));
    return o;
}

JSValue js_restart(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)ctx;
    (void)this_val;
    (void)argc;
    (void)argv;
    ESP_LOGW(TAG, "JS 请求整机重启");
    esp_restart();
    return JS_UNDEFINED; /* 不可达 */
}

JSValue js_deep_sleep(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    double ms = 0;
    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        if (JS_ToFloat64(ctx, &ms, argv[0])) {
            return JS_EXCEPTION;
        }
    }
    ESP_LOGW(TAG, "JS 请求深度睡眠 (%.0f ms)", ms);
    if (ms > 0) {
        esp_sleep_enable_timer_wakeup((uint64_t)(ms * 1000.0));
    }
    esp_deep_sleep_start();
    return JS_UNDEFINED; /* 不可达 */
}

JSValue js_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return JS_NewFloat64(ctx, (double)tv.tv_sec * 1000.0 + (double)tv.tv_usec / 1000.0);
}

JSValue js_set_timezone(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "setTimezone 需要 POSIX TZ 字符串, 如 \"CST-8\"");
    }
    const char *tz = JS_ToCString(ctx, argv[0]);
    if (!tz) {
        return JS_EXCEPTION;
    }
    setenv("TZ", tz, 1);
    tzset();
    JS_FreeCString(ctx, tz);
    return JS_UNDEFINED;
}

JSValue js_temperature(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    static temperature_sensor_handle_t s_tsens = nullptr;
    if (!s_tsens) {
        temperature_sensor_config_t cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
        if (temperature_sensor_install(&cfg, &s_tsens) != ESP_OK ||
            temperature_sensor_enable(s_tsens) != ESP_OK) {
            s_tsens = nullptr;
            return JS_ThrowInternalError(ctx, "温度传感器初始化失败");
        }
    }
    float celsius = 0;
    if (temperature_sensor_get_celsius(s_tsens, &celsius) != ESP_OK) {
        return JS_ThrowInternalError(ctx, "温度读取失败");
    }
    return JS_NewFloat64(ctx, (double)celsius);
}

/** 退订函数 (JS_NewCFunctionData, func_data[0] = 订阅 id) */
JSValue js_unsubscribe(JSContext *ctx, JSValueConst this_val, int argc,
                       JSValueConst *argv, int magic, JSValueConst *func_data)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    int32_t id = 0;
    JS_ToInt32(ctx, &id, func_data[0]);
    std::lock_guard<std::mutex> lk(s_sub_mutex);
    for (auto it = s_subs.begin(); it != s_subs.end(); ++it) {
        if (it->id == id) {
            s_subs.erase(it);
            break;
        }
    }
    return JS_UNDEFINED;
}

JSValue js_on(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsFunction(ctx, argv[1])) {
        return JS_ThrowTypeError(ctx, "on(event, callback) 参数非法");
    }
    const char *ev = JS_ToCString(ctx, argv[0]);
    if (!ev) {
        return JS_EXCEPTION;
    }
    bool low_battery;
    if (strcmp(ev, "lowBattery") == 0) {
        low_battery = true;
    } else if (strcmp(ev, "chargingChange") == 0) {
        low_battery = false;
    } else {
        JSValue e = JS_ThrowTypeError(ctx, "未知事件: %s", ev);
        JS_FreeCString(ctx, ev);
        return e;
    }
    JS_FreeCString(ctx, ev);

    int id;
    {
        std::lock_guard<std::mutex> lk(s_sub_mutex);
        id = s_next_sub_id++;
        s_subs.push_back(BatterySub{id, low_battery, Callback(ctx, argv[1])});
    }
    ensure_monitor_started();

    JSValue id_val = JS_NewInt32(ctx, id);
    JSValue unsub = JS_NewCFunctionData(ctx, js_unsubscribe, 0, 0, 1, &id_val);
    JS_FreeValue(ctx, id_val);
    return unsub;
}

/* ------------------------------------------------------------
 * 模块注册
 * ------------------------------------------------------------ */

void system_init(JSContext *ctx, JSValue px)
{
    static bool s_hook_added = false;
    if (!s_hook_added) {
        s_hook_added = true;
        jsvm::add_teardown_hook(system_teardown);
    }

    JSValue sys = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, sys, "info", JS_NewCFunction(ctx, js_info, "info", 0));
    JS_SetPropertyStr(ctx, sys, "memory", JS_NewCFunction(ctx, js_memory, "memory", 0));
    JS_SetPropertyStr(ctx, sys, "battery", JS_NewCFunction(ctx, js_battery, "battery", 0));
    JS_SetPropertyStr(ctx, sys, "restart", JS_NewCFunction(ctx, js_restart, "restart", 0));
    JS_SetPropertyStr(ctx, sys, "deepSleep", JS_NewCFunction(ctx, js_deep_sleep, "deepSleep", 1));
    JS_SetPropertyStr(ctx, sys, "now", JS_NewCFunction(ctx, js_now, "now", 0));
    JS_SetPropertyStr(ctx, sys, "setTimezone",
                      JS_NewCFunction(ctx, js_set_timezone, "setTimezone", 1));
    JS_SetPropertyStr(ctx, sys, "temperature",
                      JS_NewCFunction(ctx, js_temperature, "temperature", 0));
    JS_SetPropertyStr(ctx, sys, "on", JS_NewCFunction(ctx, js_on, "on", 2));
    JS_SetPropertyStr(ctx, px, "system", sys);
}

} // namespace

JSVM_REGISTER_MODULE((jsvm::Module{
    .name = "system",
    .priority = 0,
    .init = system_init,
    .prelude = nullptr,
}));
