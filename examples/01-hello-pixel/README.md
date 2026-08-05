# 01 你好像素

PixelBox 的 "Hello World":一只点阵像素盒子 Logo 在屏幕上弹跳,颜色沿对角线做彩虹渐变,撞墙时变色并发出提示音。

## 演示的 API

| API | 用途 |
|---|---|
| `px.screen.onFrame(cb)` | 逐帧渲染主循环,`dt` 为帧间隔毫秒,回调返回后自动 flush |
| `px.screen.setFps(60)` | 提高目标帧率让动画更顺滑 |
| `px.screen.fillRect / clear / drawText / measureText` | 基础绘制与文本排版 |
| `px.color.hsv(h, s, v)` | HSV 转 24 位 RGB,做彩虹渐变最方便 |
| `px.audio.player.tone(freq, ms, vol)` | 碰壁提示音 |

## 运行

- 模拟器:打开本目录直接运行。
- 真机:`pixelbox dev`(需先完成配网,见 docs/getting-started.md)。

## 可以动手改的地方

- 把 `LOGO` 点阵换成你自己的图案(`#` 实心 / `.` 透明);
- 调整 `SCALE`、`vx/vy` 感受像素风与速度的关系;
- 试试把 `drawLogo` 改成先画进 `px.screen.createCanvas()` 离屏画布再 `drawImage`。
