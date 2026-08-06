# boards — 板型实现 (Kconfig 选择), 提供 hal_common/board.h 声明的全部接口
#
# 多目标: 每个板型一个源文件, 按 CONFIG_BOARD_* 二选一编译;
# AXP2101/TCA9554 驱动仅微雪板/定制板 (S3) 使用, 其他板型不编入。
set(srcs "")

if(CONFIG_BOARD_WAVESHARE_AMOLED_18)
    list(APPEND srcs "src/board_waveshare_amoled_18.c" "src/axp2101.c" "src/tca9554.c")
elseif(CONFIG_BOARD_CUSTOM_V1)
    list(APPEND srcs "src/board_custom_v1.c" "src/axp2101.c" "src/tca9554.c")
elseif(CONFIG_BOARD_GENERIC_SPI)
    list(APPEND srcs "src/board_generic_spi.c")
elseif(CONFIG_BOARD_HEADLESS)
    list(APPEND srcs "src/board_headless.c")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS include
    REQUIRES hal_common
    PRIV_REQUIRES esp_driver_i2c esp_driver_gpio freertos)
