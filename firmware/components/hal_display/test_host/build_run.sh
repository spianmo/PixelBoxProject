#!/usr/bin/env bash
# 使用与固件相同的 LVGL 9 RGB565 渲染器，测试上限由 CTest 设置为 60 秒。
set -euo pipefail
cd "$(dirname "$0")"
cmake -S . -B build/lvgl-host -DCMAKE_BUILD_TYPE=Release
cmake --build build/lvgl-host -j4
ctest --test-dir build/lvgl-host --output-on-failure
