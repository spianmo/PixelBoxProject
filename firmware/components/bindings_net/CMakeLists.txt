# PixelBox bindings_net — px.wifi / px.net / 全局 fetch / 全局 WebSocket
#                          + px.system 网络子功能 (ntpSync/otaCheck/otaApply)
# WHOLE_ARCHIVE:保证 JSVM_REGISTER_MODULE 的静态自注册对象不被链接器裁剪
# 多目标: 无片上 WiFi 的目标 (ESP32-P4) 只编 mod_net_stub.cpp —
# 同名模块按 d.ts 契约注册 ENOTSUP 行为 (状态接口如实返回),
# esp_wifi/esp_websocket_client 等真实实现不参与链接。
# P4 联网走 esp_hosted (esp_wifi_remote) 的 TODO 见 docs/hardware/multi-target.md。
#
# 注意: 仅 SRCS 允许依赖 CONFIG_* (IDF 构建系统约束 — REQUIRES/PRIV_REQUIRES
# 在配置加载前的 early expansion 阶段展开, 必须无条件);
# esp_wifi 组件在无 WiFi 目标上仍存在 (仅头文件/netif 绑定), 依赖可保留。
if(CONFIG_SOC_WIFI_SUPPORTED)
    set(srcs
        "src/js_helpers.cpp"
        "src/net_worker.cpp"
        "src/mod_wifi.cpp"
        "src/mod_fetch.cpp"
        "src/mod_websocket.cpp"
        "src/mod_net.cpp"
        "src/mod_system_net.cpp")
else()
    set(srcs "src/mod_net_stub.cpp")
endif()

idf_component_register(
    SRCS ${srcs}
    PRIV_INCLUDE_DIRS "src"
    PRIV_REQUIRES
        jsvm
        hal_common
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
        esp_hw_support
    WHOLE_ARCHIVE
)
