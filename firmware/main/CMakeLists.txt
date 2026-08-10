# main — app_main 入口
#
# REQUIRES 列出全部业务组件 (含其他领域并行开发的组件, 统一在此声明依赖,
# 保证 bindings_* 的 JSVM_REGISTER_MODULE 静态注册被链接进固件)。
idf_component_register(
    SRCS main.cpp system_keys.cpp
    REQUIRES
        boards hal_common jsvm appmgr devd
        hal_display bindings_screen
        hal_audio bindings_audio voicechat
        hal_net bindings_net
        hal_periph bindings_periph
    PRIV_REQUIRES nvs_flash esp_event esp_netif esp_hw_support esp_driver_gpio)
