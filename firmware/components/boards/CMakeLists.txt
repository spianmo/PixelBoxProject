# boards — 板型实现 (Kconfig 选择), 提供 hal_common/board.h 声明的全部接口
set(srcs "src/axp2101.c" "src/tca9554.c")

if(CONFIG_BOARD_WAVESHARE_AMOLED_18)
    list(APPEND srcs "src/board_waveshare_amoled_18.c")
elseif(CONFIG_BOARD_CUSTOM_V1)
    list(APPEND srcs "src/board_custom_v1.c")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS include
    REQUIRES hal_common
    PRIV_REQUIRES esp_driver_i2c esp_driver_gpio freertos)
