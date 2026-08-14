# hal_audio — PixelBox 音频硬件抽象层

ES8311 codec(`espressif/esp_codec_dev`)+ I2S std 双工,默认 16kHz / 单声道 / 16bit。

## 架构

```
                 ┌──────────────┐   fan-out    ┌─ bindings_audio (JS mic)
 ES8311 ADC ───▶ │ 采集任务 10ms │ ───────────▶ ├─ voicechat (VAD/上行)
                 └──────────────┘              └─ record (WAV 写盘)

 PcmBufferSource ─┐
 PcmRingSource  ──┤  ┌──────────────────────┐
 ToneSource     ──┼─▶│ 播放任务: 重采样+混音 │ ───▶ ES8311 DAC
 DecodeStream   ──┘  └──────────────────────┘
```

- **双工共时钟**:ES8311 单 I2S 总线,mic 与 speaker 必须同采样率。设备率固定
  (默认 16kHz,可经 `set_device_rate` 在空闲时改),其余采样率全部软件线性重采样:
  - mic 消费方:设备率 → 请求率(订阅方自带 `LinearResampler`)
  - 播放源:源采样率 → 设备率(混音器内置 per-source 重采样)
- **大缓冲全部 PSRAM**:`big_alloc()` 优先 `MALLOC_CAP_SPIRAM`。
- **引脚零硬编码**:`Config` 由板级(boards/main)填好后调用 `hal_audio::init()`。
  IDF v5.5 下 I2C 控制走 `i2c_master` 总线句柄(`Config::i2c_bus_handle`)。

## 播放源

| 类 | 用途 |
|---|---|
| `PcmBufferSource` | `player.playPcm`:整块 PCM 拷入 PSRAM |
| `PcmRingSource` | `player.openPcmStream` / TTS 下行 / 解码器输出,支持 `feed/feed_blocking/end/stop/buffered_ms` |
| `ToneSource` | `player.tone` 正弦合成(5ms 淡入淡出) |
| `DecodeStream` | `player.play`:文件或 http(s) 流 → 跳过 ID3v2 标签 → WAV 解析 / MP3 解码(`espressif/esp_audio_codec`)→ 内部 `PcmRingSource`;暂停期间不累计背压超时，`resume()` 后继续解码 |

多源同时播放时逐样本饱和混音;`Source::on_finished` 在播放任务上下文触发,
绑定层负责经 `jsvm::post` 投递到 JS 线程。

## 线程约定

- mic 订阅回调运行在采集任务(核 0),**禁止阻塞、禁止直接调 JS_\***。
- `PcmRingSource::feed` 非阻塞可从任意任务调用;`feed_blocking` 仅供解码等后台任务。

## Kconfig

见 `Kconfig`:任务核心/优先级、解码环形缓冲(默认 128KB)、流式缓冲(默认 512KB)、
JS 麦克风帧队列深度(默认 8 帧)。
