# device-sim — 设备模拟引擎(已实现)

本目录归 **device-sim 领域智能体** 所有:除 `types.ts` 中已有签名不可更改外,目录内文件可自由增改。
IDE 外壳(sim-shell)只依赖本文档描述的三个契约点(§1–§3,保持不变);§5 起为实现说明。

## 1. 入口函数(必须保留)

`index.ts` 导出:

```ts
export function setupDeviceSim(
  container: HTMLElement,
  opts?: SetupDeviceSimOptions // 兼容参数;阶段 2 起分辨率由会话档案驱动,详见 §8
): PixelboxSimApi | null
```

- 外壳在右侧「运行的设备」面板挂载后调用一次,`container` 是一个已铺满面板可用区域的空 `div`。
- 引擎在其中渲染:**像素屏 canvas**(分辨率取当前会话的设备档案,内置档案 368×448;
  整数倍缩放优先、`image-rendering: pixelated`、白色圆角盒子外框、右下角缩放百分比标签)、
  左缘竖排工具条(电源/重载/截图/旋转/音量/缩放)与虚拟外设控件(BOOT / 摇一摇 / 电量 /
  IMU / GPS / 灯带 / 摄像头,触摸即鼠标);无会话时为空态提示。
- 初始化完成后:挂 `window.__pixelboxSim` → 派发 `pixelbox-sim:ready` → 返回同一 API 对象。

## 2. window.__pixelboxSim(运行控制)

| 外壳动作 | 调用 |
|---|---|
| 运行 ▶(构建成功后) | `__pixelboxSim.load(bundleCode, manifest)` |
| watch 重建成功(热重载) | 再次 `load(...)`,引擎先优雅停旧应用(onExit → 400ms 宽限) |
| 停止 ⏹ | `__pixelboxSim.stop()` |

**追加约定(已知会 sim-shell,见 `types.ts` 末尾)**:外壳在每次 `load` 之前设置
`window.__pixelboxSimContext = { workspaceRoot, outDir }`,引擎据此:

- 经 `window.api.sim.readTree(outDir)` 预载 dist/ 全量(沙箱内 `/app` 只读包);
- 以 `basename(workspaceRoot)` 定位 `userData/pixelbox-sim/<workspace名>/` 存储目录并预载
  `/data` 与 kv(契约的同步 fs/kv 由内存镜像 + 异步写穿实现)。

## 3. 事件上报(引擎 → 外壳)

与原契约一致:`pixelbox-sim:ready` / `pixelbox-sim:log`(应用 console.* 与运行时错误)/
`pixelbox-sim:state`(running / stopped / crashed)。未捕获异常与未处理 Promise 拒绝
均含堆栈上报;应用模块求值阶段的错误判为 crashed。

## 4. 特权操作通道

沙箱 iframe(`sandbox="allow-scripts"`,opaque origin)→ postMessage RPC(`protocol.ts` 信封)
→ 宿主 `engine.ts` 分发 → `window.api.sim`(`src/preload/simApi.ts`)→ main 进程
`src/main/simbridge.ts`(fetch 代理 / net·dgram / bonjour-service / userData 存储)。
main/preload 仅新增 device-sim 自有文件,未改动 workspace/builder/devd 的既有导出
(workspace.ts 追加了 `getWatchedRoot()` 导出供路径防护)。

## 5. 架构与文件导览

```
device-sim/
├── protocol.ts            # 宿主 ⇄ 沙箱消息信封 + 负载类型(两端共同引用)
├── engine.ts              # SimEngine:iframe 生命周期 / RPC 分发 / rAF 帧节拍 / 帧绘制
├── store.ts               # 轻量可订阅状态(引擎 ⇄ React 面板)
├── host/
│   ├── audioPlayerHost.ts # WebAudio:play/playPcm/openPcmStream/tone/stopAll/音量
│   ├── micHost.ts         # getUserMedia + AudioWorklet → 线性重采样 → PCM16 分帧(多消费者)
│   ├── cameraHost.ts      # 电脑摄像头:capture(jpeg)/startStream/预览流
│   └── netRelay.ts        # tcp/udp/mdns 资源登记与应用退出时统一回收
├── panel/SimPanel.tsx     # 右侧面板:屏幕 + 可折叠外设分组(react+tailwind+i18n)
└── sandbox/
    ├── esbuildRuntimePlugin.ts  # Vite 插件:runtime 打成 IIFE 字符串(virtual: 模块)
    ├── fonts/                   # 缝合像素字体 zh_hans woff2 ×2 + OFL.txt
    └── runtime/                 # ↓ 沙箱内运行时(esbuild 单文件,注入 srcdoc)
        ├── index.ts             # 启动序列 / px 组装 / 全局覆写 / bundle 执行
        ├── surface.ts           # 验收红线:16 命名空间 + 13 标准全局缺一不启动
        ├── screen.ts            # 全套绘图 API / 离屏画布 / 帧动画 / GIF / flush
        ├── images.ts            # fast-png · jpeg-js · gifuct-js 同步解码 + colorKey
        ├── fonts.ts             # FontFace(ArrayBuffer) 注册,pixel8/12/16 映射
        ├── audio.ts / voice.ts  # 播放代理 · 麦克风分发 · record(wav) · 语音状态机+VAD
        ├── net.ts               # fetch / WebSocket 包装 / tcp / udp / mdns / wifi 模拟
        ├── storage.ts           # /app·/data 虚拟 FS(内存镜像 + 异步写穿)+ kv
        ├── periph.ts            # input/sensors/gps/led/ble/camera/system/app
        └── rpc.ts events.ts util.ts
```

关键决策:

