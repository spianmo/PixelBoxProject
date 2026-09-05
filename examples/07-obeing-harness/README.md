# ObeingHarness

PixelBox 上独立联网的语音助手。助手形象是三维粒子小猫“小川”，唤醒词固定为 **你好小川**。
企业账号登录、AI 会话、语音识别和语音播放均由 PixelBox 自身通过 HTTPS / WSS 完成，不需要手机中继。

## 运行条件

- ESP32-S3 PixelBox，16 MiB flash、8 MiB PSRAM、16 kHz 麦克风和扬声器。
- 已联网并完成 NTP 时间同步，TLS 使用设备 CA 证书包校验服务端。
- 启用 `px.speech` 和 ESP-SR MultiNet7 的独立语音固件；默认固件没有离线唤醒能力。
- 可用的 V4 企业 ID、账号与密码，以及允许随示例固件分发的 Azure Speech 区域和订阅密钥。

固件构建、模型、分区及边界见
[独立语音组件说明](../../firmware/components/bindings_speech/README.md)。
独立语音固件使用与默认固件不同的分区布局，部署前必须按该说明处理完整分区迁移。
本示例实现及验证没有执行任何烧录或生产登录。

## 使用

1. 打开应用，在设备触屏填写六位企业 ID、六位账号和密码。内置键盘支持大小写、数字和常用符号。
2. 点击登录。工程已配置 Azure 区域及订阅密钥时直接进入助手；本地构建缺任一项时，才进入
   设备语音页并要求在 PixelBox 上填写。
3. 保存后出现小川。说“你好小川”，稍等唤醒后说问题，也可直接点击小川或按 BOOT 开始。
4. 设置中可以配置语音、企业服务器、文字提问或退出登录。顶部有静音和浅暗主题开关。
5. 对话时点击小川会取消当前轮并开始新轮；BOOT 双击切换静音，长按打开设置。

进入登录、设置或键盘页面会暂停语音；网络恢复和切换静音也不会在这些页面自动开麦。
返回助手页面恢复唤醒，BOOT 单击则直接返回助手并开始本轮录音。

企业服务默认是 `https://v4.teamhelper.cn`，设置页允许修改 HTTPS 域名、OEM 和企业域。
修改企业服务会退出当前账号，防止向另一服务发送旧凭据。

Azure 配置统一定义在 `src/project-config.ts`。`region` 与 `key` 同时有效时随 `main.js` 编译并在
应用启动时自动配置；任一项为空则进入本地开发回退，用户在 PixelBox 上填写，密钥只保留在
本次运行内存。工程内置密钥可从 `main.js` 或设备应用包提取，因此只能使用允许随示例分发、可
独立轮换和限额的 Azure 资源，不能填写生产后端共享密钥。

企业密码、access token、refresh token 以及用户在设备上临时填写的语音密钥均不写入存储或
日志。企业 ID、账号、临时语音区域、服务地址、OEM、企业域和主题属于可恢复设置。退出企业
账号立即关闭唤醒、录音、AI WebSocket 与播放，并清除身份和单轮对话；本次应用运行内的 Azure
设备配置保留，退出应用后清除。

## 真实链路

`auth.ts` 对齐 Android `V4AuthRepository`：

```text
HTTPS /basestation/api/workbench/user/ucenter/login
  -> /api/meeting/oauth/appid
  -> /api/meeting/authorize
  -> /api/meeting/token
  -> /api/meeting/user/info
```

请求携带 `User-Client`、设备元数据、`oem`、`Authorization` 和 `X-Tenant-Id`。
禁止自动重定向，避免企业口令或 token 跨源。使用 `lossless-json` 保留 64 位企业和用户 ID，
发往 AI 的 ID 为字符串。access token 到期前 60 秒合并刷新请求，退出或切换账号使所有旧响应失效。
服务以 HTML 或空正文返回 HTTP 401/403 时仍按鉴权失效处理，清除过期账号。

`conversation.ts` 直接连接 `wss://<企业服务>/mexusclaw-socket`，使用现有 MexusClaw v1
`hello`、`welcome.payload.sessionId`、`user.turn`、`assistant.delta`、`assistant.done`
及 `cancel` 协议。`platform: "phone"` 沿用现有 Android 客户端枚举，实际 `deviceMeta.model`
明确为 `PixelBox`，`osVersion` 为 `ESP-IDF`，该枚举不表示需要手机。设备不声明未实现的工具能力。

每轮使用独立 request ID，按 seq 去重。底部问题是实际 ASR 最终文本，回答是服务端流式内容；
“思考”区显示服务公开的工具状态标签，不生成或暴露隐藏推理。

唤醒使用离线 MultiNet7 中文命令 `ni hao xiao chuan`，不是专门训练的 WakeNet 模型。
唤醒后先释放模型与麦克风，再进行本地 VAD 录音，向 Azure 短音频识别接口上传 WAV。
**短音频识别仅返回最终文字，不提供中间转写**；实时变化的是本地音量。
录音默认最多 15 秒、静音 800 毫秒结束、识别超时 20 秒。

回答通过原生 Azure TTS 流式 PCM 播放，长文本按完整 Unicode 字符切分，
每段最多 240 个字符且不超过 5400 UTF-8 字节，达到 120 个字符后优先在句末提前分段。
各段顺序播放，240 汉字约一分钟，为模拟器 90 秒和原生 120 秒的单段时限保留余量；
实际时长仍取决于语音内容。只有扬声器实际播完才重新启动离线唤醒。
AI 握手最多 15 秒，单轮 AI 最多 60 秒。取消立即使旧异步结果失效。

## 桌面模拟器

模拟器提供真实设备画面、IMU 扰动和麦克风 / Azure 语音接口。
桌面没有 ESP-SR 硬件推理，`wakeword.start()` 会返回明确不支持，页面显示“本地唤醒不可用”，
仍可点击小川开始真实录音；没有伪造语音或 AI 回复。模拟器也需用户自己的企业账号及 Azure 配置。

## 构建和验证

在 `examples/` 执行：

```sh
node node_modules/typescript/bin/tsc -p 07-obeing-harness/tsconfig.json
node 07-obeing-harness/test.mjs
node scripts/build-all.mjs
OBEING_PLAYWRIGHT=/path/to/playwright node 07-obeing-harness/render-check.mjs
```

测试只使用明确的内存服务 fixture，覆盖真实 V4 请求顺序、64 位身份、刷新、登录取消、
WSS 增量与取消、离线唤醒到实际播放完成的生命周期、长中文 TTS 分段、NTP 前的登录边界、
键盘以及 320 / 368 像素宽屏的浅暗色布局。
Playwright 使用真实像素字体检查 24 个页面与主题尺寸组合，确认文字和图形不越界、主体非空、
IMU 改变渲染像素；截图位于 `dist/screenshots/`，生成文件不提交。

未验证：生产企业登录、真实 Azure 账号、物理设备语音质量、模型运行内存及实际唤醒准确率。
可编译与模拟测试通过不等于这些硬件和服务路径已验收。
