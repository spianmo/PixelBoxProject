# voicechat — px.voice 语音对话客户端

实现 `docs/architecture.md` §7 的设备端完整客户端:模块名 `"voice"`,
API 与 `sdk/types/pixelbox.d.ts` 的 `PxVoice` 逐一对齐。

## 状态机

```
idle ──start()──▶ connecting ──WS connected──▶ listening ──VAD speech.end──▶ thinking
  ▲                                               ▲                            │
  │                                               │ barge-in / 持续模式          │ tts.begin
  └───────── tts 播完(单轮) ◀──────────────────── speaking ◀────────────────────┘
```

- **VAD**:能量法,20ms 帧 RMS + 自适应噪声底(静音期快速跟随、语音期缓慢上浮);
  连续 3 帧语音 → `speechStart`;此后静音 `vadSilenceMs`(默认 800,可配)→
  发送 `speech.end` → `thinking`。单轮模式 15s 无语音自动回 idle。
- **上行**:采集任务重采样到 16kHz → PSRAM 环形缓冲 → 独立发送任务 60ms/块
  `send_bin`;`speech.end` 由发送任务在环排空后补发,保证音频先到齐。
- **TTS 下行**:二进制帧直接喂 `hal_audio::PcmRingSource`(与
  `px.audio.player.openPcmStream` 同款环形缓冲,默认 1MB PSRAM),采样率以
  `tts.begin` 为准;`tts.end` 后播完触发排空回调,持续模式自动回 listening。
- **barge-in**:speaking 期间 mic 持续采集;无 AEC,因此用高倍率阈值
  (噪声底×6 且 RMS>500)+ 连续 240ms 判定;触发后上行 `interrupt` → 停播 →
  回 listening,并把 500ms 预滚缓冲补发,不丢用户开头的话。
- **事件**:8+1 类全部经 `jsvm::post` 投递 JS 线程;`level` 100ms 节流。
- **唤醒词**:`Kconfig PX_ENABLE_WAKEWORD`(默认关)条件编译 esp-sr wakenet;
  esp-sr 为常驻依赖但默认构建零体积(链接器整库裁剪,见 idf_component.yml)。
  启用走 `sdkconfig.wakeword` 叠加构建(切换含 model 分区的分区表 + wn9 模型,
  见 firmware/README.md「启用唤醒词」)。`configure({wakeword:true})` 后 idle
  态待机侦听(独立 8KB 检测任务跑 wakenet,与音频任务异核),命中 → `wake`
  事件 + 自动开始一轮单轮对话;会话期间不喂 wakenet(与 barge-in 互斥,防
  TTS 音频二次触发);`stop()` 同时停止侦听并释放 PSRAM 工作区;初始化失败
  (缺 model 分区 / PSRAM 不足)投递 `error` 事件并降级为手动模式。

## 协议注记

`say()`(仅 TTS,不走 LLM)发送 `{type:'tts.request', text}` —— 这是对 §7
协议的最小扩展,与 server / 模拟器实现保持一致;服务器未实现时 60s 超时
reject。

## 线程模型

JS 线程(API)/ WS 任务(下行)/ 采集任务(VAD + 上行入环)/ 上行发送任务 /
播放任务(TTS 排空回调)。引擎状态单互斥锁保护;JS 事件只经 `jsvm::post`。
VM 热重启由 px.voice 隐藏 guard 对象 finalizer 收尾(释放回调 + 引擎回 idle)。
