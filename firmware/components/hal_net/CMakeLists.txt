# hal_net — 网络 HAL:WiFi 管理 + socket poll 任务
#
# 多目标: 无片上 WiFi 的目标 (ESP32-P4) 编译 wifi_manager_stub.cpp
# (接口一致, 全部如实返回 ESP_ERR_NOT_SUPPORTED); net_poll (纯 lwip)
# 各目标通用。P4 联网走 esp_hosted 的 TODO 见 docs/hardware/multi-target.md。
if(CONFIG_SOC_WIFI_SUPPORTED)
    set(wifi_src "src/wifi_manager.cpp")
else()
    set(wifi_src "src/wifi_manager_stub.cpp")
endif()

idf_component_register(
    SRCS
        "${wifi_src}"
        "src/net_poll.cpp"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        nvs_flash
        lwip
)
