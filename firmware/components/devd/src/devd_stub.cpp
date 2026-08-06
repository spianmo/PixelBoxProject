/**
 * devd_stub.cpp — 无片上网络目标 (ESP32-P4) 的 devd 桩
 *
 * 与 devd.cpp/devd_log.cpp 互斥编译 (CMakeLists 按 CONFIG_SOC_WIFI_SUPPORTED
 * 选择)。devd (WS :8765 + mDNS 广播 + 日志转发) 依赖可用的 IP 网络,
 * P4 无片上 WiFi/BT: 跳过启动、不报错 (main 的启动序列无需感知差异),
 * 应用推送请改用 USB 串口烧录; P4 经 esp_hosted 联网后可切回完整 devd,
 * 见 docs/hardware/multi-target.md 的 TODO。
 */
#include "devd/devd.h"

#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "devd";

esp_err_t devd_start(void)
{
    ESP_LOGI(TAG, "本目标 (%s) 无片上网络, devd 跳过启动 (P4 联网需 esp_hosted, "
                  "见 docs/hardware/multi-target.md)", CONFIG_IDF_TARGET);
    return ESP_OK;
}
