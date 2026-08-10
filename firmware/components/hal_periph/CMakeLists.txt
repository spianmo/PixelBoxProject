# hal_periph — 外设 HAL:触摸/按键/IMU/BLE/摄像头/GPS/灯带 + 纯逻辑解析器

# 触摸芯片按板型二选一 (统一接口 touch_ft3168.hpp)
if(CONFIG_BOARD_WAVESHARE_AMOLED_216)
    set(touch_src "src/touch_cst9220.cpp")
else()
    set(touch_src "src/touch_ft3168.cpp")
endif()

idf_component_register(
    SRCS
        "src/i2c_bus.cpp"
        "src/storage_paths.cpp"
        "src/px_uuid.cpp"
        "src/nmea_parser.cpp"
        "${touch_src}"
        "src/button_input.cpp"
        "src/imu_qmi8658.cpp"
        "src/ble_hal.cpp"
        "src/gps_hal.cpp"
        "src/camera_hal.cpp"
        "src/led_hal.cpp"
    INCLUDE_DIRS "include"
    REQUIRES
        hal_common      # 板级配置/共享 I2C 总线
        driver          # i2c_master / uart / gpio / rmt
    PRIV_REQUIRES
        bt              # NimBLE (CONFIG_BT_NIMBLE_ENABLED 时生效)
        esp_timer
)