- **沙箱执行**:iframe `srcdoc` 内联运行时(继承宿主 CSP,已在 index.html 放行
  `'unsafe-inline'` / `blob:` / `'unsafe-eval'`,仅本地开发工具使用);用户 ESM bundle
  经 `Blob → import(url)` 执行,失败回退 `(0, eval)`。
- **帧管线**:沙箱隐藏 canvas 同步绘制 → `flush()` `getImageData` → ArrayBuffer
  **transfer** → 宿主可见 canvas `putImageData`。`onFrame` 节拍由宿主 rAF 按 `setFps`
  节流驱动(隐藏 iframe 的 rAF 会被 Chromium 冻结,故由宿主发 tick),dt 为沙箱实测毫秒。
- **同步 API 的异步落盘**:`storage.fs/kv` 读内存镜像、写内存后异步写穿 main;
  与真机 LittleFS 在应用视角行为一致。
- **语音**:与真机同协议(architecture.md §7)直连中继服务器;能量 VAD
  (阈值 + `vadSilenceMs` 静音判定),speaking 中连续人声帧触发 barge-in `interrupt`;
  `say()` 使用服务器扩展消息 `tts.request`。
- **像素字体**:缝合像素字体(Fusion Pixel Font,TakWolf,**SIL OFL 1.1**,许可文件
  `sandbox/fonts/OFL.txt` 随库分发)8px/12px 简中子集 woff2 以 base64 打进 runtime,
  `pixel8`→8px、`pixel12`→12px、`pixel16`→8px 字形 2 倍整数放大。
- **ble**:`available() === false`,其余方法抛 `Error("ENOTSUP")`(与真机默认 Kconfig 一致);
  LED 灯带默认同样不可用,面板开关打开后 `available()===true` 且 `show()` 内容可视化。

## 6. 已知简化(与真机的差异)

- `setRotation` 仅旋转屏幕显示(CSS transform),`screen.width/height` 不随之交换;
- `system.deepSleep` 仅熄屏(+定时重启),不模拟低功耗;`otaApply` 抛 ENOTSUP;
- `wifi` 为模拟数据:scan 返回内置 AP 列表、connect 800ms 后成功、status 反映宿主联网状态;
- PCM 流 `buffered()` 为 feed 回执 + 时间衰减的估算值;
- 沙箱 `setTimezone` 不改变 Date 时区(沿用宿主)。

## 7. 验证

- `npm run build`(typecheck node+web + electron-vite 三段构建)通过;
- `npm run selfcheck`:demo 构建 → 运行时打包 → shim 表面静态核对(16+13)→ srcdoc
  逃逸 → 语法解析,全绿;
- GUI 手测步骤见 `simulator/README.md`「验证」一节与 `simulator/demo/README.md`。

## 8. 阶段 2:设备管理器与多实例(已落地)

阶段 1 预留的接入点已在 v2 阶段 2 全部接入,当前形态:

1. **多实例会话**(`sessions.ts`):每个「运行的设备」tab = 一个 `SimSession`
   = 一个 `SimEngine` 实例 = 一个沙箱 iframe(消息按 `ev.source` 过滤互不串扰)。
   `simSessionsStore` 可订阅(tab 条 / SimHost 共用);`ensureSession(profile)` 按档案
   建/复用会话,`closeSession(key)` 停止并 `engine.dispose()`(移除全局监听防泄漏)。
2. **facade API**(`index.ts`):`setupDeviceSim(container)` 渲染 `panel/SimHost.tsx`
   (激活会话的 SimPanel / 空态),`window.__pixelboxSim` 为 facade:
   - `load()`:按 `window.__pixelboxSimContext.device`(`DeviceProfile`,外壳运行前写入)
     选择/创建会话后对其热重载;缺省回退内置档案(368×448);
   - `stop()`:停止全部会话;`running`:任一会话运行中。
   §1–§3 既有契约签名未动;`getSimEngine()` 兼容保留(= 激活会话引擎)。
   watch 热重载走 `reloadRunningSessions()`(对全部运行中的会话热重载)。
3. **设备档案注入**:`SimEngine` 构造需 `{ profile, deviceKey }`;`protocol.ts` 的
   `SandboxInitPayload.device: SimDeviceInit` 携带 `{chip,screenW,screenH,psramMB,flashMB,
   capabilities,wifi}`(由 `src/shared/chipCapabilities.ts` 单一数据源派生),驱动沙箱:
   - `screen.ts`:`ScreenImpl` 分辨率动态(帧缓冲/flush/onFrame 全部经 `this.width/height`);
   - `periph.ts`:`system.info()` 的 chip/screen/capabilities 按档案返回;
     `memory().psramFree` 按 psramMB 模拟(0 = 无 PSRAM,恒 0,大分配走内部堆语义);
   - `net.ts`:`createWifi(log, hasWifi)`,无片上 WiFi(ESP32-P4)时 connect/scan/startAP
     报 ENOTSUP、status 恒离线;ble 维持 available()===false(真机默认 Kconfig)。
4. **日志按设备路由**:引擎在 `pixelbox-sim:log` / `pixelbox-sim:state` 的 detail 上附加
   `SimDeviceTag { deviceKey, deviceName }`(types.ts 末尾追加的可选字段,旧监听方兼容);
   外壳底部日志按设备下拉(`shellDeviceStore.selectedKey`)过滤。
5. **外壳数据源**:`shell/store.ts` 的 `deviceProfilesStore`(main 进程
   `devices.json` 持久化,内置档案「PixelBox S3」不可编辑/删除);
   `selectedKey` = `'sim:<profileId>'` 或真机 `ip:port`,运行/推送按 key 分流。

仍留给阶段 3:`chip` 目标芯片与固件构建(`idf.py set-target`)联动(标题栏 🔨 当前仍为
esbuild 应用构建);真机日志流接入底部日志设备下拉。
