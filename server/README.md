# PixelBox 语音中继服务器

设备(或模拟器)通过 WebSocket 把麦克风 PCM 推上来,服务器串联 **STT → LLM → TTS** 三个 OpenAI 兼容服务,把识别文本、流式回复与合成语音推回设备。协议定义见 `docs/architecture.md §7`。

```
设备/模拟器  ── PCM16LE 16k ──▶  /realtime  ──▶  STT(/audio/transcriptions)
            ◀─ stt.final ───────────┘
            ◀─ llm.delta* ──────  LLM(/chat/completions, stream)
            ◀─ tts.begin + PCM ─  TTS(/audio/speech, pcm/wav)
```

## 功能特性

- **WS `/realtime`(默认端口 8787)**:上行 PCM 累积;`speech.end` 或服务端**静默兜底**(能量 VAD / 音频流中断 / 超长截断)触发 STT
- **`interrupt` 打断**:立即中止 LLM 流式请求与 TTS 推流(代次失效 + AbortController 双保险),并补发 `tts.end` 收尾
- **`text.input` 纯文本直通 LLM**(不经 STT)
- **多轮对话上下文**:每连接独立,轮数上限 `MAX_HISTORY_TURNS`
- **句子级并行 TTS**:LLM 增量文本实时切句,多句并行合成、严格按序推流,显著降低首包延迟
- **TTS 格式协商**:优先 `response_format=pcm`(采样率按服务商标注,`tts.begin` 携带);拿不到 pcm 自动降级 `wav` 并本地解头
- **鉴权**:`VOICE_TOKEN` 非空时校验 `?token=`
- **健康检查**:`GET /healthz`

## 快速开始

要求 Node.js >= 20。

```bash
pnpm install                  # 仓库根执行(pnpm workspace);失败时加 --registry=https://registry.npmmirror.com
cd server
cp .env.example .env          # 填入 API Key(OpenAI 或硅基流动,见文件内两套注释示例)
pnpm run dev                  # 开发模式(tsx watch)
# 或
pnpm run build && pnpm start  # 编译到 dist/ 后运行
```

验证:

```bash
curl http://127.0.0.1:8787/healthz
# {"ok":true,"uptimeSec":3,"sessions":0,"models":{...}}
```

## 与模拟器 / 真机联调

1. **启动服务器**:`pnpm run dev`,确认 `/healthz` 正常。
2. **模拟器**:在模拟器 IDE 中打开 `examples/03-voice-assistant`,把中继地址设为
   `ws://127.0.0.1:8787/realtime`(示例通过 `px.storage.kv` 的 `voice.server` 键读取,详见该示例 README),点击运行后按提示触发对话。模拟器的 voice 域与真机走完全相同的协议。
3. **真机**:确保盒子与电脑在同一局域网,把地址改为电脑局域网 IP,如
   `ws://192.168.1.50:8787/realtime`;若 `.env` 设置了 `VOICE_TOKEN`,设备端需
   `px.voice.configure({ serverUrl, token })` 传同一 token。
4. **不接设备手工测试**(wscat):

   ```bash
   npx wscat -c "ws://127.0.0.1:8787/realtime"
   > {"type":"session.start","device":"test","sampleRate":16000}
   > {"type":"text.input","text":"用一句话介绍你自己"}
   # 依次收到 llm.delta* / llm.done / tts.begin / 二进制音频帧 / tts.end
   > {"type":"interrupt"}      # 推流中发送可立即打断
   ```

## 协议实现说明

| 上行 | 说明 |
|---|---|
| 二进制帧 | PCM16LE 单声道麦克风数据,采样率以 `session.start.sampleRate` 为准(默认 16000) |
| `{type:'session.start', device, sampleRate}` | 声明设备与采样率,并清空收音缓冲 |
| `{type:'speech.end'}` | 设备端 VAD 判定说完,立即触发 STT |
| `{type:'interrupt'}` | 立即中止当前 LLM/TTS(barge-in) |
| `{type:'text.input', text}` | 纯文本直通 LLM |
| `{type:'tts.request', text}` | **协议扩展**:仅 TTS 播报、不入上下文,供固件实现 `px.voice.say()`;标准客户端可忽略。别名 `{type:'say', text}`(兼容固件历史版本上行格式)等价 |

