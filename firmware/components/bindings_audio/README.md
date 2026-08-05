# bindings_audio — px.audio JS 绑定

模块名 `"audio"`,优先级 10,经 `JSVM_REGISTER_MODULE` 自注册,方法签名与
`sdk/types/pixelbox.d.ts` 逐一对齐。

## 实现要点

- **mic.start**:采集回调(采集任务)→ 软件重采样到请求率 → 按 `frameMs` 切帧
  (PSRAM 帧缓冲)→ 有界队列(Kconfig `PX_AUDIO_MIC_QUEUE_FRAMES`,默认 8)→
  `jsvm::post` 批量派发 ArrayBuffer 到 JS。**背压**:JS 未消费完时丢最旧帧并
  `ESP_LOGW`(1s 节流)。
- **player.play**:`/app`、`/data` 路径经 appmgr 解析(弱符号
  `appmgr_resolve_path`,未链接时用内置映射 `/app→/flash/apps/current`、
  `/data→/flash/data`);http(s) URL 走 `esp_http_client` 流式喂解码器。
  返回 Promise,解码头解析成功(拿到采样率)后 resolve 出 PxPlayHandle。
- **openPcmStream**:PSRAM 环形缓冲(默认 512KB,`PX_AUDIO_STREAM_RING_KB`),
  `feed/end/stop/buffered/onEnded` 全对齐;缓冲满时丢弃并告警,JS 侧可用
  `buffered()` 节流。TTS 流式播放走同一条路径。
- **record**:mic 订阅 → PSRAM 整段缓冲(maxMs 上限 60s)→ 独立写盘任务生成
  WAV → resolve 实际时长毫秒,避免 LittleFS 写入阻塞采集或 JS 线程。
- **ENOTSUP**:`hal_audio::ready()` 为 false 时所有方法抛 `Error("ENOTSUP")`。
- **VM 热重启防护**:px.audio 上挂隐藏 guard 对象,VM 销毁时其 finalizer 释放
  native 持有的全部 JSValue、停掉 mic 订阅、中止未决 play/record。

## 线程模型

事件源(采集任务 / 播放任务 / 解码任务)一律经 `jsvm::post` 投递,JS 线程外
不触碰任何 `JS_*` API(finalizer 除外,GC 本身在 JS 线程)。
