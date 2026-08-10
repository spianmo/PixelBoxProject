# PixelBox 像素盒 — 总体架构 (v0.1)

> 本文档与 `sdk/types/pixelbox.d.ts` 共同构成全项目对齐基准。任何子项目实现与本文冲突时,以本文 + d.ts 为准;需要变更先改这里。

## 1. 产品定义

桌面像素动画小盒子:ESP32-S3 + 1.8" AMOLED,支持语音大模型对话(麦克风+扬声器),内嵌完整 JS 运行时(QuickJS-ng),用户用 **TypeScript** 开发盒子上的应用,通过 CLI / 模拟器 IDE **一键热更新**推送到真机。

- 代号:**PixelBox(像素盒)**;npm scope `@pixelbox`;CLI 命令 `pixelbox`;mDNS 服务 `_pixelbox._tcp`。

## 2. 仓库结构(monorepo)

```
esp32_devices/
├── docs/                  # 架构、协议、硬件落地指南、产品图
│   ├── architecture.md    # 本文档
│   ├── assets/            # 产品渲染图
│   └── hardware/          # PCB/外壳/打板 新手指南
├── firmware/              # ESP-IDF 5.5 工程 (C++17+)
│   ├── CMakeLists.txt  partitions.csv  sdkconfig.defaults
│   ├── main/              # app_main: 板级初始化 -> 启动 JSVM/devd
│   └── components/
│       ├── hal_common/    # 板级抽象接口 (board api / 事件定义)
│       ├── boards/        # 板型实现 (Kconfig 选择)
│       ├── jsvm/          # QuickJS-ng 集成 + 事件循环 + 模块注册表 + prelude
│       ├── appmgr/        # 应用包管理 + LittleFS + 热更新落盘/原子切换
│       ├── devd/          # 开发服务: WS 8765 + mDNS + 日志广播
│       ├── hal_display/  bindings_screen/
│       ├── hal_audio/    bindings_audio/   voicechat/
│       ├── hal_net/      bindings_net/
│       └── hal_periph/   bindings_periph/
├── sdk/                   # @pixelbox/sdk: d.ts 契约 + CLI(create/build/dev/push/logs)
├── simulator/             # Electron 模拟器 IDE (react+ts+twcss+react-icons+i18n+Monaco)
├── server/                # 语音中继服务器 (Node+TS: STT/LLM/TTS 可插拔)
├── examples/              # 示例应用 (像素动画/时钟/语音助手/传感器)
└── tools/                 # 字体生成、依赖拉取等脚本
```

## 3. 硬件方案

### Stage A — 开发板直接落地(推荐首发,零 PCB 门槛)

**微雪 Waveshare ESP32-S3-Touch-AMOLED-1.8**(淘宝/微雪官网有售,约 ¥2xx):

| 部件 | 型号 | 接口 |
|---|---|---|
| MCU | ESP32-S3R8 (16MB Flash + 8MB Octal PSRAM) | — |
| 屏幕 | 1.8" AMOLED 368×448,驱动 **SH8601** | QSPI |
| 触摸 | FT3168 | I2C |
| 音频 | **ES8311** codec + 板载 MEMS 麦克风 + 喇叭接口(功放板载) | I2S + I2C |
| IMU | QMI8658 | I2C |
| 电源 | AXP2101 PMU + 锂电池接口 | I2C |
| RTC | PCF85063 | I2C |

固件通过 `boards` 组件 Kconfig 选择板型(`BOARD_WAVESHARE_AMOLED_18` 默认 / `BOARD_CUSTOM_V1`),引脚全部收敛在板型文件,**其他组件禁止硬编码引脚**。引脚定义以微雪 wiki 原理图为准(docs/hardware 中记录)。

### Stage B — 定制 PCB(进阶,见 docs/hardware 指南)

在 Stage A 基础上增加:OV2640 摄像头(DVP)、ATGM336H GPS(UART)、WS2812 灯带、USB-C、定制外壳。这些外设在固件中均有 Kconfig 开关,默认关闭,`available()` 返回 false。

