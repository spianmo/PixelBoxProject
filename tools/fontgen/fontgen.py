#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fontgen — PixelBox 像素字体表生成器

从开源像素字体 (BDF 格式, 如缤纷像素 fusion-pixel; 或 unscii 的 .hex 格式)
生成固件 hal_display 使用的 pxfont 二进制字表 (.pxf), 可选同时生成 C 数组。

pxfont 二进制布局 (小端, 与 firmware/components/hal_display/include/hal_display/pxfont.h 对齐):
  [0..3]   magic "PXFN"
  [4]      u8  version = 1
  [5]      u8  height   (字形格高, 像素)
  [6]      u8  baseline (顶部到基线的像素数)
  [7]      u8  flags    (保留, 0)
  [8..11]  u32 glyph_count
  [12..15] u32 pool_size (位图池字节数)
  [16..]   glyph_count 个 8 字节记录, 按 codepoint 升序 (供二分查找):
             u16 codepoint (UTF-16 BMP)
             u8  width     (位图宽 = 步进宽)
             u8  advance   (步进宽)
             u32 offset    (位图在池中的偏移)
  之后     位图池: 每字形 rows=height, row_bytes=ceil(width/8), MSB 为最左像素

字体来源与许可:
  - fusion-pixel (缤纷像素字体, TakWolf): SIL OFL-1.1, 可嵌入分发
    https://github.com/TakWolf/fusion-pixel-font
  - unscii (viznut): Public Domain
    http://viznut.fi/unscii/

用法示例:
  # pixel12: fusion-pixel 12px 等宽, ASCII + GB2312 一级汉字 + 常用标点
  python3 fontgen.py --bdf fusion-pixel-12px-monospaced-zh_hans.bdf \
      --charset ascii,gb2312-l1,punct --out pixel12.pxf

  # pixel8: unscii-16 (8x16 ASCII)
  python3 fontgen.py --hex unscii-16.hex --charset ascii --out pixel8.pxf

  # pixel16: fusion-pixel 8px 等宽 2 倍放大 (16px, 含中文)
  python3 fontgen.py --bdf fusion-pixel-8px-monospaced-zh_hans.bdf \
      --charset ascii,gb2312-l1,punct --scale 2 --out pixel16.pxf

  # 自定义字符集 (文本文件中出现过的全部字符)
  python3 fontgen.py --bdf xx.bdf --charset ascii,file:mychars.txt --out my.pxf

  # 终端预览 (调试)
  python3 fontgen.py --bdf xx.bdf --charset ascii --out /tmp/t.pxf --preview "Hello 你好"
