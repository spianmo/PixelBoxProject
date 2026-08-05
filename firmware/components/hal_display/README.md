# hal_display — AMOLED 显示 HAL + 软件绘图引擎

对应 d.ts 契约 `PxScreen`/`PxDrawTarget` 的底层实现,供 `bindings_screen` 调用。

## 组成

```
include/hal_display/
├── hal_display.hpp    # 面板 HAL: init/framebuffer/mark_dirty/flush/亮度/电源/旋转
├── gfx.hpp            # 软件绘图引擎 (RGB565, 与 esp_lcd 解耦, 可宿主单测)
├── pxfont.h           # pxfont 位图字体二进制视图 (tools/fontgen 产物)
├── fonts.h            # 内置字体 pixel8/pixel12/pixel16 访问
└── image_decode.hpp   # PNG/JPEG/GIF → RGB565 表面统一解码
src/                   # 各模块实现
vendor/                # vendored: pngle+miniz (MIT), gifdec (PD, 有内存化改造)
fonts/                 # 内置字体 .pxf (EMBED_FILES 编入 flash)
test_host/             # 宿主机单测 (./build_run.sh)
```

## 关键设计

- **面板通路**: 组件注册表 `espressif/esp_lcd_sh8601` (QSPI 368x448),
  引脚/时钟全部来自 `boards` 组件 (`board_display_config()`),零硬编码。
- **帧缓冲**: 全屏 RGB565 逻辑帧缓冲位于 **PSRAM** (~322KB);另有等大
  PSRAM 中转缓冲 (64B 对齐) 供 DMA — 兼顾旋转重排、对齐要求与撕裂安全。
- **脏矩形**: 绘图经 `mark_dirty()` 登记 (8 槽,相交/相邻自动合并,槽满
  并入面积增长最小者);`flush()` 仅推送脏区并等待 DMA 完成。
- **字节序**: 帧缓冲直接按面板期望的大端 565 存储 (`PX_GFX_SWAP16`),
  颜色换算只在绘图调用入口发生一次,DMA 直发零转换。
- **旋转**: 软件坐标变换 (`setRotation` 后逻辑尺寸互换,flush 时逆变换
  收集到中转缓冲),MADCTL 保持不动。
- **亮度**: SH8601 命令 `0x51` (QSPI 下 32bit 命令 `0x02 cmd 0x00`),
  初始化序列已发 `0x53=0x20` 使能亮度控制。
- **电源**: `setPower(false)` = display off + sleep in (AMOLED 深度省电);
  亮屏自动整屏重推。
- **绘图引擎** (`gfx`): 全部先裁剪后绘制,热路径无虚调用;
  `fillRect`/`clear` 首行铺满后按行 `memcpy`;`blit` 无缩放无键时按行
  `memcpy`,否则 16.16 定点最近邻 + colorKey + 可选 1bpp alpha 掩码;
  `drawText` UTF-8 逐字渲染,支持 `\n`、整数放大 (1-8)、left/center/right 对齐。
- **图片解码**: PNG 用 vendored pngle (alpha<128 记入透明掩码,直接
  `drawImage` 时生效);JPEG 用 `espressif/esp_new_jpeg` 输出 RGB565
  (仅固件目标,宿主单测不含);GIF 用 vendored gifdec 逐帧合成。
- **字体**: `pixel8` (unscii-16, 8x16 ASCII) / `pixel12` (缤纷像素 12px,
  含 GB2312 一级汉字) / `pixel16` (缤纷像素 8px×2, 含汉字),
  生成工具与许可见 `tools/fontgen/README.md`。

## 已知取舍

- `drawImage` 传路径/二进制时每次调用都会解码;动画请用
  `createAnimation`/`loadGif` (帧预解码为 PSRAM 画布)。
- 解码 PNG 转成画布 (`createCanvas`/动画帧) 后 alpha 掩码不保留
  (画布无 alpha 通道),需要透明请使用 `colorKey`。
- TE (撕裂同步) 引脚暂未使用;30fps 下 QSPI 全帧 ~8ms,撕裂不明显。

## 宿主机单测

```bash
cd test_host && ./build_run.sh    # gfx/字体/PNG/GIF 共 84 项断言
```
