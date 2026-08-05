#!/usr/bin/env bash
# hal_periph 纯逻辑模块宿主机单测(无需 ESP-IDF)
set -euo pipefail
cd "$(dirname "$0")"

OUT=./build_host
mkdir -p "$OUT"

c++ -std=c++17 -Wall -Wextra -Werror -O1 \
    -I ../include \
    test_main.cpp \
    ../src/storage_paths.cpp \
    ../src/px_uuid.cpp \
    ../src/nmea_parser.cpp \
    -o "$OUT/hal_periph_host_test"

"$OUT/hal_periph_host_test"
