# Obeing Pixel Bridge v1

手机是 WebSocket 服务端，PixelBox 是客户端。发现类型 `_obeing-pixel._tcp`，NSD 可带末尾点，连接路径 `/pixelbox`，服务端使用动态空闲端口。设备发现时 `timeoutMs=3000`，每 5 秒重试，连接握手最多 15 秒；配对码有效期 120 秒，提交后手机确认窗口 60 秒，设备等待保护上限 120 秒。设备每 10 秒发送 `ping`，45 秒无任何下行消息则断开并停止麦克风。

## 配对

```json
{"type":"hello","protocol":1,"deviceId":"pixelbox-device-id","name":"Obeing PixelBox","wakeWord":"你好小川","pairCode":"123456"}
```

手机校验一次性六位码，再发 `{"type":"hello.pending"}` 并等待用户点击确认。安全配对与企业账号独立，确认后手机下发当前账号快照：

```json
{"type":"hello.ok","sessionId":"limited-device-session","authenticated":true,"accountEpoch":1,"userDisplayName":"小川","enterpriseId":"enterprise-id","account":"account","wakeWord":"你好小川","sampleRate":16000}
```

手机尚未登录时，`hello.ok` 携带 `authenticated:false`，设备保持已确认的连接，显示“请在手机登录”并等待推送；此时不得采音或处理对话音频。

```json
{"type":"account.state","authenticated":true,"accountEpoch":2,"userDisplayName":"小川","enterpriseId":"enterprise-id","account":"account"}
```

手机登录、退出、登录过期或切换账号时发送 `account.state`；设备先停止旧音频并清空单轮字幕，再应用只读身份快照。`authenticated:false` 只暂停账号能力，不撤销安全配对。账号推送仅在设备已收到 `hello.ok` 且配对仍有效时接受，不能替代配对认证。

所有账号快照（含未登录）都携带非负安全整数 `accountEpoch`，每次账号变动递增。设备忽略同连接上旧的或重复的代数，拒绝缺失或非法代数；新有效账号快照应用后，先发送 `{"type":"account.ready","accountEpoch":2}`，再发送 `mic.start` 并开始采音。静音时仍确认账号，但不采音；未登录快照不发送确认。手机只有收到与当前账号代数匹配的 `account.ready` 后才接受语音/文本命令和 PCM，旧确认不起作用。这样切账号前排队的旧输入会先于新确认被拒绝；设备也通过采音代数丢弃旧麦克风的迟到回调，防止新确认之后混入旧 PCM。

设备仅继承手机企业账号权限，协议不发送密码和企业 access token，不保存 resume token；断线重配。`auth.required` 只清除账号与单轮字幕；`auth.revoked` 撤销设备配对并停止采音，之后账号推送不再生效。设备不提供账号登录、退出操作；“断开手机连接”只关闭本地 WebSocket，不发送 `logout`。

## 上行

| type / 帧 | 语义 |
| --- | --- |
| `account.ready` | `accountEpoch` 确认已停止旧音频并应用新账号；必须先于新账号 `mic.start`/文本/PCM |
| `mic.start` | 开始持续采音，`sampleRate=16000,channels=1,format=pcm_s16le,wakeWord=你好小川` |
| 二进制 | PCM16LE，16 kHz，单声道，32 ms / 1024 字节帧 |
| `mic.stop` | 用户关闭麦克风，手机取消当前语音流程 |
| `listen` | 触摸 / 按键直接开始一轮输入，不等待唤醒词 |
| `cancel` | 打断当前 STT / AI / TTS |
| `text` | `text` 字段直接发起文本轮次 |
| `audio.played` | `turnId` 必须匹配当前播放轮次；扬声器实际消费完全部下行 PCM，手机才恢复唤醒监听 |
| `ping` | 心跳，手机回复 `pong` |

播报期间设备本地停麦，不发送 `mic.stop`，因此不会取消当前回答；播放完成后恢复 `mic.start`。

## 下行

| type / 帧 | 字段与语义 |
| --- | --- |
| `account.state` | 手机账号快照，`authenticated,accountEpoch,userDisplayName,enterpriseId,account`；清旧音频/字幕，保留安全配对，未配对或旧代数时忽略 |
| `state` | `state`: idle / listening / thinking / speaking / muted / error，`text` 为公开状态 |
| `wake` | `word` 必须严格等于 `你好小川` |
| `user.text` | `text` 为当前轮识别文本，`final` 标记是否完成 |
| `assistant.delta` | `text` 为累计全文，设备按替换语义处理 |
| `assistant.text` | `text` 为完整回复 |
| `thinking.status` | `text,phase`，公开工具执行状态或摘要，不传隐藏推理 |
| `audio.start` | `turnId` 为当前轮次整数，`format=pcm_s16le,channels=1,sampleRate=16000` |
| 二进制 | 由最近的 `audio.start` 指定格式；单帧最多 65536 字节 |
| `audio.end` | `turnId` 匹配当前轮次时标记网络音频已结束，不等于扬声器已播完 |
| `audio.cancel` | `turnId` 匹配时立即丢弃播放流并停止采音，等待手机 `state=idle` 再恢复麦克风 |
| `error` | `code,message`；设备显示有限长度错误并提供重新配对 |
| `auth.required` | 手机账号未登录，清账号和字幕，停止设备采音，等待手机状态 |
| `auth.revoked` | 手机撤销设备配对，清账号和字幕，停止设备采音，拒绝后续账号推送 |
| `pong` | 保活 |

手机按累计 PCM 时长和单调时钟安排下行发送，保留最多约 512 ms 音频余量，避免每包固定休眠累积发送与调度延迟。设备收集约 64 ms PCM 后连续送入播放器；首块后 80 ms 的 JS 定时任务到期时即使不足该长度也启动，短回答在 `audio.end` 时立即送入，仍等待实际播完后才回执。定时任务受 JS 调度影响，不是物理首声延迟上限。取消、静音、断线或切账号均丢弃尚未播放的预缓冲并清除启动任务。

消息最大 16 KiB；单轮字幕保留至多 2400 字，公开思考状态保留 300 字。下行 PCM 缓冲（含预缓冲）超过 6 秒立即取消本轮，避免占满 ESP32 内存。每个连接只承载单个串行轮次。

传输边界：当前为可信局域网明文 WebSocket，配对授权不等于 TLS 加密。企业密码仅在手机 HTTPS 登录链路提交，设备服务不得接收或暴露原始企业 token。
