/**
 * wifi_portal_stub.cpp — 无片上 WiFi 目标 (ESP32-P4) 的网页配网桩实现
 *
 * 与 wifi_portal.cpp 互斥编译 (CMakeLists 按 CONFIG_SOC_WIFI_SUPPORTED 选择)。
 * 接口保持一致 (wifi_portal.hpp), 行为如实降级: 没有 SoftAP 就没有配网页,
 * start() 返回 ESP_ERR_NOT_SUPPORTED 且不动屏幕/不停应用, active() 恒为 false
 * (system_keys 的组合键因此退化为无操作)。
 *
 * P4 联网需 esp_hosted (P4 + C6 组合) 引入 esp_wifi_remote,
 * 见 docs/hardware/multi-target.md 的 TODO 说明。
 */
#include "wifi_portal/wifi_portal.hpp"

#include "esp_log.h"
#include "sdkconfig.h"

namespace wifi_portal {

namespace {
constexpr const char* TAG = "px.portal";
}

esp_err_t start()
{
    ESP_LOGW(TAG, "本目标无片上 WiFi (%s), 网页配网不可用 (ENOTSUP)", CONFIG_IDF_TARGET);
    return ESP_ERR_NOT_SUPPORTED;
}

void stop(bool) {}

bool active()
{
    return false;
}

}  // namespace wifi_portal
