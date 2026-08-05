# PixelBox bindings_net — px.wifi / px.net / 全局 fetch / 全局 WebSocket
#                          + px.system 网络子功能 (ntpSync/otaCheck/otaApply)
# WHOLE_ARCHIVE:保证 JSVM_REGISTER_MODULE 的静态自注册对象不被链接器裁剪
idf_component_register(
    SRCS
        "src/js_helpers.cpp"
        "src/net_worker.cpp"
        "src/mod_wifi.cpp"
        "src/mod_fetch.cpp"
        "src/mod_websocket.cpp"
        "src/mod_net.cpp"
        "src/mod_system_net.cpp"
    PRIV_INCLUDE_DIRS "src"
    PRIV_REQUIRES
        jsvm
        hal_net
        esp_http_client
        esp-tls
        esp_https_ota
        app_update
        esp_app_format
        esp_netif
        esp_event
        esp_timer
        esp_wifi
        lwip
        mbedtls
    WHOLE_ARCHIVE
)
