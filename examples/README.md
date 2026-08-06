# PixelBox 示例应用

四个由浅入深的示例,覆盖屏幕绘制、网络、语音对话与传感器。每个示例均为标准 PixelBox 应用结构:

```
0x-name/
├── pixelbox.json   # 应用 manifest
├── tsconfig.json   # types 指向 ../../sdk/types/pixelbox.d.ts(唯一 API 契约)
├── src/main.ts     # 入口
└── README.md
```

| 示例 | 演示内容 |
|---|---|
| [01-hello-pixel](./01-hello-pixel/) | onFrame 逐帧渲染、弹跳像素 Logo、color.hsv 彩虹渐变 |
| [02-pixel-clock](./02-pixel-clock/) | ntpSync 对时、大字号像素时钟、fetch 天气(wttr.in)、触摸切换表盘 |
| [03-voice-assistant](./03-voice-assistant/) | voice 语音对话全流程、状态动画、流式字幕、打断(interrupt) |
| [04-sensor-playground](./04-sensor-playground/) | IMU 重力小球物理、onShake 换色、电池/内存状态栏 |

## 运行方式

- **模拟器**:模拟器 IDE 打开示例目录 → 运行(左侧文件树可直接改代码热重载)。
- **真机**:`cd 0x-name && pixelbox dev`(watch 构建 + 自动推送 + 日志),或 `pixelbox build && pixelbox push`。

## 统一验证

```bash
pnpm install    # 仓库根执行(pnpm workspace);失败时加 --registry=https://registry.npmmirror.com
cd examples
pnpm run build  # 对每个示例执行 tsc --noEmit + esbuild --bundle → dist/main.js
```
