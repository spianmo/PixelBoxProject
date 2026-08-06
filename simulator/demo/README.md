# 像素弹跳 —— 模拟器内置演示工程

一个用于验证 PixelBox 模拟器全链路(构建 → 沙箱加载 → 渲染 → 交互)的最小演示应用。

## 使用方法

1. 启动模拟器 IDE:在 `simulator/` 下执行 `pnpm run dev`
2. 工具栏点击「打开工作区」,选择本目录(`simulator/demo`)
3. 点击 ▶ 运行:esbuild 打包 `src/main.ts` → 沙箱加载 → 右侧像素屏出现弹跳小球
4. 交互验证:
   - 鼠标点击/拖动像素屏 → 触摸生球(`px.input.onTouch`)
   - 右侧「按键」分组点按 BOOT → 切换配色;按住超过 600ms → 长按清场(`onButton`)
   - 「按键」分组点「摇一摇」→ 球群获得随机冲量(`px.sensors.imu.onShake`)
   - 修改 `src/main.ts` 保存 → watch 自动重建并热重载
5. 最高球数经 `px.storage.kv` 持久化,重开应用仍在(落盘于
   `userData/pixelbox-sim/demo/kv.json`)

## 覆盖的 API

`px.screen`(onFrame/setFps/fillCircle/drawLine/drawText 中文像素字体)、
`px.input`(onTouch/onButton)、`px.sensors.imu.onShake`、
`px.audio.player.tone`、`px.storage.kv`、`px.color`。
