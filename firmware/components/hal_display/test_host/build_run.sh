#!/usr/bin/env bash
# hal_display 宿主机单测: 编译 gfx/pxfont/image_decode + vendored 解码器并运行。
# (esp_lcd 相关的 hal_display.cpp / fonts.cpp 仅在固件目标编译, 不参与本测试)
set -euo pipefail
cd "$(dirname "$0")"

BUILD=build
mkdir -p "$BUILD"

MINIZ_DEFS="-DMINIZ_NO_STDIO -DMINIZ_NO_TIME -DMINIZ_NO_ARCHIVE_APIS -DMINIZ_NO_ARCHIVE_WRITING_APIS"

echo "[1/3] 编译 C (vendored + pxfont)"
cc -std=c11 -O1 -g -Wall -I../include -I../vendor $MINIZ_DEFS -c ../vendor/miniz.c -o "$BUILD/miniz.o" -w
cc -std=c11 -O1 -g -Wall -I../include -I../vendor $MINIZ_DEFS -c ../vendor/pngle.c -o "$BUILD/pngle.o" -w
cc -std=c11 -O1 -g -Wall -I../include -I../vendor -c ../vendor/gifdec.c -o "$BUILD/gifdec.o"
cc -std=c11 -O1 -g -Wall -Wextra -I../include -c ../src/pxfont.c -o "$BUILD/pxfont.o"

echo "[2/3] 编译 C++ (gfx + image_decode + 测试)"
c++ -std=c++17 -O1 -g -Wall -Wextra -fno-exceptions -fno-rtti \
    -I../include -I../vendor -c ../src/gfx.cpp -o "$BUILD/gfx.o"
c++ -std=c++17 -O1 -g -Wall -Wextra \
    -I../include -I../vendor -c ../src/image_decode.cpp -o "$BUILD/image_decode.o"
c++ -std=c++17 -O1 -g -Wall -Wextra -I../include -c test_main.cpp -o "$BUILD/test_main.o"

c++ -o "$BUILD/test_gfx" "$BUILD"/*.o

echo "[3/3] 运行"
"$BUILD/test_gfx" ../fonts fixtures
