# Speech and Network Diagnosis (2026-09-06)

## 2026-09-08 流式时延优化（本次未烧录）

已定位并修正以下等待点，历史真机数字不能用作本次更新的实测结果：

- example07 `HarnessController.respond` 原来等待 `conversation.ask()` 完成才调用 TTS。
  现在在增量回调交给 `StreamingSpeech`，首句/短分句尽早合成，无标点等待 300 ms；
  其后边播放边积累，单段最多 240 个 Unicode 字符，实际播放完成后才进入待机。
  取消会清除排队文字和定时器；最终文本修订未提交尾部时正常更新，若重写已提交前缀则
  停止追加语音，字幕仍显示最终文本。300 ms 不包括云端合成或 JS 调度延迟。
- `MexusConversation.prepare` 在待机或录音时提前做 TLS/hello，首个问题复用会话。
  预连接不发送用户问题；退出释放连接，等待预连接的旧轮可立即取消。
- ESP WebSocket client 1.8.0 默认收发共锁，`esp_websocket_client_send_with_exact_opcode`
  和接收路径争用 `client->lock`。已开启库自带 `ESP_WS_CLIENT_SEPARATE_TX_LOCK`，
  独立 TX 锁等待上限为 2000 ms；默认 build 的生成头文件已核实生效。
- Azure WSS ASR 的正常 PCM 发包阈值从 3200 字节（100 ms）降到 1280 字节（40 ms）。
  VAD 的 800 ms 静音结束边界保持不变，避免缩短网络延迟同时截断正常停顿。
- ESP-IDF `esp_http_client_read` 会循环等待填满调用缓冲。原生 TTS 改在
  `HTTP_EVENT_ON_DATA` 到达时直接喂 PCM，首包不再等待 2048 字节；HTTP 读取以 100 ms
  超时检查取消，连续 15 秒没有音频报错。TLS 握手/响应头仍有 15 秒 I/O 边界，
  单段 120 秒总截止不变。不能把 100 ms 描述为所有网络阶段取消的硬上限。
- 相邻 TTS 段复用已完整消费的 HTTPS 连接，空闲 15 秒或开始 ASR 即释放；旧连接失效
  且尚未播音时重连一次。换区域/密钥、错误响应和截断不会复用。PCM 满环且残留半帧时
  现在拒收并等待调用方重试，修复此前跨包字节丢失。
- example06 首播积累从 256 ms 降为 64 ms，首包后 80 ms 定时启动；它依赖手机下发
  PCM，不能替手机提前发起云端 TTS。06/07 渲染与 JSVM 调度修改见
  [显示性能报告](jsvm-performance.md)。

本次验证：example06 33 项、example07 43 项测试；全部 7 示例 TypeScript/打包；
123 个 Playwright 场景及连续帧像素对照；JSVM 宿主机测试；speech streaming/prelude/
wake-registration/core 和新增 TTS 测试（真实播报函数与音频环缓冲，UBSan）均通过。
新增测试覆盖首包在 HTTP read 返回前进入播放器、奇数字节分片、70 KiB 背压、复用/过期/
换密钥/服务器关连接、认证错误、截断、无音频超时和取消。

默认 ESP32-S3 `idf.py -B build build` 通过；`build/pixelbox.bin` 为 0x41d500 字节，
5 MiB 分区余量 18%，SHA-256：
`6cab35c5ecb474e35ed8c9ffed1f5e1d3cc78f82db0e66972a61ae1d4b460a92`。
产物使用当前 MN7 配置，没有更改唤醒词、模型或分区。
绘图完整宿主机套件有一条既有字体 advance 断言失败，HEAD 原版已独立复现；
本次绘图专项 38,961 条断言通过。

部署需同时更新固件与对应示例 JS，独立构建的旧 sdkconfig 需手动开启上述 TX 锁。
未调用生产 Azure/企业 API，未烧录；FPS、物理 IMU 延迟、真实首字/首音和并发资源峰值
仍需真机验收。可沿用下方诊断工具记录 `first-text`、`Azure first partial`、
`Azure TTS first audio`，结合 `tools/profile-device.mjs` 对照同设备和同网络。

## MultiNet7 动态唤醒切换（2026-09-08，未烧录）

当前默认 S3 固件和 `sdkconfig.speech` 已改用 ESP-SR 2.4.7 的 `mn7_cn` 中文模型。
下方 MultiNet5 与更早 MultiNet7 的真机记录均为历史数据，不代表本次版本的准确率或资源峰值。

