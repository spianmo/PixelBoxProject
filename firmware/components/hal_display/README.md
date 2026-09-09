# hal_display — LVGL 9 渲染与双 DMA 面板提交

实现 `PxScreen` / `PxDrawTarget` 的底层绘图；现有 JS 方法、参数和即时读写语义保持兼容。

## 绘制通路

`bindings_screen → gfx → LVGL 9.2.2 RGB565 软件渲染 → 逻辑画布 → 双 DMA 行带 → esp_lcd`

- `gfx.cpp#render_fill` / `render_image` 直接调用 LVGL 软件渲染器的同步 RGB565 入口，
  填色和位图合成不建立对象树，也不为每个矩形创建控件或分配绘图任务。
  此适配使用固定版本的 LVGL 渲染描述符；升级 LVGL 时必须重新验证像素兼容性。
- 主画布与离屏画布使用同一渲染路径；几何的整数光栅规则、像素字体排版、EPX 放大、
  最近邻采样和二值透明规则保持一致。`getPixel` 在绘图调用后立即可读。
- RGB565 画布采用 LVGL 原生字节序。PNG/GIF/JPEG 解码统一到该格式，DMA 发送前用
  `lv_draw_sw_rgb565_swap` 只交换行带，不修改原画布。JS 仍使用 `0xRRGGBB`。
- `mark_dirty` 保留 8 个脏矩形槽，相交/相邻自动合并，满槽时选择面积增长最小者。
  `flush` 只发送脏区；系统覆盖层仍按 pre → 提交 → post 运行，恢复应用原像素。

## 双缓冲 DMA

SH8601 / CO5300 QSPI 和 ST7789 SPI 共用 `dma_pipeline.hpp#DmaPipeline`：

1. 第一次把逻辑画布的行带旋转、打包、交换字节到 A，启动 DMA。
2. CPU 准备 B，与 A 的 DMA 发送重叠；A 完成后才提交 B。
3. 交替复用 A/B，最后等待在途事务完成，再从 `flush` 返回。

缓冲固定为内部 `MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL` 内存，64 字节对齐。
CO5300 480×480 使用两个 480×32×2 字节缓冲，共 **60 KiB**；相对原单缓冲增加 30 KiB。
SH8601 使用两个 368×32×2 字节缓冲，共 46 KiB。主画布仍优先 PSRAM。
ST7789 行带高度来自 `CONFIG_PX_DISPLAY_STRIP_LINES`，单带上限 32 KiB。

每次等待 DMA 的上限为 250ms；超时或提交失败保留脏区。超时仍保留在途缓冲所有权，
后续刷新/旋转/亮度/电源操作先回收该事务，防止复用正在发送的内存。
每次最多一笔颜色事务在途，窗口命令在上一带完成后发出。
这里重叠的是行带准备与 DMA，JS 绘图与 `flush` 仍在同一线程同步执行。

面板引脚、时钟、尺寸来自 `boards`。软件旋转支持 0/90/180/270；90/270 交换逻辑宽高。
熄屏保留脏区，亮屏重推整屏；无屏板型继续返回 ENOTSUP。

## 资源和验证

图片解码仍使用 pngle/miniz、gifdec 和 `esp_new_jpeg`；像素字表与许可见
`tools/fontgen/README.md`。LVGL 由组件管理器按版本 9.2.2 获取，许可证为 MIT。

```sh
# 在 firmware 获取依赖后，运行宿主机测试；每项最长 60 秒。
idf.py reconfigure
components/hal_display/test_host/build_run.sh
```

测试覆盖颜色/裁剪/图片/字体、所有 65,536 个 RGB565 颜色、跨行块透明缩放、非方形画布旋转，
以及模拟异步 DMA 的交替、超时、错误恢复和原画布不变。
`pixels_compat` 将 368×448 样张与迁移前提交 `1d14263` 的 RGB 输出 SHA256 比较。

真机性能需烧录后测量；双 DMA 不保证自动达到 20 FPS。example06 音频缓冲保护会跳过绘图，
验收必须统计完成实际 draw + flush 的帧，并另测语音网络并发。TE 同步尚未接入，
双 DMA 不能保证消除面板撕裂。逐次传路径的 drawImage 仍会解码，动画应复用已解码画布。
