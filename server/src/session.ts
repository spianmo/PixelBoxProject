/**
 * 会话:一条 WS 连接 = 一台设备 = 一份多轮对话上下文。
 *
 * 协议(docs/architecture.md §7):
 *   上行二进制  PCM16LE 单声道麦克风帧(listening 期间持续发送)
 *   上行文本    session.start / speech.end / interrupt / text.input
 *   下行文本    stt.final / llm.delta / llm.done / tts.begin / tts.end / error
 *   下行二进制  TTS PCM16LE(采样率以 tts.begin 为准)
 *
 * 关键机制:
 *   - speech.end 或【服务端静默兜底】(能量 VAD / 帧流中断 / 超长)触发 STT;
 *   - interrupt 立即中止 LLM 流与 TTS 推流(代次 gen + AbortController 双保险);
 *   - text.input 纯文本直通 LLM(不经 STT);
 *   - 多轮上下文按 MAX_HISTORY_TURNS 截断;
 *   - 扩展消息 tts.request{text}(别名 say{text},兼容固件历史版本):仅走 TTS 不入上下文,供 px.voice.say() 使用。
 */
import type { WebSocket, RawData } from 'ws';
import { config } from './config.js';
import { transcribe } from './adapters/stt.js';
import { chatStream, type ChatMessage } from './adapters/llm.js';
import { SentenceSplitter, splitSentences } from './sentence.js';
import { TtsPump } from './tts_pump.js';
import { pcm16Rms, log, logWarn, errMsg, isAbortError } from './util.js';

interface UpMsg {
  type?: unknown;
  device?: unknown;
  sampleRate?: unknown;
  text?: unknown;
}

export class Session {
  private device = 'unknown';
  /** 上行麦克风采样率(session.start 声明,默认 16k) */
  private micRate = 16000;
  /** 多轮对话历史(不含 system) */
  private readonly history: ChatMessage[] = [];

  // ---- 收音缓冲与服务端 VAD 兜底 ----
  private chunks: Buffer[] = [];
  private audioBytes = 0;
  private hadVoice = false;
  private lastVoiceAt = 0;
  private lastFrameAt = 0;
  private readonly vadTimer: NodeJS.Timeout;

