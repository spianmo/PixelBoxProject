# ObeingHarness

PixelBox 上独立联网的语音助手。助手形象是三维粒子小猫“小川”，应用预设唤醒词为 **你好小川**。

唤醒配置集中在 `src/wakeword-config.ts` 的 `WAKEWORD_CONFIG`：`phrase` 为显示词，
`pinyin` 为小写无声调拼音（音节间单个空格），`threshold` 当前为 `0.30`。
每次启动监听都会由业务将三个参数传给 `px.speech.wakeword.start()`；待机文案同步使用该配置。
首次需安装支持动态注册的固件，此后修改配置并重新下发应用 JS 即可换词、调阈值。
其他业务也可直接调用该接口注册自己的词，运行时再次调用会替换旧监听。
企业账号登录、AI 会话、语音识别和语音播放均由 PixelBox 自身通过 HTTPS / WSS 完成，不需要手机中继。

## 运行条件

- ESP32-S3 PixelBox，16 MiB flash、8 MiB PSRAM、16 kHz 麦克风和扬声器。
- 已联网并完成 NTP 时间同步，TLS 使用设备 CA 证书包校验服务端。
- S3 默认语音固件，包含 `px.speech` 和 ESP-SR MultiNet7 中文拼音唤醒模型。
- 可用的 V4 企业 ID、账号与密码，以及允许随示例固件分发的 Azure Speech 区域和订阅密钥。

固件构建、模型、分区及边界见
[独立语音组件说明](../../firmware/components/bindings_speech/README.md)。
从旧非语音固件升级时，部署前必须按该说明处理完整分区迁移。
真机诊断与耗时记录见 [语音与网络报告](../../docs/speech-network-performance.md)。

## 使用

1. 打开应用，在设备触屏填写六位企业 ID、六位账号和密码。内置键盘支持大小写、数字和常用符号。
2. 点击登录。工程已配置 Azure 区域及订阅密钥时直接进入助手；本地构建缺任一项时，才进入
   设备语音页并要求在 PixelBox 上填写。
3. 保存后出现小川。说“你好小川”，稍等唤醒后说问题，也可直接点击小川或按 BOOT 开始。
4. 设置中可以配置语音、企业服务器、文字提问或退出登录。顶部有静音和浅暗主题开关。
5. 录音、识别等待、思考和播报期间，说“你好小川”或点击小川可取消当前轮并开始新轮；BOOT 双击切换静音，长按打开设置。
6. 右上角切换全屏，保留放大的小川、音量波形和底部字幕。再次点击右上角退出；长按 BOOT 打开设置。

待机每 4.5 至 8.5 秒随机选择正面、探头、伸展、蜷缩或侧坐，避免连续重复。
聆听、思考、回答、休息和异常有独立轮廓及表情，形态在 420 毫秒内平滑过渡，
新的语音状态可以打断过渡。主页不显示账号名，在线指示紧邻 ObeingHarness。

进入登录、设置或键盘页面会暂停语音；网络恢复和切换静音也不会在这些页面自动开麦。
返回助手页面恢复唤醒，BOOT 单击则直接返回助手并开始本轮录音。

企业服务默认是 `https://v4.teamhelper.cn`，设置页允许修改 HTTPS 域名、OEM 和企业域。
修改企业服务会退出当前账号，防止向另一服务发送旧凭据。

Azure 配置统一定义在 `src/project-config.ts`。`region` 与 `key` 同时有效时随 `main.js` 编译并在
应用启动时自动配置；任一项为空则进入本地开发回退，用户在 PixelBox 上填写，密钥只保留在
本次运行内存。工程内置密钥可从 `main.js` 或设备应用包提取，因此只能使用允许随示例分发、可
独立轮换和限额的 Azure 资源，不能填写生产后端共享密钥。

企业密码与完整会话写入设备本地 KV，按服务地址、OEM、企业域、设备和账号匹配恢复。
重启或热更新后等待联网及时间同步，复用有效 token、刷新过期 token，必要时用已保存密码重新登录。
主动退出会清除会话并停止全部音频及 AI 连接，但保留密码，后续须点击登录。
旧版未存储的会话和密码无法迁移，更新后首次登录才开始持久化。
KV 当前未单独加密，能读取设备存储的工具也能读取凭据；日志不输出密码或 token。
设备上临时填写的 Azure 密钥仍仅保留在本次运行内存。

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

每轮使用独立 request ID，按 seq 去重。紧凑字幕显示一行问题和最多两行最新回答，
内容来自实际 ASR 和服务端流式响应。服务返回的中间过程在普通模式显示于状态区，
全屏模式保留在底部单行文字中，中间波形表示活动。没有删除服务端公开的过程更新。

