# hal_net — 网络 HAL:WiFi 管理 + socket poll 任务
idf_component_register(
    SRCS
        "src/wifi_manager.cpp"
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