### 3.1 多目标支持矩阵(v2 新增,详见 docs/hardware/multi-target.md)

固件在 ESP-IDF v5.5 下支持三个目标芯片整包编译,能力按芯片**诚实降级**
(不支持的域按 d.ts 契约注册 ENOTSUP 行为,available/状态接口如实返回):

| 能力 | esp32s3(默认) | esp32c6 | esp32p4 |
|---|---|---|---|
| 核心 | 双核 Xtensa 240MHz | 单核 RISC-V 160MHz | 双核 RISC-V 360MHz |
| PSRAM | 8MB Octal | 无(内部 ~512KB HP SRAM) | 有(EV 板 32MB HEX) |
| Flash / 分区表 | 16MB / partitions.csv | 8MB / partitions_8mb.csv | 16MB / partitions.csv |
| 默认板型 | BOARD_WAVESHARE_AMOLED_18 | BOARD_GENERIC_SPI | BOARD_HEADLESS |
| 屏幕 | SH8601 QSPI 368×448(整帧中转) | ST7789 SPI 240×240(行带 flush) | 无屏(px.screen 抛 ENOTSUP) |
| 音频 (px.audio/voice) | ✅ ES8311 | Kconfig 默认关(ENOTSUP 桩) | 编译在,板无 codec → caps=false |
| WiFi (px.wifi/net/fetch/WS) | ✅ | ✅(WiFi 6) | ❌ 无片上 WiFi → ENOTSUP 桩;esp_hosted TODO |
| BLE (px.ble) | ✅ NimBLE | ✅ NimBLE | ❌ 无片上蓝牙(available=false) |
| devd/mDNS | ✅ | ✅ | 跳过启动(不报错) |
| JS 堆默认 (JSVM_MEM_LIMIT_KB) | 4096KB @PSRAM | 256KB @内部堆 | 4096KB @PSRAM |
| js_task 绑核 | 核 1 | 核 0(单核) | 核 1 |

- 板型 Kconfig:微雪板/定制 PCB `depends on IDF_TARGET_ESP32S3`;新增
  `BOARD_GENERIC_SPI`(通用 SPI 屏,引脚全 Kconfig,无触摸/IMU/PMU,能力位如实 false)
  与 `BOARD_HEADLESS`(无屏调试)。
- 大缓冲分配统一走 `hal_common/px_alloc.h` 的 `px_alloc_prefer_psram()` 系列:
  有 PSRAM 优先 PSRAM,无 PSRAM 目标自动落内部堆。
- 无网络目标的条件编译以 `CONFIG_SOC_WIFI_SUPPORTED` 为准(CMake 源文件级切换 + 桩实现)。

## 4. 固件架构

- ESP-IDF **v5.5**,C/C++ 混合,C++ 侧 C++17 及以上(跟随 IDF 默认 gnu++2x),无异常/无 RTTI,错误用 `esp_err_t`。
- JS 引擎:**quickjs-ng**(vendored 到 `firmware/components/jsvm/quickjs-ng/`,`tools/fetch_deps.sh` 负责 clone,固定 tag)。JS 堆分配经 `px_alloc_prefer_psram()` 优先 PSRAM,上限 `CONFIG_JSVM_MEM_LIMIT_KB` 按目标取默认(S3/P4 = 4MB;无 PSRAM 的 C6 = 256KB,落内部堆)。
- 线程模型:
  - `js_task`(pinned core 1,栈默认 32KB **内部 RAM**):唯一执行 JS 的线程。循环 = 取事件队列 → 执行 → 泵 Promise jobs → 检查定时器。
  - 其他任务(audio/net/lvgl-free 渲染等)通过 **事件循环投递** 与 JS 交互,禁止跨线程直接调 JS_*。

