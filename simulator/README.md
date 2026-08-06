# PixelBox 模拟器 IDE(simulator/)

Electron 桌面 IDE:编辑 PixelBox 应用(TypeScript)→ 一键在模拟器中运行 → 推送到真机热更新。

技术栈:electron + Rsbuild/Rspack + React 18 + TypeScript strict + Tailwind CSS + react-icons + i18next(zh-CN 默认 / en)+ monaco-editor。

## 开发与构建

```bash
pnpm install          # 仓库根执行(pnpm workspace);若失败:pnpm install --registry=https://registry.npmmirror.com
                      # 首次下载 Electron 二进制建议带镜像(pnpm 不透传 .npmrc 的 electron_mirror):
                      # ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ pnpm install
pnpm run dev          # 开发模式(scripts/dev.mjs 编排:renderer HMR + main/preload watch + electron 自动重启)
pnpm run build        # 类型检查 + Rsbuild 三 environments 构建(main/preload/renderer → out/)
pnpm run dist:mac     # electron-builder 打包(可选)
```

构建系统为 Rsbuild(Rspack)多 environments:main/preload 走 node target
(CJS、node-pty/esbuild 等运行时 require 外部化),renderer 走 web target
(React Fast Refresh / Tailwind / Monaco worker chunk / `?raw` 内嵌 d.ts /
`import.meta.webpackContext` 设置页收集);沙箱运行时虚拟模块由
`scripts/sandboxRuntimeLoader.cjs` 在构建期以 esbuild 固化(IIFE → base64,
metafile 依赖全部纳入 watch)。v2.5 由 electron-vite 迁移而来,同机实测:
生产构建(不含 typecheck)12.5s → 2.7s,dev 冷启动(启动至 renderer 首次
主题回报)2.66s → 2.49s;产物布局 out/{main,preload,renderer} 与
electron-builder 配置零改动。

## 目录结构

```
simulator/
├── build/icon.png             # 应用图标(来自 docs/assets/app-icon.png)
├── rsbuild.config.ts          # main/preload/renderer 三 environments 构建(Rsbuild/Rspack)
├── electron-builder.yml       # 打包配置
├── scripts/dev.mjs            # dev 编排:devServer + watch 写盘 + electron 启停/重启
├── scripts/sandboxRuntimeLoader.cjs # 沙箱运行时虚拟模块 loader(esbuild IIFE → base64)
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
pnpm run check:toolchain          # 默认 merge esp32s3;可 -- --kind build --target esp32c6
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
- 虚拟外设(电量/充电、BOOT 键、摇一摇、IMU 滑条、GPS、LED 灯带、摄像头)收纳在
  「运行的设备」左缘工具条分隔线下的分组图标里,点击图标右侧弹出气泡 popover 承载表单
  (同时只开一个,点外部/Esc 关闭;充电中/LED 开等活动状态在图标右上角显示小圆点);
- `drawText` 使用开源像素字体 **缝合像素字体 Fusion Pixel Font**(OFL-1.1,随库内嵌,支持中文)。

## 验证(demo → load 链路)

内置演示工程在 `demo/`(像素弹跳动画 + 触摸交互,使用说明见 `demo/README.md`)。

无 GUI 自检(构建产物走一遍 load 链路的静态部分):

```bash
pnpm run selfcheck
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

1. `pnpm run dev` 启动 IDE;
2. 标题栏项目下拉「打开工作区…」选择 `simulator/demo/`;确认项目树顶部为带徽标的
   根项目行,目录/文件图标为 JetBrains 线性风格(ts 蓝方块、json 黄花括号、md 蓝 M↓ 等),
   且与编辑器标签、⌘P 快速打开列表中的图标一致;
3. ▶ 运行:构建 → 沙箱 load → 右侧「运行的设备」像素屏出现弹跳小球与中文像素字;
   全局通知(运行成功/构建失败等)出现在窗口右下角状态栏上方、向上堆叠:
   标题 12px + 正文 11px 小字,4s 自动消失(错误 8s),悬停暂停计时,✕ 手动关,
   点击卡片展开长文本;🔔 通知历史同步记录;
4. 鼠标点击/拖动屏幕(触摸)验证;左缘工具条验证 重载/截图(落盘 ~/Downloads)/
   旋转/静音/缩放;分隔线下依次点开 电源/按键/IMU/GPS/LED/摄像头 分组图标:
   右侧气泡 popover 弹出对应表单(BOOT 点按/长按、摇一摇、电量滑条+充电、IMU 三轴+重置、
   GPS 输入+发送定位+持续上报、LED 开关+色块预览、摄像头说明);同时只开一个,
   点外部/Esc/再点图标关闭;开启充电或 LED 后图标右上角出现小圆点;
   外设收纳后屏幕画布独占纵向空间,缩放适应自动复算;
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