唤醒使用离线 MultiNet7 (`mn7_cn`)；业务通过 `wakeword.start({ phrase, pinyin, threshold, onWake })`
动态注册，示例在 `src/wakeword-config.ts` 预设拼音 `ni hao xiao chuan`，不是专门训练的 WakeNet 模型。
唤醒后边录音边通过 Azure WSS 发送 PCM，约 40 毫秒一包；本地 VAD 判断输入结束。
`speech.hypothesis` 通过 `onPartial` 更新累计字幕，`speech.phrase` 确认最终文字，`turn.end` 结束本轮。
录音、识别等待、云端思考和回答播报期间保持离线唤醒，喊“你好小川”会取消旧轮并开始新一轮录音。
新录音在调用 `recognize()` 时就开始缓冲，避免等待旧 TLS 请求收尾时漏掉开头；VAD 处理及新云端请求仍按 worker 顺序执行。
示例命中阈值为 `0.30`，由业务配置，固件没有默认阈值；静音后刷新模型时保留约 200 毫秒完整帧前导音频，减少轻声词首被截断。
MultiNet 模型跨轮复用，语音线程退出时释放，设置页停留超过 60 秒后也无需重新加载。
从 MultiNet5 升级必须同时更新应用镜像和模型分区；只更新本示例的 JS 不生效。
本次 MN7 的中文唤醒效果、误唤醒率和并行播报时的资源峰值尚未在真机验证。
录音默认最多 15 秒、静音 800 毫秒结束、输入结束后等待识别最多 20 秒；建连最多 15 秒，
总截止为采音截止与建连截止中较晚者再加 20 秒。只有最终文字提交给 AI，临时字幕不触发请求。

回答随 `assistant.delta` 增量交给 `speech-stream.ts`，不再等 `assistant.done` 才开始 TTS。
首段遇句末、8 字以上逗号分句或 40 字上限即提交；无标点时从待播文字首次出现起
最多等待 300 毫秒（还受 JS 调度影响）。后续段边播放边累积，最多 240 个 Unicode 字符，
120 字后优先按句末切分。AI 完成时补齐尾句，各段串行播放，实际播完才回待机。
最终文本可替换尚未提交的尾部；若服务端重写已经提交的前缀，则停止追加语音，字幕仍以
最终文本为准，避免把同一答案重复朗读。取消、静音、换页和退出均清除未播放队列。
原生 TTS 收到 HTTP 数据即喂 PCM，后续段复用 HTTPS；空闲 15 秒或进入 ASR 时释放连接。
网络失败、音频截断或配置变化不会保留旧连接。这里的 300 毫秒是分句等待上限，
不是 Azure 首音时延承诺；云端合成和 TLS 仍需实际测量。
当前未接入 AEC，播报内容包含唤醒词时存在回灌自触发风险，需要真机验证。
AI 待机及录音时预先完成 TLS 和 hello 握手，只有最终转写才发送 `user.turn`。
预连接失败由正式请求重试，普通取消立即结束等待中的旧轮且保留预连接供新轮使用。
AI 握手最多 15 秒，单轮 AI 最多 60 秒。连续问答和普通取消保留已握手的连接与 session，
每轮仍使用独立 request ID；每 15 秒维持心跳，45 秒无消息关闭。换凭据、退出、离线或进入设置时释放连接。
取消立即使旧异步结果失效。原生 WebSocket 的发送、关闭和销毁在同一连接的后台队列中有序执行，
发送队列上限 16 条 / 64 KiB，队满同步报错；后台发送失败通过 `onerror` / `onclose` 回传。

06/07 共用渲染器保留静态背景和字幕，小猫只恢复旧包围盒与相交网格，再画新姿态。
IMU 以 50 Hz 采样直接驱动位移与偏转，目标刷新率为 30 FPS；目标值不等于真机实测帧率。
固件同时缩短帧到期时的网络事件批次预算，并优化 PSRAM 填色、旋转采集和脏区行带传输。
当前验证及真机验收边界见 [显示性能报告](../../docs/jsvm-performance.md)。

## 桌面模拟器

模拟器提供真实设备画面、IMU 扰动和麦克风 / Azure 语音接口。
桌面没有 ESP-SR 硬件推理，`wakeword.start()` 会返回明确不支持，页面显示“本地唤醒不可用”，
仍可点击小川开始真实录音；没有伪造语音或 AI 回复。模拟器仍使用 REST 短音频识别，
仅返回最终转写，不能用于验收硬件 WSS 的中间字幕时延。模拟器也需用户自己的企业账号及 Azure 配置。

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
会话恢复、记住密码、主动退出、键盘以及 320 / 368 / 480 像素宽屏的浅暗色布局。
Playwright 使用真实像素字体检查正常和全屏页面，确认文字和图形不越界、主体非空、
IMU 改变渲染像素；截图位于 `dist/screenshots/`，生成文件不提交。

已在 PixelBox S3 使用保存的企业会话与 Azure 配置验证连续两轮识别、AI 连接复用和实际播报，
详见 [真机诊断记录](../../docs/speech-network-performance.md)。尚未覆盖全新账号登录、
原故障网络的备用 DNS、长时间稳定性和多种噪声/距离下的唤醒准确率。
可编译与模拟测试通过不等于这些硬件和服务路径已验收。