> **实现决策:js_task 栈为何默认放内部 RAM 而非 PSRAM。**
> js_task 会直接执行 LittleFS 文件读写(加载应用入口、`px.app.readAsset`、`px.storage.fs` 等)。
> ESP32-S3 在 SPI flash 擦写期间会关闭指令/数据 cache,此时**栈位于 PSRAM 的任务一旦访问栈就会触发崩溃**
> (PSRAM 本身也经 cache 访问)。因此 `CONFIG_JSVM_TASK_STACK_KB`(默认 32KB)的栈默认分配在内部 RAM;
> QuickJS 的栈溢出检查阈值按 (栈大小 − 12KB) 自动适配,给原生侧留安全余量。
> 提供 `CONFIG_JSVM_TASK_STACK_IN_PSRAM`(默认 n)供确认 JS 线程完全不触碰 flash
> (或启用 flash 自动挂起特性)的场景开启,以节省内部内存——谨慎使用。

### 4.1 jsvm 核心 API(fw-core 提供,其余组件依赖)

```cpp
// components/jsvm/include/jsvm/jsvm.hpp
namespace jsvm {
  // 线程安全:把 fn 投递到 JS 线程执行
  void post(std::function<void()> fn);
  // JS 回调句柄:构造时 dup,支持从任意线程 invoke(内部走 post)
  class Callback { public: void invoke_with(/* 构造参数的打包函数 */); ... };

  using NativeInit = void (*)(JSContext* ctx, JSValue px /* px 根对象 */);
  struct Module {
    const char* name;      // 如 "screen"
    int priority;          // 小者先初始化;core=0, hal 域=10
    NativeInit init;       // 在 px 上挂域对象与方法
    const char* prelude;   // 可选:该域的 JS 增强片段(在所有 native init 后按 priority 执行)
  };
  void register_module(const Module& m); // 静态构造期调用
}
#define JSVM_REGISTER_MODULE(mod) /* 静态对象自注册,组件需 WHOLE_ARCHIVE */
```

- 每个 `bindings_*` 组件用 `JSVM_REGISTER_MODULE` 自注册,`idf_component_register(... WHOLE_ARCHIVE)` 防止链接器裁剪。
- **绑定原则:native 直接注册 d.ts 中的最终公开方法名**(如 `px.screen.fillRect`),JS 侧 prelude 片段只做纯 JS 糖(EventEmitter、Animation 包装、参数校验)。三端方法名必须与 d.ts 完全一致。
- 标准全局(console/定时器/fetch/WebSocket/TextEncoder/atob/performance)由 fw-core 的 prelude + 对应 native 提供。

### 4.2 分区表(16MB)

```
# Name,    Type, SubType,  Offset,   Size
nvs,       data, nvs,      0x9000,   0x6000
otadata,   data, ota,      0xf000,   0x2000
phy_init,  data, phy,      0x11000,  0x1000
ota_0,     app,  ota_0,    0x20000,  0x600000
ota_1,     app,  ota_1,    ,         0x600000
storage,   data, littlefs, ,         0x3D0000
```

`storage` 挂载 `/flash`,内含 `/flash/data`(px.storage.fs 映射为 `/data`)、`/flash/apps`(应用包)。

**双分区表策略(唤醒词)**:默认构建用上表 `partitions.csv`;唤醒词构建(`firmware/sdkconfig.wakeword` 叠加,见 firmware/README.md「启用唤醒词」)切换为 `partitions_wakeword.csv` —— 唯一差异是 `storage` 压缩 0x58000,尾部腾出 `model` 数据分区(352KB)存放 esp-sr 打包的 `srmodels.bin`(wn9 中文唤醒词模型实测约 284KB,余量约 24%)。app/nvs/otadata 布局两表完全一致,两种固件可互相 OTA。

### 4.3 应用包与热更新

应用包目录:`/flash/apps/current/{manifest.json, main.js, assets/**}`;推送先写 `/flash/apps/staging/`,`push_end` 校验通过后原子重命名切换,再**仅重启 JS VM**(不重启芯片)。manifest 字段见 §6。

### 4.4 系统按键与配网路径

系统按键集中在 `firmware/main/system_keys.cpp`(键序 = 外壳物理顺序):