- 上层继续调用 `wakeword.start({ phrase, pinyin, threshold, onWake })`，由业务设置词和门限；
  example07 保留 `src/wakeword-config.ts` 的“你好小川”和 `0.30`，固件不提供业务默认值。
- 保留模型缓存、换词重建命令表、阈值显式过滤、6 秒检测窗口、静音后前导音频回放，
  以及录音、识别等待、云端思考和 TTS 播报期间的并行唤醒。
- 模型目录及 SHA-256 校验覆盖 `mn7_index`、`mn7_data`、`_MODEL_INFO_` 和 `vocab`；
  拒绝旧 MN5 模型、缺失或误命名的词表、重复文件及损坏目录。
- 本机 `cmake --build firmware/build` 通过，使用 ESP-IDF 5.5 的 Python 3.13 环境及 S3 工具链。
  应用为 4,311,376 字节，模型包为 2,681,351 字节；现有 3 MiB 模型分区剩余 464,377 字节。
  构建产物确认选择 `CONFIG_SR_MN_CN_MULTINET7_QUANT=y`，烧录清单包含
  `0xd00000` 的 `srmodels/srmodels.bin`，模型包没有残留 `mn5q8_cn`。
- C++ 核心测试（含 UBSan 和实际新模型包）、`check-model-hashes.mjs firmware/build`、
  `check-wake-registration.mjs`、`check-prelude.mjs` 及 example07 的 35 项业务测试通过。
  注册与并行行为由桌面替身测试验证，未在桌面执行 ESP32-S3 的 MN7 推理内核。

本次应用和模型均未烧录。升级需要同时写入 `firmware/build/pixelbox.bin` 和
`firmware/build/srmodels/srmodels.bin`；原语音分区布局不变，只更新 JS 或单应用 OTA 无法完成迁移。
待真机验证：不同距离、语速与噪声下的漏唤醒和误唤醒，推理平均/峰值耗时，以及 TTS 并行时内存余量。
当前没有 AEC，模型切换不解决扬声器回灌。

## 流式 ASR 与对话延迟修正（2026-09-08）

本次修改在已有 MultiNet5、独立录音缓冲与唤醒打断改动上继续进行，已烧录 PixelBox S3
（MAC `28:84:85:90:6e:e8`），配套 example07 脚本也已更新。

- 原 `Engine::recognize` 完整录音后才开始 HTTPS 上传，只返回最终结果；手机端
  `PixelBoxVoiceSession::startRecognition` 使用 Azure `SpeechRecognizer` 持续识别。
  两者的云处理时机不同，原硬件 ASR 根本不经过 WebSocket，无法靠调整 WebSocket 缓冲消除这段等待。
- 硬件现通过已有 `esp_websocket_client` 1.8.0 向 Azure WSS 边录边发，协议对齐微软
  Speech SDK 的 `WebsocketMessageFormatter` / `AudioStreamFormat`。每包约 100 ms，
  TLS 建连期间仍采入每轮独立 PSRAM 缓冲，建连后顺序追发。中间结果只更新字幕，最终结果才提交 AI。
- 原 `MexusConversation::connect` 每轮新建并关闭连接；现复用已完成 `welcome` 的连接，
  以新 request ID 隔离轮次。取消发送协议 `cancel`，退出、离线、换 token 或进入设置时断开。
- 原 `js_ws_send` 在 JS 界面线程直接调用阻塞发送，超时参数 10000 ms；现由每连接唯一消费者
  顺序处理 send/close/destroy。队列最多 16 条且累计不超过 64 KiB；发送调用超时参数 2000 ms，
  不代表整条网络操作的严格墙钟上限。收发任务优先级为 JS 任务优先级加一。
- 原分片重组没有检查 FIN，RFC continuation 帧会被分别提交为残缺 JSON。
  新 `hal_net::WsMessage` 同时处理 ESP-IDF 缓冲分段与 RFC 消息分帧，并限制消息总大小。
- JS 回调必须先更新状态再绘制。真机单帧约 400 ms，原 4 条/2 ms 以及中间版本
  32 条/8 ms 的预算都只能在重绘之间消费极少消息，积压最高实测 7245 ms。
  现按最多 32 条/100 ms 批量处理，再执行输入源与绘制；预算在每条回调后检查。
  队列诊断改为每 5 秒输出累计最大等待，避免逐条串口日志放大处理延迟。