集成终端 GUI 手测(JetBrains 式底部终端,阶段 1;无 GUI 自检见 `pnpm run check:terminal`):

1. 左轨道点击终端图标(问题图标上方):底部区切到 Terminal 窗并自动创建 `Local` 会话;
   `echo hi` / `ls` 有彩色输出与行编辑(node-pty 不可用时顶部黄色横幅明示 pipe 兜底体验受限);
2. 头部 [+] 新建会话(`Local (2)` 编号补位)、tab ✕ 关闭、双击 tab 重命名、
   [˅] 会话下拉跨组切换;
3. tab 右键「向右拆分 / 向下拆分」:任意嵌套分栏、分隔条拖拽按占比、组内末 tab 关闭自动拼合;
4. 终端内 ⌘K 清屏;⌘F 搜索条(输入即增量定位,Enter 下一个 / Shift+Enter 上一个 / Esc 关闭);
5. 日志窗 ⇄ 终端窗切换、底部区关闭重开:会话与滚回缓冲不丢(xterm 实例常驻);
   打开工作区后新建会话的 cwd 为工作区根(`pwd` 验证),`exit` 退出后 tab 自动移除。

工具窗视图模式手测(五态,阶段 2):

1. 任一工具窗头部 ⋮(终端窗为其自带 ⋮ 尾部的「视图模式」组)或头部空白处右键:
   停靠固定 / 停靠自动隐藏 / 取消停靠 / 浮动 / 独立窗口,当前模式打勾;
   切换后编辑器 / 终端 / 设备画布布局自动复位(rAF resize + fit);
2. 「停靠自动隐藏」:面板以覆盖层浮出(不挤压编辑器),点击编辑器等外部区域自动收起,
   点击轨道图标重新弹出(轨道图标豁免,不触发收起);「取消停靠」:同覆盖层但常驻,
   仅轨道图标或改模式可收;