| 手势 | 动作 |
|---|---|
| 键1 Boot(GPIO0)短按 | 打开内置设置页 |
| 键2 PWR(PMU 轮询)短按 | 返回应用页 / 退出设置页 / 退出配网 |
| 键2 长按 ~2s | 清空推送应用回欢迎页(**别按满 6s** —— 那是 AXP2101 硬断电兜底) |
| 键3 User(GPIO18)短按 | 息屏/亮屏切换 |
| 键3 长按 1.2s | 屏显关机提示 → 深度睡眠(再按键3 开机) |
| **键1 + 键3 同时按住 2s** | **网页配网模式** |

> **键2 为何不能参与组合键。** 真机实测 SYS_OUT(GPIO16)感知线路不可用,PWR 键事件唯一可靠来源是 200ms 轮询 AXP2101 的 PKEY IRQ 状态寄存器。该寄存器只报"短按/长按已发生",读不到"当前是否按住",因此组合键只能用键1 + 键3(两者都是常规 GPIO 键,Down/Up 全程可知)。
>
> 两个实现约束:① 键3 长按 1.2s 关机会抢在 2s 组合键之前,故键1 按下期间键3 的 LongPress 必须无条件忽略;② `iot_button` 的 `SINGLE_CLICK` 在 `PRESS_UP` **之后**才送达,所以组合键触发后的抑制标志不能在 Up 时清,改为该键下一次 Down 时清。
>
> 多目标:`system_keys.cpp` 直接调 `axp2101_available()` / `axp2101_poll_pkey()`,而 `axp2101.c` 只在带 PMU 的 S3 板型编入,故无 PMU 板型(`BOARD_GENERIC_SPI` / `BOARD_HEADLESS`)编 `boards/src/axp2101_stub.c` 补齐符号,`available()` 恒 false → 键2 无事件,其余按键照常。

配网有两条路径:

1. **设置页触屏配网**(`components/appmgr/src/settings_app.js` 的 `wifi`/`pass` 两页):屏上 WiFi 列表 + QWERTY 键盘。小屏敲 WPA2 长密码痛苦,无触摸板型不可用。
2. **网页配网**(`components/wifi_portal/`):设备开 SoftAP → 手机连上 → 浏览器填表 → 设备连目标 WiFi。屏幕全程显示热点名称、密码、`192.168.4.1` 与连接状态。

网页配网关键决策:

- **原生 C++ 绘制而非内置 JS 页。** 配网期间必须独占屏幕(应用每帧 `clear` 会盖掉热点密码),干净做法是 `appmgr_stop_app()` 停掉 JS VM —— 而 `js_task` 是无限循环,VM 停止后**仍在泵 `post` 队列**,所以原生代码依然能经 `jsvm::post` 在 JS 线程上安全画帧(帧缓冲与 QSPI IO 归 JS 线程所有,同 `system_keys.cpp` 的关机流程)。这样也不新增 JS API,免去 `sdk/types/pixelbox.d.ts` 契约与 simulator 的同步工作。
- **不动 STA。** `start_ap()` 走 APSTA 共存,误触进配网不掐断已有连接;配网未成功就退出时用 `WifiManager::reconnect_saved()` 把设备放回原状态。
- **密码错误不会覆盖好凭据。** 沿用 `connect(..., save=true)` 的既有语义 —— 凭据拿到 IP 后才写 NVS。
- **扫描是按钮触发而非自动。** APSTA 下扫描会让 AP 短暂离开信道,自动扫描会莫名踢掉手机。
- **httpd 端口 80 + `ctrl_port` 32801。** devd 那个 httpd 实例占用默认 `ctrl_port`(32768),两个实例共用同一 UDP 控制端口会让后启动的绑定失败。
- captive portal 靠 DHCP 选项 `ESP_NETIF_CAPTIVEPORTAL_URI` + 404 处理器 302 跳转兜住 `/hotspot-detect.html`、`/generate_204` 等探测;选项设置失败只降级为"手动开浏览器",不算错误。
- 多目标:无片上 WiFi 的目标(P4)编 `wifi_portal_stub.cpp`,`start()` 返回 `ESP_ERR_NOT_SUPPORTED`,`active()` 恒 false,组合键退化为无操作。