- Wi-Fi 静态 RX/TX 缓冲从各 16 调至各 8，RX BA window 为 6；约释放 25 KiB
  内部 RAM。TLS 仍使用 PSRAM 和硬件 AES。ASR 在最终回调前销毁自身 TLS，
  AI WSS 可跨轮保留并与下一轮 ASR/TTS 共存。
- “Azure 语音连接失败”曾在 `192.168.31.100` 上复现为
  `ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME`。现启用 lwIP 自带备用 DNS `1.1.1.1`，
  保留 DHCP 主/次 DNS；每次获取 IP 后记录实际 DNS。库 1.8.0 的 TCP 错误字段在
  `DISCONNECTED` 才有效，不能提前读取 `ERROR` 事件未初始化的 TLS 字段。
  DNS、证书、内存和 401/403 认证故障分别提示。

录音默认 15 秒，静音结束 800 ms；建连最多 15 秒，输入结束后的响应等待最多 20 秒。
为慢建连及积压发送保留有界时间，总截止是采音截止与建连截止中较晚者再加 `timeoutMs`。
旧 TLS 收尾仍受库的 I/O 边界约束，取消会立即使 JS 旧结果失效，但不承诺底层连接立即释放。

验收时观察以下不含文本、密钥及账号的日志：

- `Azure WSS connected`：建连耗时。
- `Azure first partial`：采音开始到首个中间字幕进入原生回调的耗时。
- `Azure input ended` / `Azure final`：输入结束及最终结果耗时、实际发送量。
- `[harness.ai] ready` / `first-text` / `done`：是否复用连接、问题发送到首字及完整回复的耗时。
- `px_ws: message JS queue`：每 5 秒报告该连接累计最大排队耗时和消息数量。
- `Azure TTS first audio` / `playback done`：首块 PCM 和实际播放完成。

本地验证：example07 的 34 项测试及全部 7 个示例的 TypeScript 检查与打包、原生回调隔离测试、
`check-streaming.mjs` 的 UTF-8 分片/协议/边界及后台 FIFO/销毁顺序/worker 重试测试（UBSan）、
既有录音/模型核心测试及 ESP32-S3 `build_mn5q8` 构建通过。桌面 Playwright 渲染检查覆盖
48 个页面/尺寸/主题组合，文字越界及重叠为 0，动画像素变化检查通过。
macOS 当前 AddressSanitizer 在进入测试 main 前初始化锁等待，60 秒超时；不计为 ASan 通过。
已使用设备保存的账号与 Azure 配置完成连续两轮 WSS ASR、AI 回复和 TTS 播放，
第二轮 `ready=0ms reused=true`，无 AES 内存错误、回调丢弃或执行超时。
复测时网络已切为 `MST`（设备 `192.168.1.168`），因此不能将成功归因于备用 DNS，
原网络仍需单独验收。未测功耗、长时间稳定性及复杂声学条件下的识别率；
不同问题的服务端耗时不能作为精确性能对照，旧 REST 测量也不是 WSS 提速结果。

### 连续两轮实测

记录：`firmware/build_mn5q8/latency-network-results.json`。应用固件 SHA-256：
`03585112a4926b43c0a9c68b3a9d91d9988972159b5108e2f743895920cc8296`；
example07 脚本 SHA-256：`c559a9526f50fc16de682ecb1df9eb3cba061af6af24bd19a60b432a0339b52f`。

| 指标 | 第一轮 | 第二轮 |
| --- | ---: | ---: |
| Azure WSS 建连 | 2204 ms | 1139 ms |
| 采音开始至原生首个中间结果 | 6224 ms | 2915 ms |
| 输入结束至最终结果 | 405 ms | 492 ms |
| AI 会话准备 | 1265 ms | 0 ms，复用 |
| 发送问题至首字回调 | 3961 ms | 3915 ms |
| 发送问题至完整回答回调 | 5214 ms | 5664 ms |
| TTS 首块 PCM | 13357 ms | 3526 ms |
| TTS 实际播放完成 | 是 | 是 |

两轮共用同一 boot，无回调丢弃或执行超时，结束后内部可用内存约 38 KiB。
消息排队记录最大 2708 ms，中间版本相同测试流程曾达 7245 ms；仍有绘制及日志带来的延迟，
未证明已达到 example06 的完整体验。TTS 第一轮 HTTP 响应头等待 12061 ms，
表明云端/网络耗时仍会波动，不能归入 JS 排队。

