# devd — 开发服务: WS :8765/devd + mDNS + 日志广播 (mdns 依赖见 idf_component.yml)
idf_component_register(
    SRCS
        src/devd.cpp
        src/devd_log.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    PRIV_REQUIRES esp_http_server json mbedtls esp_netif esp_hw_support
                  esp_app_format appmgr jsvm hal_common)