## 5. devd 开发服务协议(热更新/日志/REPL)

- 传输:`ws://<device-ip>:8765/devd`,文本帧 JSON。请求 `{id, method, params}`;响应 `{id, result}` 或 `{id, error:{code, message}}`;主动事件 `{event, data}`。
- 发现:mDNS `_pixelbox._tcp`,port 8765,TXT: `model`, `fw`, `app`。

| method | params | result |
|---|---|---|
| `hello` | `{}` | `{name, model, fw, app, appVersion, ip, mac, heapFree}` |
| `app.push_begin` | `{manifest, files:[{path,size,sha256}]}` | `{session}` |
| `app.push_chunk` | `{session, path, offset, dataB64}` (≤32KB/块) | `{received}` |
| `app.push_end` | `{session}` | `{ok:true}` → 校验+切换+热重启 VM |
| `app.restart` / `app.stop` | `{}` | `{ok:true}` |
| `js.eval` | `{code}` | `{result}`(字符串化) |
| `logs.subscribe` / `logs.unsubscribe` | `{since?}` | `{ok:true, last_seq, boot}` |

事件:`log {level, tag, msg, ts, seq}`(console.* 与 ESP_LOG 均转发;`seq` 单调递增,设备重启归零)、`app.state {state: 'running'|'stopped'|'updating'|'crashed', error?}`。

日志订阅语义:`logs.subscribe {since}` 先在响应中返回 `last_seq`(设备当前最大 seq)与 `boot`(每次开机随机标识),随后回放环形缓冲中 `seq > since` 的历史,再持续推送新日志。客户端断线重连时携带已见最大 seq 增量续传;若响应 `boot` 与上次不同(或兜底:`last_seq` 小于已见 seq),说明设备已重启,应以 `since=0` 重新订阅并清空本地已展示日志。回放与广播两路水位刻意不合并(避免新订阅者抬升全局水位使其他订阅者丢行),交叠的重复行由客户端按 `seq` 去重。连接存活靠 WebSocket ping/pong(httpd 自动应答);设备硬重启不发 FIN,客户端须心跳判死链。

## 6. 应用 manifest(pixelbox.json)

```json
{
  "id": "com.example.pixelclock",
  "name": "像素时钟",
  "version": "1.0.0",
  "entry": "main.js",
  "assets": ["assets/**"],
  "minFirmware": "0.1.0"
}
```

SDK 构建:esbuild 把 `src/main.ts` 打包为单文件 ES2020 `dist/main.js`(无 npm 运行时依赖,纯 JS 库可打入)。

## 7. 语音中继协议(device/simulator ↔ server)

`ws://<server>:8787/realtime?token=<token>`

- **上行二进制**:PCM16LE 单声道 16kHz 麦克风帧(listening 期间持续发送)。
- **上行文本**:`{type:'session.start', device, sampleRate}`、`{type:'speech.end'}`(设备端 VAD 判定说完)、`{type:'interrupt'}`、`{type:'text.input', text}`、`{type:'tts.request', text}`(扩展消息,见下)。

> **实现决策:上行扩展消息 `{type:"tts.request", text}`。**
> `px.voice.say(text)` 仅有 TTS 语义(把给定文本播报出来),与 `sendText` 的"走 LLM 再 TTS"不同。
> 设备/模拟器对 `say()` 上行 `tts.request`,服务器收到后**直接调 TTS 推流回设备,不把该文本写入 LLM
> 对话上下文**,避免污染后续对话。服务器同时兼容历史别名 `{type:"say", text}`(等价处理)。
- **下行文本**:`{type:'stt.final', text}`、`{type:'llm.delta', text}`、`{type:'llm.done', text}`、`{type:'tts.begin', sampleRate}`、`{type:'tts.end'}`、`{type:'error', message}`。
- **下行二进制**:TTS 的 PCM16LE 单声道(采样率以 `tts.begin` 为准)。