  // ---- 流水线代次控制(interrupt / 新一轮输入时 +1,旧代立即失效) ----
  private gen = 0;
  private pipeAbort: AbortController | null = null;
  private pump: TtsPump | null = null;

  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly id: string,
  ) {
    this.ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(data, isBinary));
    this.ws.on('close', () => this.dispose());
    this.ws.on('error', (err) => logWarn(this.tag, `WS 错误: ${errMsg(err)}`));
    // 每 150ms 检查一次静默兜底条件
    this.vadTimer = setInterval(() => this.vadTick(), 150);
    log(this.tag, '连接建立');
  }

  private get tag(): string {
    return `sess#${this.id}`;
  }

  /** 连接关闭时清理 */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.vadTimer);
    this.cancelPipeline();
    this.resetAudio();
    log(this.tag, '连接关闭');
  }

  // ============================================================
  // 消息入口
  // ============================================================

  private onMessage(data: RawData, isBinary: boolean): void {
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    if (isBinary) {
      this.onAudio(buf);
      return;
    }
    let msg: UpMsg;
    try {
      msg = JSON.parse(buf.toString('utf8')) as UpMsg;
    } catch {
      this.sendError('无法解析的 JSON 消息');
      return;
    }
    const type = typeof msg.type === 'string' ? msg.type : '';
    switch (type) {
      case 'session.start': {
        this.device = typeof msg.device === 'string' && msg.device !== '' ? msg.device : 'unknown';
        const rate = Number(msg.sampleRate);
        this.micRate = Number.isFinite(rate) && rate > 0 ? rate : 16000;
        this.resetAudio();
        log(this.tag, `session.start device=${this.device} sampleRate=${this.micRate}`);
        break;
      }
      case 'speech.end':
        this.endOfSpeech('设备端 VAD (speech.end)');
        break;
      case 'interrupt':
        log(this.tag, '收到 interrupt,中止当前 LLM/TTS');
        this.cancelPipeline();
        this.resetAudio();
        break;
      case 'text.input': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (text === '') {
          this.sendError('text.input 缺少 text 字段');
          break;
        }
        log(this.tag, `text.input: ${text}`);
        this.startTurn(() => this.runChat(text));
        break;
      }
      case 'tts.request':
      case 'say': {
        // 协议扩展:纯 TTS 播报(px.voice.say),不进入对话上下文。
        // 兼容别名:固件历史版本 voicechat 上行使用 {type:"say"},与新版 {type:"tts.request"} 等价。
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (text === '') {
          this.sendError(`${type} 缺少 text 字段`);
          break;
        }
        log(this.tag, `${type}(纯播报): ${text.slice(0, 40)}`);
        this.startTurn(() => this.runSay(text));
        break;
      }
      default:
        logWarn(this.tag, `忽略未知消息类型: ${type}`);
    }
  }

  /** 上行 PCM 帧:累积 + 能量统计(供静默兜底判定) */
  private onAudio(frame: Buffer): void {
    if (frame.length === 0) return;
    this.chunks.push(frame);
    this.audioBytes += frame.length;
    this.lastFrameAt = Date.now();
    if (pcm16Rms(frame) >= config.vad.energyThreshold) {
      this.hadVoice = true;
      this.lastVoiceAt = this.lastFrameAt;
    }
  }

  // ============================================================
  // 服务端静默兜底 VAD
  // ============================================================

  private vadTick(): void {
    if (this.audioBytes === 0) return;
    const now = Date.now();
    const durMs = (this.audioBytes / (this.micRate * 2)) * 1000;
    // 1) 超长强制截断
    if (durMs >= config.vad.maxUtteranceMs) {
      this.endOfSpeech('达到最大收音时长');
      return;
    }
    // 2) 出现过人声,且已连续静音超过阈值
    if (this.hadVoice && now - this.lastVoiceAt >= config.vad.silenceMs) {
      this.endOfSpeech('服务端静默兜底');
      return;
    }
    // 3) 音频帧停止到达(设备停发但没说 speech.end)
    if (now - this.lastFrameAt >= config.vad.silenceMs * 3) {
      if (this.hadVoice) this.endOfSpeech('音频流中断兜底');
      else this.resetAudio();
      return;
    }
    // 4) 从头到尾都是静音,定期清空避免无限累积
    if (!this.hadVoice && durMs >= config.vad.silenceMs * 4) {
      this.resetAudio();
    }
  }

  private resetAudio(): void {
    this.chunks = [];
    this.audioBytes = 0;
    this.hadVoice = false;
    this.lastVoiceAt = 0;
  }

  /** 收音结束 → 取走缓冲 → STT → LLM → TTS */
  private endOfSpeech(reason: string): void {
    if (this.audioBytes === 0) {
      logWarn(this.tag, `收到收音结束信号(${reason})但无音频数据,忽略`);
      return;
    }
    const pcm = Buffer.concat(this.chunks);
    const voiced = this.hadVoice;
    this.resetAudio();
    const speechMs = (pcm.length / (this.micRate * 2)) * 1000;
    if (!voiced || speechMs < config.vad.minSpeechMs) {
      log(this.tag, `丢弃过短/无人声语音段 ${Math.round(speechMs)}ms (${reason})`);
      return;
    }
    log(this.tag, `收音结束 ${Math.round(speechMs)}ms,触发原因: ${reason}`);
    this.startTurn(() => this.runVoiceTurn(pcm));
  }

  // ============================================================
  // 流水线
  // ============================================================

  /** 开启新一代流水线:先打断旧代,再异步执行 */
  private startTurn(fn: () => Promise<void>): void {
    this.cancelPipeline();
    void fn().catch((err: unknown) => {
      if (isAbortError(err)) return;
      logWarn(this.tag, `流水线异常: ${errMsg(err)}`);
      this.sendError(errMsg(err));
    });
  }

  /** 打断当前流水线:代次 +1 使旧代失效,并中止全部在途请求与推流 */
  private cancelPipeline(): void {
    this.gen += 1;
    this.pipeAbort?.abort();
    this.pipeAbort = null;
    this.pump?.abort();
    this.pump = null;
  }

  /** 语音轮:STT → 对话 */
  private async runVoiceTurn(pcm: Buffer): Promise<void> {
    const myGen = this.gen;
    const ac = new AbortController();
    this.pipeAbort = ac;
    const t0 = Date.now();
    const text = await transcribe(pcm, this.micRate, ac.signal);
    if (myGen !== this.gen || this.closed) return;
    log(this.tag, `STT ${Date.now() - t0}ms: "${text}"`);
    this.send({ type: 'stt.final', text });
    if (text === '') return; // 空识别结果:仅回 stt.final,由设备决定是否重试
    await this.chatPipeline(text, myGen, ac);
  }

  /** 文本轮:直通 LLM(text.input) */
  private async runChat(text: string): Promise<void> {
    const myGen = this.gen;
    const ac = new AbortController();
    this.pipeAbort = ac;
    await this.chatPipeline(text, myGen, ac);
  }

  /** LLM 流式 + 句子级并行 TTS 推流 */
  private async chatPipeline(userText: string, myGen: number, ac: AbortController): Promise<void> {
    this.history.push({ role: 'user', content: userText });
    this.trimHistory();
    const messages: ChatMessage[] = [
      { role: 'system', content: config.systemPrompt },
      ...this.history,
    ];

    const pump = new TtsPump(this.ws, this.tag, () => myGen === this.gen && !this.closed);
    this.pump = pump;
    const splitter = new SentenceSplitter();
    let full = '';
    const t0 = Date.now();
    let firstDeltaAt = 0;
    try {
      for await (const delta of chatStream(messages, ac.signal)) {
        if (myGen !== this.gen || this.closed) return;
        if (firstDeltaAt === 0) firstDeltaAt = Date.now();
        full += delta;
        this.send({ type: 'llm.delta', text: delta });
        for (const sentence of splitter.push(delta)) pump.enqueue(sentence, ac.signal);
      }
      const rest = splitter.flush();
      if (rest !== null) pump.enqueue(rest, ac.signal);
      if (myGen !== this.gen || this.closed) return;
      this.send({ type: 'llm.done', text: full });
      log(this.tag, `LLM 完成 首包${firstDeltaAt - t0}ms 总${Date.now() - t0}ms 共${full.length}字`);
      // 助手回复入历史(被打断时不写入,避免上下文出现半截回复)
      this.history.push({ role: 'assistant', content: full });
      this.trimHistory();
      pump.finish();
      await pump.wait();
      if (myGen === this.gen && !pump.began && full.trim() !== '') {
        // LLM 有内容但一段音频都没推出去(TTS 全部失败)
        this.sendError('语音合成失败,请检查 TTS 配置');
      }
    } catch (err) {
      pump.abort();
      throw err;
    } finally {
      if (this.pump === pump) this.pump = null;
    }
  }

  /** 纯播报轮(协议扩展 tts.request):不写入上下文 */
  private async runSay(text: string): Promise<void> {
    const myGen = this.gen;
    const ac = new AbortController();
    this.pipeAbort = ac;
    const pump = new TtsPump(this.ws, this.tag, () => myGen === this.gen && !this.closed);
    this.pump = pump;
    try {
      for (const sentence of splitSentences(text)) pump.enqueue(sentence, ac.signal);
      pump.finish();
      await pump.wait();
      if (myGen === this.gen && !pump.began) {
        this.sendError('语音合成失败,请检查 TTS 配置');
      }
    } catch (err) {
      pump.abort();
      throw err;
    } finally {
      if (this.pump === pump) this.pump = null;
    }
  }

  /** 历史截断:最多保留 maxHistoryTurns 轮(用户+助手各一条为一轮) */
  private trimHistory(): void {
    const maxMsgs = config.maxHistoryTurns * 2;
    while (this.history.length > maxMsgs) this.history.shift();
  }

  // ============================================================
  // 下行发送
  // ============================================================

  private send(obj: Record<string, unknown>): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private sendError(message: string): void {
    this.send({ type: 'error', message });
  }
}
