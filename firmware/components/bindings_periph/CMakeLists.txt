# bindings_periph — px.storage / px.input / px.sensors / px.ble /
#                   px.camera / px.gps / px.led / px.util(native 部分)
#
# WHOLE_ARCHIVE:模块经 JSVM_REGISTER_MODULE 静态自注册,
# 防止链接器把"看似无人引用"的注册对象裁剪掉。
idf_component_register(
    SRCS
        "src/binding_util.cpp"
        "src/mod_util.cpp"
        "src/mod_storage.cpp"
        "src/mod_input.cpp"
        "src/mod_sensors.cpp"
        "src/mod_ble.cpp"
        "src/mod_camera.cpp"
        "src/mod_gps.cpp"
        "src/mod_led.cpp"
    PRIV_INCLUDE_DIRS "src"
    REQUIRES
        jsvm            # jsvm.hpp + quickjs.h
        hal_periph      # 外设 HAL
    PRIV_REQUIRES
        hal_common      # 板级能力位
        appmgr          # /data、/app 虚拟路径权威映射
        nvs_flash       # px.storage.kv
        mbedtls         # sha256
        esp_hw_support  # esp_fill_random
        esp_timer       # 手势时长判定
        pthread         # onRead 同步读桥 (condition_variable)
    WHOLE_ARCHIVE
)
