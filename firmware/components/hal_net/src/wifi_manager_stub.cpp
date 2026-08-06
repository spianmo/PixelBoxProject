/**
 * wifi_manager_stub.cpp — 无片上 WiFi 目标 (ESP32-P4) 的 WifiManager 桩实现
 *
 * 与 wifi_manager.cpp 互斥编译 (CMakeLists 按 CONFIG_SOC_WIFI_SUPPORTED 选择)。
 * 接口保持一致 (wifi_manager.hpp), 行为如实降级:
 *   - ensure_init/connect/scan/start_ap → ESP_ERR_NOT_SUPPORTED;
 *   - status() → 未连接快照 (mac 取 eFuse 基础 MAC, 其余为空);
 *   - 事件监听可注册但永不触发 (无事件源)。
 *
 * P4 联网需 esp_hosted (P4 + C6 组合) 引入 esp_wifi_remote,
 * 见 docs/hardware/multi-target.md 的 TODO 说明。
 */
#include "hal_net/wifi_manager.hpp"

#include <cstdio>

#include "esp_log.h"
#include "esp_mac.h"
#include "sdkconfig.h"

namespace hal_net {

namespace {
constexpr const char* TAG = "wifi_mgr";
}

WifiManager& WifiManager::instance()
{
    static WifiManager inst;
    return inst;
}

esp_err_t WifiManager::ensure_init()
{
    if (!inited_) {
        inited_ = true;
        ESP_LOGW(TAG, "本目标无片上 WiFi (%s), px.wifi 不可用 (ENOTSUP)", CONFIG_IDF_TARGET);
    }
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t WifiManager::connect(const std::string&, const std::string&, bool)
{
    return ESP_ERR_NOT_SUPPORTED;
}

void WifiManager::disconnect() {}

esp_err_t WifiManager::scan(ScanDone)
{
    return ESP_ERR_NOT_SUPPORTED;
}

WifiStatus WifiManager::status()
{
    WifiStatus st;
    st.connected = false;
    st.rssi = 0;
    uint8_t mac[6] = {};
    esp_read_mac(mac, ESP_MAC_BASE); /* 无 WiFi MAC, 用 eFuse 基础 MAC */
    char buf[18];
    snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    st.mac = buf;
    return st;
}

int WifiManager::add_listener(WifiListener cb)
{
    std::lock_guard<std::recursive_mutex> lk(mtx_);
    const int id = next_listener_id_++;
    listeners_.emplace(id, std::move(cb)); /* 永不触发 (无事件源) */
    return id;
}

void WifiManager::remove_listener(int id)
{
    std::lock_guard<std::recursive_mutex> lk(mtx_);
    listeners_.erase(id);
}

esp_err_t WifiManager::start_ap(const std::string&, const std::string&)
{
    return ESP_ERR_NOT_SUPPORTED;
}

void WifiManager::stop_ap() {}

}  // namespace hal_net