3. 「浮动」:面板变为浮窗(标题栏空白处拖动、边角八向拉伸,#393B40 边框阴影),
   位置尺寸按工具窗记忆,重启后恢复;终端浮动时可与底部日志窗同时显示;
4. 「独立窗口」:终端窗整体移入独立深色窗口(会话与主窗互通 —— 两边输入输出实时同步);
   底部日志窗在「构建」tab 激活时可将构建输出镜像到独立窗口(触发一次固件构建验证流式输出);
   项目树 / 结构 / 日志 / 问题 / 设备管理器 / 运行的设备 的该项置灰,悬停提示
   「该窗口暂不支持独立窗口」;
5. 关闭独立窗口(✕ 或工具窗 — 按钮):对应工具窗自动回「停靠固定」;模式按工具窗持久化
   (localStorage),重启 IDE 后除独立窗口外均恢复;主窗关闭时独立窗口级联关闭。

设置窗口 GUI 手测(JetBrains Settings 复刻,独立窗口;无 GUI 自检见 `pnpm run check:settings`):

1. 标题栏 ⚙(或再次点击即聚焦既有窗口):独立设置窗口约 980×700,左 240px 分类树
   (圆角搜索框过滤 + 高亮 + 回车跳转,可折叠分类,选中整行蓝底)+ 面包屑与 ←/→ 历史;
2. 草稿语义:改任意项后「应用」点亮,OK = 应用 + 关窗,Cancel/Esc 丢弃,切页草稿保留,
   带草稿点 ✕ 弹确认框;界面语言切换在本窗口立即预览(Apply 才落盘广播);
3. 消费方即时生效(无需重启):编辑器 minimap/字号/Tab/字体族 → Monaco;终端字号 →
   已开会话;IDF 路径 → 实时检测回显;默认芯片 → 标题栏芯片下拉;快捷键页只读键位表;
4. 位置/尺寸记忆:挪动/调整设置窗口 → 关闭重开还原(统一 windowState 机制,见下)。

字体手测(Inter + JetBrains Mono,@fontsource 内嵌,离线可用):

1. 断网启动 `pnpm run dev`:UI 文字(标题栏/菜单/设置表单)为 Inter(数字 1 无衬线平底、
   R 直腿;中文回退 PingFang SC/微软雅黑,13px 密度不变);
2. 编辑器打开 .ts 文件:代码为 JetBrains Mono(小写 l 带尾勾、0 内点),
   设置 › 编辑器 › 字体族清空/改名后仍回退 JetBrains Mono,字号项联动生效;
3. 终端 xterm、Markdown 预览代码块、底部日志/构建输出同为 JetBrains Mono。

会话恢复手测(启动恢复上次状态;设置 › 系统设置 › 「启动时恢复上次会话」默认开):

1. 打开工作区 + 打开若干文件并滚动/移动光标 → 挪动主窗位置、调整左右栏宽/底部区高、
   切换底部到终端并拆分若干组 → 正常退出(⌘Q);
2. 再次 `pnpm run dev`:主窗回到上次位置尺寸(最大化状态亦还原,越界显示器自动校正),
   自动重开上次工作区与全部标签(激活标签、滚动与光标位置一致;已删除文件静默跳过),
   布局(栏宽/开关/底部视图)与终端分栏树形状还原(会话为全新 shell);
   dev 终端可见 `[session-restore] …` 恢复摘要日志;
3. 上次工作区被删除后启动:toast 通知「上次的工作区已不存在」并回欢迎页;
4. 关闭「启动时恢复上次会话」后重启:默认布局 + 欢迎页(不重开工作区/标签/窗口位置);
5. 无 UI 驱动的冒烟:`PIXELBOX_SMOKE_SESSION=1 pnpm run dev`(第一轮:自动改窗口位置 +
   打开 demo 工作区与文件后正常退出)→ `PIXELBOX_SMOKE_SESSION=2 pnpm run dev`
   (第二轮:观察 `[session-restore]` 恢复日志后自动退出)。

macOS 全屏手测(v2.5 起为**原生全屏 Space**;实现见 `src/main/fullscreen.ts`):

1. 绿灯 / ⌃⌘F / 菜单「进入全屏幕」任一入口:进入真正的原生全屏 Space(四指横滑可
   切换 Space),**无任何拦截转换**——不会再出现 v2.4.x「进去又被自动退出来」的观感;
2. 红绿灯由 AppKit 管理:全屏常驻态不可见,鼠标悬停屏幕顶部时随系统工具条显示
   (与 VS Code 等一致);TitleBar 在全屏时自动取消左侧 80px 红绿灯预留区(内容左移),
   退出恢复;系统菜单栏是否在全屏显示跟随系统设置(系统设置 › 控制中心);
3. 窗口内容顶部第一行即自绘标题栏主题色,无系统灰色标题条(经截屏像素断言验证);
4. 全屏中再按 ⌃⌘F 或点绿灯:退出并精确恢复进入前的窗口位置尺寸;
5. 全屏中退出应用(⌘Q)后重启:随会话恢复直接回到全屏(「启动时恢复上次会话」开启时;
   v2.4 旧 fullscreen/simpleFullScreen 持久化字段兼容读取);
6. 无 UI 驱动的冒烟:`PIXELBOX_SMOKE_FS=1 pnpm run dev`(setFullScreen 原生入口 →
   断言 native=true 且非 simple、bounds 铺满显示器、退出回窗口态、bounds 精确恢复);
7. 视觉级验证(真实 mac GUI,`pnpm run check:fullscreen`):dev 启动 → 程序化进原生
   全屏 → `screencapture` 截屏(无屏幕录制权限时自动经 Terminal.app 助手降级;两路均
   不可用则如实降级为 AppKit 状态断言并打印授权指引)→ PIL 像素断言:标题栏横带众数
   ≈ 主题色(dark #2B2D30 / light #F7F8FA,无灰条,双候选行兼容菜单栏叠占)为硬断言;
   红绿灯三色簇在原生全屏常驻态**预期不可见**,仅如实记录不判负;退出 bounds 恢复,
   打印 `[fs-visual] PASS/FAIL`。注意:macOS **锁屏状态下系统会拒绝全屏 Space 过渡**,
   本检查需在解锁的 GUI 会话运行。

## 字体与许可致谢

IDE 全局 UI 字体与 JetBrains New UI 一致:**Inter**(UI,400/500/600/700)与
**JetBrains Mono**(代码/终端/日志/MD 代码块,400/700),经 `@fontsource/inter`、
`@fontsource/jetbrains-mono` 随包内嵌(woff2 由 vite 打包,完全离线可用),中文回退系统字体
(PingFang SC / 微软雅黑)。两款字体均以 **SIL Open Font License 1.1(OFL)** 授权:

- Inter — Copyright 2016 The Inter Project Authors(<https://github.com/rsms/inter>)
- JetBrains Mono — Copyright 2020 The JetBrains Mono Project Authors
  (<https://github.com/JetBrains/JetBrainsMono>)

OFL 允许自由使用/内嵌/再分发(不得单独出售字体本身);完整许可文本见
`node_modules/@fontsource/inter/LICENSE` 与 `node_modules/@fontsource/jetbrains-mono/LICENSE`。

## 真机推送

标题栏「推送到设备」:mDNS 扫描 `_pixelbox._tcp` → 设备下拉选择真机 → esbuild 构建 →
按 devd 协议(docs/architecture.md §5)`hello → app.push_begin → app.push_chunk → app.push_end`
分块上传,设备校验后原子切换并热重启 JS VM。
