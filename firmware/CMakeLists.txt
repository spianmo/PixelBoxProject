# ============================================================
# PixelBox 像素盒固件 — ESP-IDF v5.5 工程
#
# 构建前请先执行依赖拉取脚本 (vendored quickjs-ng):
#   ../tools/fetch_deps.sh
# 然后:
#   idf.py set-target esp32s3 && idf.py build
# ============================================================
cmake_minimum_required(VERSION 3.16)

# 固件版本 (px.system.info().firmwareVersion / devd hello.fw)
set(PROJECT_VER "0.1.0")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pixelbox)