| 下行 | 说明 |
|---|---|
| `{type:'stt.final', text}` | 最终识别文本(可能为空串,空串不会触发 LLM) |
| `{type:'llm.delta', text}` | LLM 流式增量 |
| `{type:'llm.done', text}` | LLM 完整回复 |
| `{type:'tts.begin', sampleRate}` | 本轮语音推流开始,声明下行 PCM 采样率 |
| 二进制帧 | TTS PCM16LE 单声道 |
| `{type:'tts.end'}` | 本轮语音推流结束(被打断时同样会发,便于设备收尾) |
| `{type:'error', message}` | 任一环节出错 |

**静默兜底**:设备漏发 `speech.end` 时,服务器基于帧能量(RMS)判定 —— 出现过人声且连续静音超过 `SILENCE_FALLBACK_MS`、或音频帧停止到达、或收音超过 `MAX_UTTERANCE_MS`,都会自动触发 STT;从头到尾无人声的缓冲会被定期丢弃。

**采样率**:`tts.begin.sampleRate` 以实际拿到的音频为准 —— pcm 路径用 `TTS_PCM_SAMPLE_RATE` 标注值,wav 降级路径用文件头解析值;同一轮内后续句子采样率不一致时自动线性重采样对齐。

## 配置项

全部走 `.env`,详见 [.env.example](./.env.example) 内注释,关键项:

| 变量 | 说明 | 默认 |
|---|---|---|
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | 三服务统一入口 | `https://api.openai.com/v1` |
| `LLM_MODEL` / `STT_MODEL` / `TTS_MODEL` / `TTS_VOICE` | 模型与音色 | gpt-4o-mini / whisper-1 / tts-1 / alloy |
| `SYSTEM_PROMPT` | 系统提示词 | 内置中文助手人设 |
| `VOICE_TOKEN` | 连接鉴权 | 空(不校验) |
| `MAX_HISTORY_TURNS` | 上下文轮数上限 | 8 |
| `TTS_PCM_SAMPLE_RATE` | pcm 输出采样率(按服务商标注) | 24000 |
| `TTS_SAMPLE_RATE_PARAM` | >0 时把 `sample_rate` 写入 TTS 请求体(硅基流动) | 0 |
| `STT_BASE_URL` 等 | 三服务分别指向不同供应商 | 回落到 OPENAI_* |

## 目录结构

```
server/
├── src/
│   ├── index.ts          # HTTP + WS 入口、鉴权、心跳
│   ├── session.ts        # 会话:协议路由、静默兜底 VAD、流水线代次控制
│   ├── tts_pump.ts       # 句子级并行合成 + 按序推流(限速/背压/打断)
│   ├── sentence.ts       # 流式句子切分
│   ├── wav.ts            # WAV 封装/解析/PCM 重采样
│   ├── config.ts         # .env 解析
│   ├── util.ts           # 日志/信号/能量计算
│   └── adapters/
│       ├── stt.ts        # /audio/transcriptions(PCM 封 WAV,multipart)
│       ├── llm.ts        # /chat/completions(SSE 流式)
│       └── tts.ts        # /audio/speech(pcm 优先,wav 降级解头)
├── .env.example
└── package.json
```

## 常见问题

- **报错 "TTS 服务商返回 mp3"**:该服务商不支持 pcm/wav 输出,换支持 pcm 的模型(OpenAI tts-1、硅基流动 CosyVoice2 均可)。
- **设备播报声音变调**:`TTS_PCM_SAMPLE_RATE` 与服务商实际输出不符,按其文档修正;wav 降级路径不受此影响。
- **STT 总识别为空**:检查麦克风采样率是否与 `session.start.sampleRate` 一致、`VAD_ENERGY_THRESHOLD` 是否过高把人声当静音丢弃。
