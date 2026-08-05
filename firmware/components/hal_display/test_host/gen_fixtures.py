#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成宿主单测用的图片 fixtures (需要 Pillow; 产物已随仓库提交)。

颜色全部选用 RGB565 可精确往返的值 (0/255 分量), 便于逐像素断言。
"""
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
os.makedirs(OUT, exist_ok=True)

# 4x4 不透明 PNG: 四象限 红/绿/蓝/白
img = Image.new("RGB", (4, 4))
for y in range(4):
    for x in range(4):
        c = (255, 0, 0) if x < 2 and y < 2 else \
            (0, 255, 0) if x >= 2 and y < 2 else \
            (0, 0, 255) if x < 2 else (255, 255, 255)
        img.putpixel((x, y), c)
img.save(os.path.join(OUT, "rgb4x4.png"))

# 2x2 含 alpha PNG: 左上透明, 其余红
rgba = Image.new("RGBA", (2, 2), (255, 0, 0, 255))
rgba.putpixel((0, 0), (0, 0, 0, 0))
rgba.save(os.path.join(OUT, "alpha2x2.png"))

# 3x2 两帧 GIF: 帧1 全红, 帧2 全蓝, 每帧 200ms
f1 = Image.new("P", (3, 2))
f1.putpalette([255, 0, 0, 0, 0, 255] + [0] * (256 * 3 - 6))
f1.paste(0, (0, 0, 3, 2))
f2 = Image.new("P", (3, 2))
f2.putpalette([255, 0, 0, 0, 0, 255] + [0] * (256 * 3 - 6))
f2.paste(1, (0, 0, 3, 2))
f1.save(os.path.join(OUT, "anim3x2.gif"), save_all=True, append_images=[f2],
        duration=200, loop=0)

print("fixtures 写入:", OUT)
