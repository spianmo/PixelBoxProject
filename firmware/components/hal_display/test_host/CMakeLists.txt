cmake_minimum_required(VERSION 3.16)
project(pixelbox_display_test LANGUAGES C CXX)
enable_testing()

set(LVGL_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../managed_components/lvgl__lvgl" CACHE PATH "LVGL 9.2.2 源码")
if(NOT EXISTS "${LVGL_SOURCE_DIR}/src/draw/sw/blend/lv_draw_sw_blend_private.h")
    message(FATAL_ERROR "请先在 firmware 执行 idf.py reconfigure，获取 LVGL 9.2.2")
endif()
set(LV_CONF_SKIP ON)
set(LV_CONF_BUILD_DISABLE_EXAMPLES ON)
set(LV_CONF_BUILD_DISABLE_DEMOS ON)
set(LV_CONF_BUILD_DISABLE_THORVG_INTERNAL ON)
add_subdirectory("${LVGL_SOURCE_DIR}" lvgl)
target_compile_definitions(lvgl PUBLIC LV_COLOR_DEPTH=16)

add_library(pixelbox_gfx ../src/gfx.cpp ../src/pxfont.c ../src/image_decode.cpp
    ../vendor/miniz.c ../vendor/pngle.c ../vendor/gifdec.c)
target_include_directories(pixelbox_gfx PUBLIC ../include PRIVATE ../vendor)
target_compile_features(pixelbox_gfx PUBLIC cxx_std_17)
target_compile_definitions(pixelbox_gfx PRIVATE MINIZ_NO_STDIO MINIZ_NO_TIME
    MINIZ_NO_ARCHIVE_APIS MINIZ_NO_ARCHIVE_WRITING_APIS)
target_link_libraries(pixelbox_gfx PUBLIC lvgl)

add_executable(test_gfx test_main.cpp)
target_link_libraries(test_gfx PRIVATE pixelbox_gfx)
add_test(NAME graphics COMMAND test_gfx "${CMAKE_CURRENT_SOURCE_DIR}/../fonts" "${CMAKE_CURRENT_SOURCE_DIR}/fixtures")
add_executable(test_dma test_dma.cpp)
target_link_libraries(test_dma PRIVATE pixelbox_gfx)
add_test(NAME dma COMMAND test_dma)
add_executable(render_demo render_demo.cpp)
target_link_libraries(render_demo PRIVATE pixelbox_gfx)
add_test(NAME pixels_compat COMMAND "${CMAKE_COMMAND}"
    "-DRENDER=$<TARGET_FILE:render_demo>" "-DFONTS=${CMAKE_CURRENT_SOURCE_DIR}/../fonts"
    "-DOUTPUT=${CMAKE_CURRENT_BINARY_DIR}/render.ppm" -P "${CMAKE_CURRENT_SOURCE_DIR}/compare_render.cmake")
set_tests_properties(graphics dma pixels_compat PROPERTIES TIMEOUT 60)
# Release 构建也必须执行测试断言。
target_compile_options(test_dma PRIVATE -UNDEBUG)
