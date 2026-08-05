# tools/fontgen — 像素字体表生成器

把开源像素字体 (BDF / unscii .hex) 转成固件 `hal_display` 使用的 **pxfont**
二进制字表 (`.pxf`),经 CMake `EMBED_FILES` 编入 flash 后零拷贝解析。

## 内置字体产物 (已提交到 `firmware/components/hal_display/fonts/`)

| 产物 | 来源字体 | 许可 | 字符集 | 规格 |
|---|---|---|---|---|
| `pixel8.pxf` | [unscii-16](http://viznut.fi/unscii/) | Public Domain | ASCII 95 字 | 8x16 |
| `pixel12.pxf` | [缤纷像素 fusion-pixel](https://github.com/TakWolf/fusion-pixel-font) 12px 等宽 zh_hans | SIL OFL-1.1 | ASCII + GB2312 一级汉字 (3755) + 常用标点/全角段 | ASCII 6x12, 汉字 12x12 |
| `pixel16.pxf` | fusion-pixel 8px 等宽 zh_hans, 2 倍放大 | SIL OFL-1.1 | 同 pixel12 | ASCII 8x16, 汉字 16x16 |

## 重新生成

```bash
# 一键: 下载字体源 + 生成三个 .pxf (需要网络)
./fetch_and_gen.sh

# 或手动:
python3 fontgen.py --hex unscii-16.hex --charset ascii \
    --out ../../firmware/components/hal_display/fonts/pixel8.pxf
python3 fontgen.py --bdf fusion-pixel-12px-monospaced-zh_hans.bdf \
    --charset ascii,gb2312-l1,punct \
    --out ../../firmware/components/hal_display/fonts/pixel12.pxf
python3 fontgen.py --bdf fusion-pixel-8px-monospaced-zh_hans.bdf \
    --charset ascii,gb2312-l1,punct --scale 2 \
    --out ../../firmware/components/hal_display/fonts/pixel16.pxf
```

## 字符集参数 (`--charset`, 逗号组合)

- `ascii` — U+0020..U+007E
- `gb2312-l1` — GB2312 一级汉字 3755 字 (按 Python 内置 gb2312 编解码器枚举, 无硬编码字表)
- `gb2312` — GB2312 全部汉字 6763 字
- `punct` — 常用中文标点 + 全角 ASCII 段 (U+FF01-U+FF5E)
- `file:<路径>` — 文本文件中出现的全部字符 (应用可按需定制字表瘦身)
- `range:4E00-9FA5` — 码点区间

## pxfont 二进制布局

见 `fontgen.py` 头注释与
`firmware/components/hal_display/include/hal_display/pxfont.h` (两处保持一致):
16 字节头 + 8 字节/字形记录 (码点升序, 供二分) + 位图池 (MSB=最左像素)。

其他选项: `--scale N` 整数放大;`--c-array out.c` 输出 C 数组;
`--preview "文本"` 终端点阵预览 (调试)。
