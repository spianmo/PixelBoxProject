# PixelBox 模拟器 IDE(simulator/)

Electron 桌面 IDE:编辑 PixelBox 应用(TypeScript)→ 一键在模拟器中运行 → 推送到真机热更新。

技术栈:electron + electron-vite + React 18 + TypeScript strict + Tailwind CSS + react-icons + i18next(zh-CN 默认 / en)+ monaco-editor。

## 开发与构建

```bash
npm install          # 若失败:npm install --registry=https://registry.npmmirror.com
npm run dev          # 开发模式(HMR)
npm run build        # 类型检查 + vite 三段构建(main/preload/renderer → out/)
npm run dist:mac     # electron-builder 打包(可选)
```

## 目录结构

```
simulator/
├── build/icon.png             # 应用图标(来自 docs/assets/app-icon.png)
├── electron.vite.config.ts    # main/preload/renderer 三段构建
├── electron-builder.yml       # 打包配置
├── src/
│   ├── shared/ipc-types.ts    # 三端共享的 IPC 数据类型
│   ├── main/                  # 主进程
│   │   ├── index.ts           # 窗口 + IPC 注册
│   │   ├── workspace.ts       # 工作区 fs + chokidar watch
│   │   ├── builder.ts         # esbuild 打包 / watch(输出流到控制台)
│   │   └── devd.ts            # mDNS 发现 + devd 协议真机推送
│   ├── preload/index.ts       # contextBridge → window.api
│   └── renderer/src/
│       ├── App.tsx            # 布局:工具栏|文件树|编辑器|设备面板|控制台
│       ├── editor/            # Monaco 环境(pixelbox.d.ts ?raw 注入补全)
│       ├── components/        # 工具栏/文件树/标签页/控制台/拖拽条/弹窗
│       ├── i18n/              # zh-CN / en 资源
│       └── device-sim/        # 设备模拟引擎(另行实现,见该目录 README.md)
└── ...
```

## 与设备模拟引擎的边界

IDE 外壳只负责:编辑、构建、日志、真机推送。像素屏渲染与 `px` API shim 由
`src/renderer/src/device-sim/` 实现(已完成),契约(`setupDeviceSim` / `window.__pixelboxSim` /
CustomEvent 上报)与实现说明见 `src/renderer/src/device-sim/README.md`。

## 设备模拟引擎(device-sim)速览

- 用户 bundle 在 **沙箱 iframe(sandbox="allow-scripts")** 内执行,注入与
  `sdk/types/pixelbox.d.ts` 完全对齐的 `px` / `pixelbox` shim(16 命名空间 + 标准全局,
  运行期 `verifySurface()` 缺一不启动);
- 特权操作(fetch / tcp / udp / mdns / 存储落盘)经 postMessage RPC → 宿主 → IPC → main;
- 屏幕 368×448 canvas 整数倍缩放 + pixelated + 白色圆角外框;麦克风 getUserMedia +
  AudioWorklet 重采样 16k PCM16;播放器 WebAudio;语音与真机同协议直连中继服务器;
- 右侧面板提供虚拟外设:电量/充电、BOOT 键、摇一摇、IMU 滑条、GPS、LED 灯带、摄像头;
- `drawText` 使用开源像素字体 **缝合像素字体 Fusion Pixel Font**(OFL-1.1,随库内嵌,支持中文)。

## 验证(demo → load 链路)

内置演示工程在 `demo/`(像素弹跳动画 + 触摸交互,使用说明见 `demo/README.md`)。

无 GUI 自检(构建产物走一遍 load 链路的静态部分):

```bash
npm run selfcheck
# [1/5] demo 按 builder.ts 同参数打包 → dist/main.js
# [2/5] 沙箱运行时打包(IIFE + 像素字体内嵌)
# [3/5] px shim 表面核对(16 命名空间 + 13 标准全局)
# [4/5] srcdoc 组装 + </script 逃逸核对
# [5/5] 产物语法解析
```

GUI 手测步骤(完整链路):

1. `npm run dev` 启动 IDE;
2. 「打开工作区」选择 `simulator/demo/`;
3. ▶ 运行:构建 → 沙箱 load → 右侧像素屏出现弹跳小球与中文像素字;
4. 鼠标点击/拖动屏幕(触摸)、BOOT 点按/长按、摇一摇、电量滑条逐一验证;
5. 修改 `demo/src/main.ts` 保存 → watch 热重载;
6. 底部「应用日志」应显示 `console.log` 输出;在代码里抛异常可见含堆栈的错误上报。

## 真机推送

工具栏「推送到设备」:mDNS 扫描 `_pixelbox._tcp` → 选择设备 → esbuild 构建 →
按 devd 协议(docs/architecture.md §5)`hello → app.push_begin → app.push_chunk → app.push_end`
分块上传,设备校验后原子切换并热重启 JS VM。