服务器职责:接 PCM → STT(OpenAI 兼容 /audio/transcriptions,可配硅基流动等)→ LLM(OpenAI 兼容 chat/completions 流式)→ TTS(OpenAI 兼容 /audio/speech,请求 PCM/WAV 格式)→ 推流回设备。全部 baseURL/key/model 走 `.env`。收到 `interrupt` 立即停止当前 TTS 推流。

设备端 voicechat 状态机:`idle → listening(VAD 收音) → thinking(等 LLM) → speaking(播 TTS) → idle`;speaking 中检测到用户说话(barge-in)→ 发 `interrupt` 并回到 listening。VAD 默认能量法(esp-sr wakenet/vadnet 留 Kconfig 开关,默认关)。唤醒词:`sdkconfig.wakeword` 构建启用 esp-sr wakenet(默认"Hi,乐鑫"),`configure({wakeword:true})` 后 idle 态待机侦听,命中投递 `wake` 事件并自动进入 listening(见 §4.2 双分区表)。

## 8. SDK / CLI(`@pixelbox/sdk`)

命令:
- `pixelbox create <dir>`:从模板创建应用(tsconfig 引用 types/pixelbox.d.ts、pixelbox.json、src/main.ts 示例)。
- `pixelbox build`:esbuild 打包 + 拷贝 assets 到 dist/。
- `pixelbox push [--device <ip|name>]`:走 devd 协议推包;不指定设备时 mDNS 发现并列出。
- `pixelbox dev`:watch 构建 + 自动 push + 订阅日志输出到终端。
- `pixelbox logs [--device ...]`:仅日志。
- `pixelbox devices`:列出局域网设备。

## 9. 模拟器 IDE(simulator/)

技术栈:**Electron + Vite + React 18 + TS strict + Tailwind + react-icons + i18next(zh/en)+ Monaco**。

布局:左侧文件树(打开工作区文件夹)→ 中间 Monaco 编辑器(TS 高亮/补全,注入 pixelbox.d.ts 为 extraLib,联想全部设备 API)→ 右侧设备面板(像素屏 canvas + 虚拟外设控件)→ 底部控制台(console 输出/构建日志)。

设备模拟核心(`src/renderer/src/device-sim/`):
- 用户代码经 esbuild(main 进程)打包后,在**沙箱 iframe** 中执行;iframe 内注入与 d.ts 完全对齐的 `px` shim,特权操作经 postMessage RPC → renderer host → IPC → main。
- screen → canvas(368×448,整数倍缩放、crisp 像素);audio.mic → getUserMedia;audio.player → WebAudio;fetch → 经 main 进程代理(免 CORS);WebSocket → 直连;tcp/udp → main 进程 net/dgram 桥;storage → userData 目录;input.touch → 鼠标;button/shake/battery/GPS → 右侧面板控件;led → 虚拟灯带;camera → 电脑摄像头;voice → 与真机同协议直连中继服务器。
- 工具栏:▶ 运行 / ⏹ 停止 / 🔄 热重载(watch 自动)/ 📤 推送到真机(devd 协议 + mDNS 发现)。

## 10. 一致性与验收规则(全体智能体必读)

1. `sdk/types/pixelbox.d.ts` 是唯一契约:固件 bindings、模拟器 shim 的对象层级/方法名/参数/返回值必须逐一对齐;硬件未启用时实现 `available() === false` + 其余方法抛 `Error("ENOTSUP")`,禁止静默吞掉。
2. 事件回调全部通过事件循环投递到 JS 线程;订阅函数必须返回可用的 Unsubscribe。
3. 只创建/修改自己负责的路径;跨组件只依赖 `hal_common`/`jsvm` 公开头文件。
4. Node 侧项目必须 `pnpm install && pnpm run build`(或 tsc --noEmit)通过(monorepo 为 pnpm workspace,根目录一次安装);固件侧保证组件自洽(头文件/依赖/idf_component.yml 完整),整体编译由审计阶段统一执行修复。
5. 注释与文档使用中文;TS 全部 strict;不引入未使用的依赖。