日志限频补丁已构建（固件 SHA-256 `1d6f14577389b0c39cbd820a8b39090b885005bd3b9e765b11c9b776b1e1855b`），
但 USB 下载模式无响应，尚未烧录及真机验证；上述指标来自限频前版本。

### ESPIDE 默认构建配置修正（2026-09-08）

ESPIDE 的 S3 构建运行 `idf.py -B build build/flash`，使用 `firmware/sdkconfig`。
此前只更新了独立构建的 `build_mn5q8/sdkconfig`，默认配置仍选择 MultiNet7，
因此在 `bindings_speech/CMakeLists.txt` 的模型匹配检查处失败；更新 defaults 不会覆盖已有选择。
现已将默认配置切到 MultiNet5，并同步 Wi-Fi RX/TX 各 8、RX BA window 6 和备用 DNS。
重新生成后，两份 sdkconfig 内容完全一致。

默认入口 `idf.py -B build build` 已通过，应用为 `build/pixelbox.bin`（0x41beb0 字节，
5 MiB 分区余量 18%），SHA-256 为
`3836f250e0828c2f1a0452605932c81c52e70025e6f307a722eee21a91219cc7`。
`check-model-hashes.mjs` 对默认 build 的实际模型包校验通过；模型与分区表的哈希均与
`build_mn5q8` 相同，flash 目标已包含 `srmodels.bin`。本次默认构建产物尚未烧录。
旧工作区迁移步骤见 [固件构建说明](../firmware/README.md#构建与烧录)。

```sh
node firmware/components/bindings_speech/tests/check-streaming.mjs
node firmware/components/bindings_speech/tests/check-prelude.mjs
node examples/07-obeing-harness/test.mjs
```

## 会话内唤醒补充（2026-09-07，待烧录验收）

- 在现有 MultiNet5 及默认 `0.7` 阈值改动上，补齐录音和 Azure 识别等待期间的唤醒监听。
  思考、播报、录音和等待识别均可取消旧轮；旧文字、错误、音量和播报完成不能覆盖新轮。
- `recognize()` 提交时即采入本轮独立 PSRAM 缓冲，旧 TLS 收尾时不会漏掉开口音频；
  VAD 处理和下一请求仍按 worker 顺序执行。取消停止对应录音订阅并移除过期排队任务。
- 静音后刷新模型时由一帧前导音频扩为约 200 ms（512 samples 帧下为 224 ms），
  保留轻声词首；积压丢帧后清空这段历史。推理耗时统计包含前导帧回放。
- 本轮本机验证：example07 的 31 项测试、TypeScript 检查、原生回调代数测试、C++
  核心测试及 `build_mn5q8` 固件构建通过；C++ 测试同时读取实际模型包和已有麦克风 WAV。
- 本次新增逻辑尚未烧录验证。下方历史真机数据不代表这次改动的准确率；必须补测
  不同距离和语速下的命中/漏检，以及播报中的唤醒。当前未接入 AEC，回答包含唤醒词
  时存在扬声器回灌自触发风险。

## PixelBox 唤醒更新（2026-09-07）

以下旧测试结果来自 MultiNet7，不能作为本次 MultiNet5 的性能结果。

- `example07` 的原生 `px.speech` 切换为已有 ESP-SR 2.4.7 的 `mn5q8_cn` 量化拼音模型，
  唤醒短语仍为“你好小川”。模型包实测从 2,681,351 字节减少为 2,203,819 字节。
- 模型与命令表保留到语音 worker 退出，取消 60 秒空闲释放，避免设置页停留后重新加载。
- 原来 16 KiB FIFO 满时丢弃新音频、继续处理约半秒旧数据。现在消费者发现积压超过
  160 ms 时丢弃旧前缀；溢出出现缺口时清空当时积压并重置上下文。该值是队列边界，
  不是整句识别延迟。
- 模型创建与命令表编译分别计时，每 5 秒报告平均/最大推理耗时、帧长、积压和丢弃量。
- 独立构建 `firmware/build_mn5q8` 通过；实际模型包的目录、截断、错误模型、重复文件、
  SHA-256 与源模型一致性检查通过；原生取消回调测试及 example07 的 29 项测试通过。
- 已在真机 PixelBox S3（MAC `28:84:85:90:6e:e8`，USB
  `/dev/cu.usbmodem2101`）烧录应用和模型分区；应用写入地址 `0x20000`、模型写入地址
  `0xd00000`，两个镜像均报告 `Hash of data verified`。本次应用 SHA-256 为
  `29518029a32c32098d54448642b67033fd55c40672e56b1ee63ae6b21941e6ce`，模型 SHA-256
  为 `0c72e28acaa6a36cd88cec65be32bde8809ab977c809ad52ef9cbb37aed64d76`。
- 真机冷启动日志：模型目录校验 89–90 ms、MultiNet5 创建 237–238 ms、命令表 0–1 ms，
  原生唤醒就绪 482–519 ms；缓存后原生就绪 19–138 ms。推理块为 512 samples（32 ms），
  5 秒窗口平均 13.1–15.3 ms、最大 24.6–25.2 ms，积压 10–24 ms，丢弃 0 ms，未见
  `panic`、assert 或异常重启。
- 电脑扬声器播放“你好小川”并由设备麦克风采集时，默认阈值 0.8 命中一次：概率 0.805、
  单帧推理 25.874 ms、积压 24 ms；负样本“今天天气很好，我们一起去公园散步。”未命中。
  这是一组功能性样本，不代表各种距离和噪声条件下的准确率。
- 唤醒停止后空闲 65 秒，PSRAM 空闲值保持不变（约 4.49 MB），再次启动仍走缓存路径，
  设备 boot 标识不变。电脑和设备当时处于不同网段（`172.20.10.7` 与 `192.168.1.168`），
  因此本轮 devd 网络探针不可用；串口启动、推理和扬声器/麦克风测试均已完成。

更新需要同时写入配套的应用镜像和 `srmodels.bin`，分区布局不变。构建与迁移方式见
[独立语音组件说明](../firmware/components/bindings_speech/README.md)。
`cache-check` 已改为检查空闲 60 秒后模型仍被保留。

MultiNet5 的检测器超时窗口设为 6 秒，并在连续 500 ms 低能量输入时主动清理状态；
这样长时间待机不会在唤醒短语跨越供应库默认窗口时被截断，短停顿仍保留上下文。

## 历史 MultiNet7 测量

Device: Waveshare ESP32-S3 AMOLED 2.16, 480x480, USB COM3,
`pixelbox-906ee8` at `192.168.31.100`; ESP-IDF 5.5, 8 MiB PSRAM.
The existing example7 application and configured Azure eastasia resource were
used. Subscription keys and account credentials are not included in logs.

## Confirmed Causes

- The original local VAD rejected desk-distance audio before Azure was called.
  A real device recording (128000 samples, RMS 187, peak 2156) was rejected by
  `px.speech.recognize`, but the same PCM sent to Azure returned `Success` and
  the complete expected sentence. The old onset floor was 0.012 RMS, with a
  noise estimator that could absorb quiet speech into its threshold.
- Every wake start rehashed the mapped model, created MultiNet7 and rebuilt
  the command table. Two consecutive device starts took 8454 and 8387 ms.
  Model initialization ran below the busy JS renderer's task priority.
- Wi-Fi used the default modem sleep mode, adding DTIM waits. TCP had only a
  5760-byte send buffer/window. Native speech uploaded WAV in 2048-byte writes
  and included silence preceding the utterance.
- Azure's caller-provided timeout was silently capped at 5000 ms per socket
  operation. Errors erased HTTP status and TLS details. Speech networking also
  ran below the JS renderer's priority on its core.

## Changes

- VAD onset is 0.004 RMS with adaptive noise and 0.0025 sustain hysteresis;
  180 ms of speech is still required. An impulse/noise regression and the
  real quiet recording both pass. Up to 200 ms pre-roll is preserved when
  trimming leading silence before upload.
- MultiNet weights and command table are reused between turns, cleaned before
  reuse, and released when the speech worker exits. Archive hashes are verified
  once per boot against the firmware's expected model hashes. The MultiNet5
  timeout window is 6 seconds, with a 500 ms quiet-input reset.
  Initialization and speech TLS run above JS rendering priority.
- Wi-Fi modem sleep is disabled by default (`PX_WIFI_POWER_SAVE` restores it).
  This increases idle power consumption. S3 speech TCP send/receive windows
  are 16384 bytes, receive mailbox 14, and uploads use 4096-byte writes.
- Request queues are bounded at 16 pending requests and skip obsolete VM work.
  WebSocket close/destroy jobs survive VM changes and request backpressure.
- Logs report queue wait, HTTP connection/upload/header/total times and Azure
  TLS/HTTP/recognition status without printing keys or response text. TLS
  connect allows up to 15 seconds; recognition headers use the remaining
  request budget.

## Validation

The fixed Chinese test sentence was synthesized on the computer, played over
its speaker, captured by the PixelBox microphone and recognized by Azure:
`今天天气很好，我们一起去公园散步。`

- Host Azure TTS: HTTP 200, 1337 ms, 116044-byte WAV.
- Host Azure STT of that WAV: HTTP 200, Success, 1544 ms.
- Host Azure STT of the device microphone recording: Success, 2118 ms.
- Fixed VAD on the actual recorded PCM detected speech and endpoint at 6080 ms.
- First device validation after VAD fix: native recognize returned the full
  sentence, including 6200 ms capture, 689 ms connection, 8110 ms upload and
  601 ms response headers. This prompted the subsequent upload changes.
- Wake start after cache/priority changes: 1731 ms cold and 129 ms cached,
  compared with 8454/8387 ms before. Native preparation logs were 1566/89 ms;
  Promise latency additionally includes JS scheduling.
- Native TTS successfully completed playback (6657 ms, including audio time).
- Final TCP/upload build: microphone recognize succeeded again in 11331 ms,
  including the configured 8000 ms capture. Upload after trimming was 183404
  bytes in 2313 ms, connection 661 ms, response headers 217 ms. The reduced
  upload time reflects both transport changes and fewer silence bytes.
- Fixed 116044-byte WAV device round trip: original 7230 ms; final warm
  request 4092 ms. The first request after flashing still took 6962 ms, with
  connection variability. Final warm HTTP log: connect 784 ms, upload 1522 ms,
  headers 1502 ms; LAN fixture download adds about 161 ms. This is not a
  guarantee that all network requests are uniformly faster.
- After restarting example7, repeated wake starts were 1502 and 177 ms.
- During subsequent interactive use, the existing app logged five successful
  login-chain HTTP requests taking 746, 632, 732, 667 and 579 ms. Later speech
  uploads of 56-73 KB took 716-999 ms, with Azure HTTP 200 responses in
  205-213 ms and cached wake preparation about 159-199 ms. No credentials or
  private transcript content were needed to inspect these timing logs.
- The 60-second idle-release probe was inconclusive because the user resumed
  speech while it ran. Active wake detection correctly retains the model.
  Model release on worker shutdown was observed in the device logs. The
  final application was left running without another disruptive restart.

## Reproduction

Build SDK first: `pnpm --filter @pixelbox/sdk run build`.
Run one device probe at a time; probes use shared diagnostic state and cancel
existing speech operations. They load the existing project speech config.

```sh
node tools/diagnose-speech.mjs status
node tools/diagnose-speech.mjs azure-host
node tools/diagnose-speech.mjs azure-device
node tools/diagnose-speech.mjs wake
node tools/diagnose-speech.mjs recognize
node tools/diagnose-speech.mjs tts
```

`azure-host` creates a fixed test WAV in `firmware/build/azure-test-speech.wav`.
`azure-device` serves only that WAV briefly over the LAN, then uploads it from
the device to Azure. `recognize` captures up to 8 seconds of live microphone
audio. `mic` additionally saves a diagnostic microphone WAV and sends it to
Azure from the host to separate capture/VAD failures from transport failures.
Do not run probes while an application is conducting a conversation.
`cache-check` tests model retention after 60 seconds idle, and reports inconclusive if
application speech resumes during that window. `logs` and `status` are passive.

Host regression:

```sh
c++ -std=c++17 -O2 -Ifirmware/components/bindings_speech/src firmware/components/bindings_speech/tests/speech_core_test.cpp -o firmware/build/speech-core-test
firmware/build/speech-core-test firmware/build/srmodels/srmodels.bin firmware/build/device-microphone.wav
node firmware/components/bindings_speech/tests/check-prelude.mjs
node examples/07-obeing-harness/test.mjs
```

A successful fixed phrase is evidence of working capture/VAD/Azure transport,
not a claim about recognition accuracy in all noise conditions. MultiNet7 is
a command model with the custom phrase, not a dedicated trained wake-word
model. Full enterprise login and extended conversational traffic require their
own end-to-end measurements; HTTPS timing here is an Azure endpoint test.