"""

from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

MAGIC = b"PXFN"
VERSION = 1

# 常用中文标点 + 全角符号 (与 GB2312 一级汉字组合使用)。
# 为避免源文件引号歧义, 全部用码点构造:
#   、。·—… ''"" 〈〉《》「」『』【】〔〕 ±×÷≠≤≥∞℃°
#   ☆★○●◎◇◆□■△▲※→←↑↓ 以及全角 ASCII 变体段 (U+FF01-U+FF5E)
_PUNCT_CPS = [
    0x3001, 0x3002, 0x00B7, 0x2014, 0x2026,
    0x2018, 0x2019, 0x201C, 0x201D,
    0x3008, 0x3009, 0x300A, 0x300B, 0x300C, 0x300D,
    0x300E, 0x300F, 0x3010, 0x3011, 0x3014, 0x3015,
    0x00B1, 0x00D7, 0x00F7, 0x2260, 0x2264, 0x2265, 0x221E, 0x2103, 0x00B0,
    0x2606, 0x2605, 0x25CB, 0x25CF, 0x25CE, 0x25C7, 0x25C6, 0x25A1, 0x25A0,
    0x25B3, 0x25B2, 0x203B, 0x2192, 0x2190, 0x2191, 0x2193,
] + list(range(0xFF01, 0xFF5F))
PUNCT = "".join(chr(c) for c in _PUNCT_CPS)


@dataclass
class Glyph:
    cp: int          # 码点 (BMP)
    width: int       # 位图宽 (= advance)
    advance: int     # 步进宽
    rows: List[int]  # 每行一个整数位掩码, bit(width-1-x) ... 实际存储时转字节

    def row_bytes(self) -> int:
        return (self.width + 7) // 8


@dataclass
class Font:
    height: int
    baseline: int
    glyphs: Dict[int, Glyph] = field(default_factory=dict)


# ------------------------------------------------------------
# 字符集
# ------------------------------------------------------------

def charset_gb2312(level1_only: bool) -> Set[int]:
    """利用 Python 内置 gb2312 编解码器枚举汉字区, 免去硬编码 3755 字表。

    GB2312 汉字区: 高字节 0xB0-0xF7, 低字节 0xA1-0xFE;
    一级汉字 (按拼音序 3755 字): 高字节 0xB0-0xD7。
    """
    out: Set[int] = set()
    hi_end = 0xD7 if level1_only else 0xF7
    for hi in range(0xB0, hi_end + 1):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if len(ch) == 1 and ord(ch) <= 0xFFFF:
                out.add(ord(ch))
    return out


def parse_charset(spec: str) -> Set[int]:
    cps: Set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if part == "ascii":
            cps.update(range(0x20, 0x7F))
        elif part == "gb2312-l1":
            cps.update(charset_gb2312(level1_only=True))
        elif part == "gb2312":
            cps.update(charset_gb2312(level1_only=False))
        elif part == "punct":
            cps.update(ord(c) for c in PUNCT if ord(c) <= 0xFFFF)
        elif part.startswith("file:"):
            with open(part[5:], "r", encoding="utf-8") as f:
                for ch in f.read():
                    if not ch.isspace() and ord(ch) <= 0xFFFF:
                        cps.add(ord(ch))
        elif part.startswith("range:"):  # range:4E00-9FA5
            lo, hi = part[6:].split("-")
            cps.update(range(int(lo, 16), int(hi, 16) + 1))
        else:
            raise ValueError(f"未知字符集: {part}")
    return cps


# ------------------------------------------------------------
# BDF 解析
# ------------------------------------------------------------

def parse_bdf(path: str, wanted: Set[int]) -> Font:
    """极简 BDF 解析器 (无第三方依赖), 只取 wanted 中的码点。"""
    ascent = descent = None
    size_px = None
    font = None

    cur_cp: Optional[int] = None
    cur_dwidth: Optional[int] = None
    cur_bbx = None            # (w, h, xoff, yoff)
    in_bitmap = False
    bitmap_hex: List[str] = []

    def flush_glyph():
        nonlocal cur_cp, cur_dwidth, cur_bbx, bitmap_hex
        if cur_cp is None or cur_cp not in wanted or cur_bbx is None:
            return
        assert font is not None
        w, h, xoff, yoff = cur_bbx
        adv = cur_dwidth if cur_dwidth is not None else w
        adv = max(1, adv)
        # 输出格: 宽 = advance, 高 = font.height, 基线在 font.baseline 行
        rows = [0] * font.height
        for r, hexline in enumerate(bitmap_hex):
            if not hexline:
                continue
            bits = int(hexline, 16)
            # BDF 位图每行按字节填充, 最高位是最左像素
            hex_bits = 4 * len(hexline)
            # y: 位图第 r 行位于基线上方 (yoff + h - 1 - r) 像素
            y = font.baseline - (yoff + h) + r
            if y < 0 or y >= font.height:
                continue
            rowmask = 0
            for x in range(w):
                if bits & (1 << (hex_bits - 1 - x)):
                    dx = x + xoff
                    if 0 <= dx < adv:
                        rowmask |= 1 << (adv - 1 - dx)
            rows[y] |= rowmask
        font.glyphs[cur_cp] = Glyph(cp=cur_cp, width=adv, advance=adv, rows=rows)

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if in_bitmap:
                if line.startswith("ENDCHAR"):
                    in_bitmap = False
                    flush_glyph()
                    cur_cp = cur_dwidth = cur_bbx = None
                    bitmap_hex = []
                else:
                    bitmap_hex.append(line.strip())
                continue
            if line.startswith("PIXEL_SIZE "):
                size_px = int(line.split()[1])
            elif line.startswith("FONT_ASCENT "):
                ascent = int(line.split()[1])
            elif line.startswith("FONT_DESCENT "):
                descent = int(line.split()[1])
            elif line.startswith("STARTCHAR"):
                if font is None:
                    if ascent is None or descent is None:
                        # 缺属性时以 PIXEL_SIZE 兜底 (基线 = 高度, 不精确)
                        h = size_px or 16
                        font = Font(height=h, baseline=h)
                    else:
                        font = Font(height=ascent + descent, baseline=ascent)
                cur_cp = None
                bitmap_hex = []
            elif line.startswith("ENCODING "):
                cur_cp = int(line.split()[1])
                if cur_cp < 0 or cur_cp > 0xFFFF:
                    cur_cp = None
            elif line.startswith("DWIDTH "):
                cur_dwidth = int(line.split()[1])
            elif line.startswith("BBX "):
                p = line.split()
                cur_bbx = (int(p[1]), int(p[2]), int(p[3]), int(p[4]))
            elif line.startswith("BITMAP"):
                in_bitmap = True
    if font is None:
        raise RuntimeError(f"BDF 无字形: {path}")
    return font


# ------------------------------------------------------------
# unscii .hex 解析 (格式: CODEPOINT:HEX, 8x16 → 32 hex, 16x16 → 64 hex)
# ------------------------------------------------------------

def parse_hex(path: str, wanted: Set[int]) -> Font:
    font = Font(height=16, baseline=14)  # unscii-16: 8x16, 基线约在 14 行
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or ":" not in line:
                continue
            cp_s, data = line.split(":", 1)
            cp = int(cp_s, 16)
            if cp not in wanted or cp > 0xFFFF:
                continue
            if len(data) == 32:      # 8 宽
                w = 8
                rows = [int(data[i * 2:i * 2 + 2], 16) for i in range(16)]
            elif len(data) == 64:    # 16 宽
                w = 16
                rows = [int(data[i * 4:i * 4 + 4], 16) for i in range(16)]
            else:
                continue
            font.glyphs[cp] = Glyph(cp=cp, width=w, advance=w, rows=rows)
    return font


# ------------------------------------------------------------
# 整数放大
# ------------------------------------------------------------

def scale_font(font: Font, k: int) -> Font:
    if k == 1:
        return font
    out = Font(height=font.height * k, baseline=font.baseline * k)
    for cp, g in font.glyphs.items():
        w2 = g.width * k
        rows2: List[int] = []
        for row in g.rows:
            mask = 0
            for x in range(g.width):
                if row & (1 << (g.width - 1 - x)):
                    for i in range(k):
                        mask |= 1 << (w2 - 1 - (x * k + i))
            rows2.extend([mask] * k)
        out.glyphs[cp] = Glyph(cp=cp, width=w2, advance=g.advance * k, rows=rows2)
    return out


# ------------------------------------------------------------
# 序列化
# ------------------------------------------------------------

def serialize(font: Font) -> bytes:
    glyphs = sorted(font.glyphs.values(), key=lambda g: g.cp)
    pool = bytearray()
    records = bytearray()
    for g in glyphs:
        offset = len(pool)
        rb = g.row_bytes()
        for row in g.rows:
            pool += int(row).to_bytes(rb, "big")
        records += struct.pack("<HBBI", g.cp, g.width, g.advance, offset)
    header = MAGIC + struct.pack(
        "<BBBBII", VERSION, font.height, font.baseline, 0, len(glyphs), len(pool)
    )
    return bytes(header + records + pool)


def emit_c_array(data: bytes, name: str) -> str:
    lines = [
        "/* 由 tools/fontgen/fontgen.py 自动生成, 勿手改 */",
        "#include <stdint.h>",
        f"const uint32_t {name}_size = {len(data)};",
        f"const uint8_t {name}[] = {{",
    ]
    for i in range(0, len(data), 16):
        chunk = ", ".join(f"0x{b:02x}" for b in data[i:i + 16])
        lines.append(f"    {chunk},")
    lines.append("};")
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------
# 终端预览 (调试)
# ------------------------------------------------------------

def preview(font: Font, text: str) -> None:
    canvas_rows = [""] * font.height
    for ch in text:
        g = font.glyphs.get(ord(ch))
        if g is None:
            g = Glyph(cp=0, width=font.height // 2, advance=font.height // 2,
                      rows=[(1 << (font.height // 2)) - 1] * font.height)
        for y in range(font.height):
            row = g.rows[y] if y < len(g.rows) else 0
            s = "".join("█" if row & (1 << (g.width - 1 - x)) else "·"
                        for x in range(g.width))
            canvas_rows[y] += s
    print("\n".join(canvas_rows))


def main() -> int:
    ap = argparse.ArgumentParser(description="PixelBox pxfont 字表生成器")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--bdf", help="BDF 字体文件 (fusion-pixel 等)")
    src.add_argument("--hex", dest="hexfile", help="unscii .hex 字体文件")
    ap.add_argument("--charset", default="ascii",
                    help="逗号分隔: ascii | gb2312-l1 | gb2312 | punct | file:<路径> | range:4E00-9FA5")
    ap.add_argument("--scale", type=int, default=1, help="整数放大倍数 (默认 1)")
    ap.add_argument("--out", required=True, help="输出 .pxf 路径")
    ap.add_argument("--c-array", help="同时输出 C 数组到该路径 (符号名取文件主名)")
    ap.add_argument("--preview", help="生成后在终端预览指定文本")
    args = ap.parse_args()

    wanted = parse_charset(args.charset)
    if args.bdf:
        font = parse_bdf(args.bdf, wanted)
    else:
        font = parse_hex(args.hexfile, wanted)
    font = scale_font(font, args.scale)

    missing = wanted - set(font.glyphs)
    data = serialize(font)
    with open(args.out, "wb") as f:
        f.write(data)
    print(f"[fontgen] {args.out}: {len(font.glyphs)} 字形, 高 {font.height}px, "
          f"基线 {font.baseline}, {len(data)} 字节; 缺字 {len(missing)}")
    if missing and len(missing) <= 20:
        print("[fontgen] 缺字码点:", ", ".join(f"U+{c:04X}" for c in sorted(missing)))

    if args.c_array:
        import os
        sym = os.path.splitext(os.path.basename(args.c_array))[0]
        with open(args.c_array, "w", encoding="utf-8") as f:
            f.write(emit_c_array(data, sym))
        print(f"[fontgen] C 数组: {args.c_array} (符号 {sym})")

    if args.preview:
        preview(font, args.preview)
    return 0


if __name__ == "__main__":
    sys.exit(main())
