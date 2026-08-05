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

## 4. 固件架构

- ESP-IDF **v5.5**,C/C++ 混合,C++ 侧 C++17 及以上(跟随 IDF 默认 gnu++2x),无异常/无 RTTI,错误用 `esp_err_t`。
- JS 引擎:**quickjs-ng**(vendored 到 `firmware/components/jsvm/quickjs-ng/`,`tools/fetch_deps.sh` 负责 clone,固定 tag)。JS 堆分配走 PSRAM(自定义 malloc),上限 4MB。
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

### 4.3 应用包与热更新

应用包目录:`/flash/apps/current/{manifest.json, main.js, assets/**}`;推送先写 `/flash/apps/staging/`,`push_end` 校验通过后原子重命名切换,再**仅重启 JS VM**(不重启芯片)。manifest 字段见 §6。

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
| `logs.subscribe` / `logs.unsubscribe` | `{}` | `{ok:true}` |

事件:`log {level, tag, msg, ts}`(console.* 与 ESP_LOG 均转发)、`app.state {state: 'running'|'stopped'|'updating'|'crashed', error?}`。

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

设备端 voicechat 状态机:`idle → listening(VAD 收音) → thinking(等 LLM) → speaking(播 TTS) → idle`;speaking 中检测到用户说话(barge-in)→ 发 `interrupt` 并回到 listening。VAD 默认能量法(esp-sr wakenet/vadnet 留 Kconfig 开关,默认关)。

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
4. Node 侧项目必须 `npm install && npm run build`(或 tsc --noEmit)通过;固件侧保证组件自洽(头文件/依赖/idf_component.yml 完整),整体编译由审计阶段统一执行修复。
5. 注释与文档使用中文;TS 全部 strict;不引入未使用的依赖。
