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
│   ├── shared/ipc-types.ts    # 三端共享的 IPC 数据类型(含 DeviceProfile 设备档案)
│   ├── shared/chipCapabilities.ts # 芯片能力表【单一数据源】:S3/C6/P4/ESP32/C3 的
│   │                          #   WiFi/BLE/PSRAM/双核 + 档案校验 + 内置默认档案
│   ├── main/                  # 主进程
│   │   ├── index.ts           # 窗口(无边框/hiddenInset)+ IPC 注册
│   │   ├── shell.ts           # 窗口控制 / git 分支读取 / 截图落盘
│   │   ├── deviceProfiles.ts  # 虚拟设备档案 CRUD(userData/pixelbox-sim/devices.json)
│   │   ├── workspace.ts       # 工作区 fs + chokidar watch + 最近工作区 + 文件列举
│   │   ├── builder.ts         # esbuild 打包 / watch(输出流到构建工具窗)
│   │   ├── toolchain.ts       # ToolchainService:ESP-IDF 检测 / idf.py 多芯片构建·
│   │   │                      #   merge_bin 打包·烧录(流式日志/可取消)/ 串口扫描 / 设置
│   │   └── devd.ts            # mDNS 发现 + devd 协议真机推送
│   ├── preload/index.ts       # contextBridge → window.api
│   └── renderer/src/
│       ├── App.tsx            # JetBrains 风格布局:标题栏|轨道|项目树|编辑器|运行的设备|日志|状态栏
│       ├── shell/             # 外壳组件:TitleBar/ToolWindowRail/ToolWindow/StatusBar/
│       │                      #   LogsToolWindow(Logcat 风格)/RunningDevicesPanel/QuickOpen(⌘P)
│       ├── editor/            # Monaco 环境(pixelbox-dark 主题,pixelbox.d.ts ?raw 注入补全)
│       ├── components/        # 文件树/编辑器标签/拖拽条/弹窗/toast(含通知历史)
│       ├── i18n/              # zh-CN / en 资源
│       └── device-sim/        # 设备模拟引擎(另行实现,见该目录 README.md)
└── ...
```

## IDE 外壳(v2:JetBrains/Android Studio New UI 风格)

- **自绘标题栏**(40px):项目名下拉(最近工作区)+ git 分支;设备/目标芯片下拉 +
  ▶ 运行 / ⏹ 停止 / 🔨 构建 / 📤 推送 / ⋮;右侧 🔍(⌘P)/ ⚙(语言)/ 🔔(通知)。
  macOS 保留红绿灯(hiddenInset),Windows/Linux 自绘窗口控制按钮。
- **工具窗轨道**(44px):左=项目、设备管理器 + 构建/日志/问题;右=运行的设备。
  全部工具窗可拖拽调宽/高、可折叠。
- **底部工具窗**(Logcat 风格):日志(设备下拉 + `tag:xxx level:warn` 过滤 + 级别徽标,
  多模拟器并行时日志按来源设备路由)/ 构建(ANSI 着色)/ 问题(构建错误列表)。
- **状态栏**(26px):面包屑 + 后台任务;行:列 | UTF-8 | 空格数 | git 分支 | 当前设备。
- 色板经 CSS 变量承载(`assets/main.css`),Monaco 使用自定义 `pixelbox-dark` 主题。

## 设备管理器(v2 阶段 2:类 AVD Manager)

- **档案模型** `{id,name,chip,screenW,screenH,psramMB,flashMB,note,createdAt}`,
  chip ∈ esp32s3/esp32c6/esp32p4/esp32/esp32c3;持久化 `userData/pixelbox-sim/devices.json`;
  内置默认档案「PixelBox S3」(368×448 / PSRAM 8MB)不可编辑/删除(可复制)。
- **工具窗**(左轨道「设备管理器」):表格列 名称/芯片/分辨率/PSRAM/操作(编辑·复制·删除),
  行点击选为运行目标;「新建模拟器」向导(JetBrains 表单):名称、芯片下拉、
  分辨率预设(368×448 AMOLED 1.8″ / 240×240 / 320×240 / 466×466 / 240×536)+ 自定义 WxH
  (64–1024 校验)、PSRAM(无/2/8MB)、Flash(4/8/16MB)、备注。
- **芯片能力表**(`src/shared/chipCapabilities.ts`,单一数据源):
  - esp32s3:WiFi/BLE/PSRAM 可选/双核;esp32/esp32c3 合理默认(C3 无 PSRAM);
  - esp32c6:无 PSRAM → 档案 psramMB 强制 0,向导禁用该下拉;
  - esp32p4:无片上 WiFi/BLE(模拟中 `wifi.connect` 报 ENOTSUP、`ble.available()===false`,
    UI 提示需配套 ESP32-C6 hosted 模块)、有 PSRAM。
  能力表驱动沙箱 shim:`system.info()` 的 chip/capabilities/screen、
  `memory().psramFree`(psram=0 恒 0,大分配走内部堆语义)、wifi/ble 的 ENOTSUP 行为。
- **动态屏幕 + 多实例**:沙箱 init 携带 `{screenW,screenH,chip,psramMB,capabilities}`,
  运行时 screen shim 全面去硬编码;「运行的设备」按档案分辨率渲染并保持整数倍缩放;
  允许多个模拟器并行(每 tab 一个 iframe 沙箱实例),标题栏 ▶ 在运行中仍可对
  另一档案启动新会话(同档案 = 热重载);选中真机时 ▶ 分流为推送。
- **标题栏设备下拉**:虚拟设备(档案)分组 + mDNS 真机分组;「新建模拟器…」直达向导。

## 固件构建 / 打包 / 烧录(v2 阶段 3:多芯片工具链集成)

- **ToolchainService**(`src/main/toolchain.ts`):检测 ESP-IDF(设置覆盖 > `$IDF_PATH` >
  `~/esp/esp-idf`,解析 `esp_idf_version.h` 报版本);以 login shell(`$SHELL -lc`)运行
  `source export.sh && idf.py … build`,cwd = 仓库 `firmware/`;输出逐行流式经 IPC
  (`toolchain:log`)到底部「构建」tab(ANSI 解析);可取消(SIGTERM 进程组,3s 后补 SIGKILL);
  产物路径与体积随 `toolchain:done` 汇报。
- **多目标构建目录**(与 `firmware/README.md` 约定一致,防止污染默认 sdkconfig):
  esp32s3 沿用默认 `build/`;其余 `-B build_<后缀> -D SDKCONFIG=build_<后缀>/sdkconfig`
  (如 `build_c6` / `build_p4`);`set-target <chip>` 仅在构建目录未配置或目标不匹配时插入
  (它会清空构建目录,无脑执行会毁掉增量缓存)。
- **打包**:⋮ →「打包 merged.bin」= build 后接 `idf.py merge-bin`(内部 esptool merge_bin
  `@flash_args`),合成单文件 `firmware/dist/<target>-merged.bin`,通知含路径与大小。
- **烧录**:⋮ →「烧录…」打开端口对话框(每 2s 轮询 `cu.usbmodem*`/`cu.wchusbserial*`/
  `cu.SLAB*` 等);无设备时显示下载模式指引(按住 BOOT 插线);选定端口后
  `idf.py -B <dir> -p <port> -b <baud> flash`;烧录中按钮禁用防重入。
- **标题栏**:目标芯片下拉(esp32s3/c6/p4/esp32/c3,持久化)接真;🔨 = 构建当前目标
  (任务进行中变为取消);⋮ 含 打包/烧录/清理构建(清理 = 删除该目标构建目录)。
- **设置页**(⚙ →「IDE 设置…」):ESP-IDF 路径覆盖、默认目标芯片、烧录波特率,
  持久化 `userData/pixelbox-sim/toolchain.json`。
- 已知环境兼容:export.sh 按 login shell 的 python3 小版本推导 venv,Homebrew 升级
  Python 后会指向不存在的 venv;服务会扫描 `~/.espressif/python_env` 中与 IDF
  主次版本匹配的既有 venv 并经 `IDF_PYTHON_ENV_PATH` 固定。

无 GUI 真实执行自检(会触发一次真实固件构建,增量缓存下较快):

```bash
npm run check:toolchain          # 默认 merge esp32s3;可 -- --kind build --target esp32c6
# [1/5] 打包生产代码 toolchain.ts(electron 桩)
# [2/5] 检测 ESP-IDF 版本 + 串口扫描(无设备环境 = 空数组 → 对话框指引分支)
# [3/5] 非法烧录端口防护(toolchain:badPort)
# [4/5] 真实 login shell + idf.py build + merge-bin,断言 toolchain:log 数据流
#       与 firmware/dist/<target>-merged.bin 落盘体积
# [5/5] 启动后 1.5s 取消,断言进程树被杀、done.cancelled=true、状态复位
```

固件构建/烧录 GUI 手测:标题栏芯片选 `ESP32-S3` → 🔨 构建(「构建」tab 流式输出,
状态栏「构建固件中…」)→ ⋮「打包 merged.bin」(通知含路径与大小)→ ⋮「烧录…」:
无设备时确认「未检测到串口 + BOOT 指引」且持续扫描;插入设备后端口出现,开始烧录,
期间 ⋮ 各项与「开始烧录」禁用;⚙「IDE 设置…」修改波特率/默认目标后重开对话框生效。

## 与设备模拟引擎的边界

IDE 外壳只负责:编辑、构建、日志、真机推送。像素屏渲染与 `px` API shim 由
`src/renderer/src/device-sim/` 实现(已完成),契约(`setupDeviceSim` / `window.__pixelboxSim` /
CustomEvent 上报)与实现说明见 `src/renderer/src/device-sim/README.md`。

## 设备模拟引擎(device-sim)速览

- 用户 bundle 在 **沙箱 iframe(sandbox="allow-scripts")** 内执行,注入与
  `sdk/types/pixelbox.d.ts` 完全对齐的 `px` / `pixelbox` shim(16 命名空间 + 标准全局,
  运行期 `verifySurface()` 缺一不启动);
- 特权操作(fetch / tcp / udp / mdns / 存储落盘)经 postMessage RPC → 宿主 → IPC → main;
- 屏幕 canvas 分辨率取设备档案(内置档案 368×448),整数倍缩放 + pixelated +
  白色圆角外框;麦克风 getUserMedia +
  AudioWorklet 重采样 16k PCM16;播放器 WebAudio;语音与真机同协议直连中继服务器;
- 右侧面板提供虚拟外设:电量/充电、BOOT 键、摇一摇、IMU 滑条、GPS、LED 灯带、摄像头;
- `drawText` 使用开源像素字体 **缝合像素字体 Fusion Pixel Font**(OFL-1.1,随库内嵌,支持中文)。

## 验证(demo → load 链路)

内置演示工程在 `demo/`(像素弹跳动画 + 触摸交互,使用说明见 `demo/README.md`)。

无 GUI 自检(构建产物走一遍 load 链路的静态部分):

```bash
npm run selfcheck
# [1/7] demo 按 builder.ts 同参数打包 → dist/main.js
# [2/7] 沙箱运行时打包(IIFE + 像素字体内嵌)
# [3/7] px shim 表面核对(16 命名空间 + 13 标准全局)
# [4/7] srcdoc 组装 + </script 逃逸核对
# [5/7] 产物语法解析
# [6/7] 芯片能力表 ↔ d.ts capabilities 字段一致性(单一数据源不漂移)
# [7/7] 运行时初始化断言(Node vm + DOM 桩,真实实例化 ScreenImpl/createSystem/createWifi):
#       368×448(esp32s3)与 240×240(esp32c6)两档案的帧缓冲尺寸 /
#       info().chip·screen·capabilities / psramFree(C6 恒 0)/ P4 wifi ENOTSUP
```

GUI 手测步骤(完整链路):

1. `npm run dev` 启动 IDE;
2. 标题栏项目下拉「打开工作区…」选择 `simulator/demo/`;
3. ▶ 运行:构建 → 沙箱 load → 右侧「运行的设备」像素屏出现弹跳小球与中文像素字;
4. 鼠标点击/拖动屏幕(触摸)、BOOT 点按/长按、摇一摇、电量滑条逐一验证;
   面板左缘工具条验证 重载/截图(落盘 ~/Downloads)/旋转/静音/缩放;
5. 修改 `demo/src/main.ts` 保存 → watch 热重载;⌘P 模糊打开文件;
6. 底部「日志」应显示 `console.log` 输出(支持 `tag:xxx level:warn` 过滤);
   在代码里抛异常可见含堆栈的错误上报,构建错误进入「问题」tab。

设备管理器 / 多档案手测(demo 在 368×448 与 240×240 两档案下运行):

1. 左轨道打开「设备管理器」→「新建模拟器」:名称 `Mini 240`、芯片 `ESP32-C6`、
   分辨率 `240×240`;确认 PSRAM 下拉被禁用为「无」(C6 无 PSRAM);创建成功后表格新增一行;
2. 内置档案「PixelBox S3」行:编辑/删除按钮禁用(锁形提示),复制可用;
3. 标题栏设备下拉:确认「虚拟设备」分组列出两档案(含分辨率/芯片)与「新建模拟器…」入口;
4. 选择「PixelBox S3」▶ 运行 → 像素屏为 368×448;再选择「Mini 240」▶ 运行 →
   「运行的设备」出现第二个 tab,画布为 240×240 并保持整数倍缩放,两实例并行运行;
5. demo 使用 `px.screen.width/height` 自适应:240×240 下小球在小屏内弹跳,布局不越界;
6. 底部「日志」设备下拉切换两档案:各自只显示自己会话的 `console.log`;
7. 在 240×240(C6)会话的应用里调 `px.system.memory()`:`psramFree === 0`;
   `px.system.info().chip === 'esp32c6'`、`screen` 为 240×240;
8. 新建 `ESP32-P4` 档案运行:`px.wifi.connect()` 拒绝并提示 ENOTSUP(需配套 C6 hosted);
9. 修改 demo 保存 → watch 热重载同时作用于两个运行中的 tab;
   tab ✕ 逐个关闭,最后一个关闭后 watch 停止;标题栏 ⏹ 一键停全部。

## 真机推送

标题栏「推送到设备」:mDNS 扫描 `_pixelbox._tcp` → 设备下拉选择真机 → esbuild 构建 →
按 devd 协议(docs/architecture.md §5)`hello → app.push_begin → app.push_chunk → app.push_end`
分块上传,设备校验后原子切换并热重启 JS VM。
