#!/usr/bin/env bash
# errscreen 宿主机出图: 编译纯绘制层 (error_card.cpp) + hal_display 的 gfx/pxfont,
# 渲染若干张样张到 out/ (PPM), 有 PIL 时顺便转 PNG 方便直接看。
# 两种真机屏都出一遍: 368x448 (SH8601, ui_scale=1) 与 480x480 (CO5300, ui_scale=2)。
# 编排层 errscreen.cpp 依赖 esp_timer/FreeRTOS, 不参与本脚本。
set -euo pipefail
cd "$(dirname "$0")"

HAL=../../hal_display
BUILD=build
OUT=out
mkdir -p "$BUILD" "$OUT"

echo "[1/3] 编译 gfx + pxfont"
cc  -std=c11   -O1 -g -Wall -Wextra -I"$HAL/include" -c "$HAL/src/pxfont.c" -o "$BUILD/pxfont.o"
c++ -std=c++17 -O1 -g -Wall -Wextra -fno-exceptions -fno-rtti \
    -I"$HAL/include" -c "$HAL/src/gfx.cpp" -o "$BUILD/gfx.o"

echo "[2/3] 编译 error_card + 样张程序"
c++ -std=c++17 -O1 -g -Wall -Wextra \
    -I../include -I"$HAL/include" -c ../src/error_card.cpp -o "$BUILD/error_card.o"
c++ -std=c++17 -O1 -g -Wall -Wextra \
    -I../include -I"$HAL/include" -c render_card.cpp -o "$BUILD/render_card.o"
c++ -o "$BUILD/render_card" "$BUILD"/*.o

echo "[3/3] 渲染样张"
"$BUILD/render_card" "$HAL/fonts" "$OUT" 368 448
"$BUILD/render_card" "$HAL/fonts" "$OUT" 480 480

if python3 -c "import PIL" 2>/dev/null; then
    python3 - "$OUT" <<'PY'
import sys, pathlib
from PIL import Image
out = pathlib.Path(sys.argv[1])
for p in sorted(out.glob("*.ppm")):
    Image.open(p).save(p.with_suffix(".png"))
    print(f"  → {p.with_suffix('.png')}")
PY
else
    echo "  (未装 Pillow, 仅输出 PPM)"
fi
