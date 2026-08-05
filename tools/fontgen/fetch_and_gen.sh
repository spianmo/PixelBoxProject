#!/usr/bin/env bash
# 下载字体源并重新生成 hal_display 内置字体 (pixel8 / pixel12 / pixel16)。
#
# 说明:
#  - unscii-16.hex 直接从 viznut.fi 下载 (Public Domain);
#  - fusion-pixel BDF 从 GitHub Release 下载; 直连 github.com 不通时
#    走 api.github.com 的 asset 通道 (Accept: octet-stream 重定向到对象存储),
#    并用 curl -C - 断点续传重试。
set -euo pipefail
cd "$(dirname "$0")"

VER="2026.07.20"   # fusion-pixel 版本 (升级时更新)
WORK="${TMPDIR:-/tmp}/pixelbox-fontgen"
FONTS_DIR="../../firmware/components/hal_display/fonts"
mkdir -p "$WORK"

echo "[1/4] 下载 unscii-16.hex"
[ -f "$WORK/unscii-16.hex" ] || curl -fL --retry 3 -o "$WORK/unscii-16.hex" \
    "http://viznut.fi/unscii/unscii-16.hex"

fetch_release() { # $1=资产文件名 $2=输出路径
    local name="$1" out="$2"
    [ -f "$out" ] && return 0
    local url="https://github.com/TakWolf/fusion-pixel-font/releases/download/${VER}/${name}"
    if curl -fL --retry 2 --max-time 300 -o "$out" "$url" 2>/dev/null; then return 0; fi
    echo "  github.com 直连失败, 改走 API asset 通道..."
    local id
    id=$(curl -fsL "https://api.github.com/repos/TakWolf/fusion-pixel-font/releases/tags/${VER}" |
        python3 -c "import json,sys;print(next(a['id'] for a in json.load(sys.stdin)['assets'] if a['name']=='${name}'))")
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        curl -sL -C - --max-time 280 -H 'Accept: application/octet-stream' -o "$out" \
            "https://api.github.com/repos/TakWolf/fusion-pixel-font/releases/assets/${id}" && return 0
        sleep 2
    done
    return 1
}

echo "[2/4] 下载 fusion-pixel BDF (12px / 8px 等宽)"
fetch_release "fusion-pixel-font-12px-monospaced-bdf-v${VER}.zip" "$WORK/f12.zip"
fetch_release "fusion-pixel-font-8px-monospaced-bdf-v${VER}.zip" "$WORK/f8.zip"
unzip -o -q "$WORK/f12.zip" -d "$WORK/f12"
unzip -o -q "$WORK/f8.zip" -d "$WORK/f8"

echo "[3/4] 生成字表"
CHARSET="ascii,gb2312-l1,punct"
python3 fontgen.py --hex "$WORK/unscii-16.hex" --charset ascii \
    --out "$FONTS_DIR/pixel8.pxf"
python3 fontgen.py --bdf "$WORK/f12/fusion-pixel-12px-monospaced-zh_hans.bdf" \
    --charset "$CHARSET" --out "$FONTS_DIR/pixel12.pxf"
python3 fontgen.py --bdf "$WORK/f8/fusion-pixel-8px-monospaced-zh_hans.bdf" \
    --charset "$CHARSET" --scale 2 --out "$FONTS_DIR/pixel16.pxf"

echo "[4/4] 完成:"
ls -la "$FONTS_DIR"
