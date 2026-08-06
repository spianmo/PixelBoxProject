# devd — 开发服务: WS :8765/devd + mDNS + 日志广播 (mdns 依赖见 idf_component.yml)
#
# 多目标: 无片上网络的目标 (ESP32-P4) 编译 devd_stub.cpp —
# devd_start() 记录一条日志后直接返回 ESP_OK (跳过启动、不报错)。
if(CONFIG_SOC_WIFI_SUPPORTED)
    set(srcs src/devd.cpp src/devd_log.cpp)
else()
    set(srcs src/devd_stub.cpp)
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    PRIV_REQUIRES esp_http_server json mbedtls esp_netif esp_hw_support
                  esp_app_format appmgr jsvm hal_common)
