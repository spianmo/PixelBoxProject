/**
 * px.voice —— 语音对话(与真机同协议直连中继服务器)
 *
 * 协议(docs/architecture.md §7):
 *   ws://<server>:8787/realtime?token=<token>
 *   上行二进制  PCM16LE mono 16k 麦克风帧(listening 期间)
 *   上行文本    session.start / speech.end / interrupt / text.input / tts.request(扩展,say 用)
 *   下行文本    stt.final / llm.delta / llm.done / tts.begin / tts.end / error
 *   下行二进制  TTS PCM16LE(采样率以 tts.begin 为准)
 *
 * 状态机:idle → connecting → listening → thinking → speaking → idle
 *   - 浏览器端能量 VAD:speechStart / speechEnd + vadSilenceMs 静音判定
 *   - speaking 中检测到持续人声 → barge-in:发 interrupt 回到 listening
 */
import type { HostLink } from './rpc'
import { NamedEmitter } from './events'
import { clamp } from './util'
import type { MicBridge, MicConsumer } from './audio'

type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'

interface VoiceConfig {
  serverUrl: string
  token?: string
  wakeword?: boolean
  vadSilenceMs?: number
}

const MIC_RATE = 16000
const MIC_FRAME_MS = 32
/** 能量阈值(0-100 电平),超过视为人声 */
const SPEECH_LEVEL = 12
/** barge-in 需要连续人声帧数 */
const BARGE_IN_FRAMES = 8
/** level 事件节流间隔 */
const LEVEL_THROTTLE_MS = 100

export class VoiceImpl {
  private link: HostLink
  private micBridge: MicBridge
  private deviceId: string
  private logWarn: (msg: string) => void
  /** 原生 WebSocket 构造器(全局 WebSocket 会被契约包装类覆盖,这里保留原生引用) */
  private wsCtor: typeof WebSocket

  private config: VoiceConfig | null = null
  private stateValue: VoiceState = 'idle'
  private events = new NamedEmitter()

  private ws: WebSocket | null = null
  private mic: MicConsumer | null = null
  private continuous = false
  private speechActive = false
  private lastVoiceAt = 0
  private bargeInCount = 0
  private lastLevelAt = 0

  /** 当前 TTS 播放流(宿主播放器 id) */
  private ttsStreamId: number | null = null
  private ttsSampleRate = 16000
  private ttsEnded = false
  private sayResolve: (() => void) | null = null

  constructor(
    link: HostLink,
    micBridge: MicBridge,
    deviceId: string,
    logWarn: (msg: string) => void,
    wsCtor: typeof WebSocket
  ) {
    this.link = link
    this.micBridge = micBridge
    this.deviceId = deviceId
    this.logWarn = logWarn
    this.wsCtor = wsCtor
    // TTS 流播完(宿主上报)→ 回 idle / 继续听
    link.on<{ id: number }>('player-ended', (ev) => {
      if (this.ttsStreamId !== null && ev.id === this.ttsStreamId && this.ttsEnded) {
        this.onTtsPlaybackDone()
      }
    })
  }

  // ---------------- 公共 API(与 d.ts PxVoice 对齐) ----------------

  configure(opts: VoiceConfig): void {
    if (!opts || typeof opts.serverUrl !== 'string' || opts.serverUrl.length === 0) {
      throw new Error('voice.configure 需要 serverUrl')
    }
    this.config = { vadSilenceMs: 800, ...opts }
  }

  start(): void {
    this.continuous = false
    this.beginSession()
  }

  startContinuous(): void {
    this.continuous = true
    this.beginSession()
  }

  stop(): void {
    this.continuous = false
    this.teardown()
    this.setState('idle')
  }

  interrupt(): void {
    if (this.stateValue === 'speaking') {
      this.sendJson({ type: 'interrupt' })
      this.stopTtsPlayback()
      if (this.continuous || this.mic) {
        this.enterListening()
      } else {
        this.setState('idle')
      }
    }
  }

  sendText(text: string): void {
    this.ensureConnected(() => {
      this.sendJson({ type: 'text.input', text })
      this.setState('thinking')
    })
  }

  say(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.ensureConnected(() => {
        this.sayResolve = resolve
        this.sendJson({ type: 'tts.request', text })
      })
    })
  }

  state(): VoiceState {
    return this.stateValue
  }

  on(event: string, cb: (...args: unknown[]) => void): () => void {
    return this.events.on(event, (data) => {
      cb(data)
    })
  }

  // ---------------- 内部:连接与会话 ----------------

  private setState(s: VoiceState): void {
    if (this.stateValue === s) return
    this.stateValue = s
    this.events.emit('stateChange', s)
    this.link.emit('voice-state', { state: s })
  }

  private emitError(message: string): void {
    this.events.emit('error', message)
    this.logWarn(`voice: ${message}`)
  }

  private buildUrl(): string {
    const cfg = this.config
    if (!cfg) throw new Error('voice 未配置,请先调用 voice.configure({serverUrl})')
    const sep = cfg.serverUrl.includes('?') ? '&' : '?'
    return cfg.token ? `${cfg.serverUrl}${sep}token=${encodeURIComponent(cfg.token)}` : cfg.serverUrl
  }

  /** 确保 ws 已连接后执行(未连接则先连) */
  private ensureConnected(then: () => void): void {
    if (!this.config) {
      this.emitError('voice 未配置,请先调用 voice.configure({serverUrl})')
      return
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      then()
      return
    }
    this.connect(then)
  }

  private connect(onOpen: () => void): void {
    this.teardownWs()
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new this.wsCtor(this.buildUrl())
    } catch (err) {
      this.emitError(`连接失败: ${err instanceof Error ? err.message : String(err)}`)
      this.setState('idle')
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.sendJson({ type: 'session.start', device: this.deviceId, sampleRate: MIC_RATE })
      onOpen()
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') this.handleServerText(ev.data)
      else this.handleServerBinary(ev.data as ArrayBuffer)
    }
    ws.onerror = () => {
      this.emitError('中继服务器连接错误')
    }
    ws.onclose = () => {
      if (this.stateValue !== 'idle') {
        this.emitError('中继服务器连接已断开')
        this.teardown()
        this.setState('idle')
      }
    }
  }

  private beginSession(): void {
    this.ensureConnected(() => this.enterListening())
  }

  // ---------------- 内部:listening + VAD ----------------

  private enterListening(): void {
    this.stopTtsPlayback()
    this.speechActive = false
    this.lastVoiceAt = performance.now()
    this.setState('listening')
    if (!this.mic) {
      this.mic = this.micBridge.start(
        MIC_RATE,
        MIC_FRAME_MS,
        (pcm) => this.handleMicFrame(pcm),
        (msg) => {
          this.emitError(`麦克风不可用: ${msg}`)
          this.stop()
        }
      )
    }
  }

  private stopMic(): void {
    this.mic?.stop()
    this.mic = null
  }

  /** 帧能量 → 0-100 电平 */
  private frameLevel(pcm: ArrayBuffer): number {
    const view = new Int16Array(pcm)
    if (view.length === 0) return 0
    let sum = 0
    for (let i = 0; i < view.length; i++) sum += view[i] * view[i]
    const rms = Math.sqrt(sum / view.length)
    return clamp(Math.round((rms / 32768) * 400), 0, 100)
  }

  private handleMicFrame(pcm: ArrayBuffer): void {
    const level = this.frameLevel(pcm)
    const now = performance.now()
    if (now - this.lastLevelAt >= LEVEL_THROTTLE_MS) {
      this.lastLevelAt = now
      this.events.emit('level', level)
    }

    if (this.stateValue === 'listening') {
      // 持续上行音频帧
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm)

      const silenceMs = this.config?.vadSilenceMs ?? 800
      if (level >= SPEECH_LEVEL) {
        if (!this.speechActive) {
          this.speechActive = true
          this.events.emit('speechStart')
        }
        this.lastVoiceAt = now
      } else if (this.speechActive && now - this.lastVoiceAt >= silenceMs) {
        // 说完了
        this.speechActive = false
        this.events.emit('speechEnd')
        this.sendJson({ type: 'speech.end' })
        this.setState('thinking')
      }
    } else if (this.stateValue === 'speaking') {
      // barge-in:持续人声帧计数
      if (level >= SPEECH_LEVEL) {
        this.bargeInCount++
        if (this.bargeInCount >= BARGE_IN_FRAMES) {
          this.bargeInCount = 0
          this.interrupt()
        }
      } else {
        this.bargeInCount = 0
      }
    }
  }

  // ---------------- 内部:服务器下行 ----------------

  private handleServerText(raw: string): void {
    let msg: { type?: string; text?: string; sampleRate?: number; message?: string }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      return
    }
    switch (msg.type) {
      case 'stt.final':
        this.events.emit('userText', msg.text ?? '')
        break
      case 'llm.delta':
        this.events.emit('assistantDelta', msg.text ?? '')
        break
      case 'llm.done':
        this.events.emit('assistantText', msg.text ?? '')
        break
      case 'tts.begin':
        this.ttsSampleRate = msg.sampleRate ?? 16000
        this.ttsEnded = false
        this.openTtsStream()
        this.bargeInCount = 0
        this.setState('speaking')
        break
      case 'tts.end':
        this.ttsEnded = true
        if (this.ttsStreamId !== null) {
          void this.link.call('player.stream.end', { id: this.ttsStreamId }).catch(() => undefined)
        } else {
          // 没有实际音频帧,直接完成
          this.onTtsPlaybackDone()
        }
        break
      case 'error':
        this.emitError(msg.message ?? '服务器错误')
        if (this.stateValue === 'thinking' || this.stateValue === 'speaking') {
          this.afterRound()
        }
        break
      default:
        break
    }
  }

  private handleServerBinary(buf: ArrayBuffer): void {
    if (this.ttsStreamId !== null) {
      void this.link
        .call('player.stream.feed', { id: this.ttsStreamId, pcm: buf }, [buf])
        .catch(() => undefined)
    }
  }

  // ---------------- 内部:TTS 播放 ----------------

  private openTtsStream(): void {
    this.stopTtsPlayback()
    void this.link
      .call<{ id: number }>('player.stream.open', { sampleRate: this.ttsSampleRate, channels: 1 })
      .then((r) => {
        this.ttsStreamId = r.id
      })
      .catch((err) => this.emitError(`TTS 播放失败: ${err.message}`))
  }

  private stopTtsPlayback(): void {
    if (this.ttsStreamId !== null) {
      void this.link.call('player.ctl', { id: this.ttsStreamId, op: 'stop' }).catch(() => undefined)
      this.ttsStreamId = null
    }
  }

  /** TTS 播完(自然结束) */
  private onTtsPlaybackDone(): void {
    this.ttsStreamId = null
    if (this.sayResolve) {
      this.sayResolve()
      this.sayResolve = null
    }
    this.afterRound()
  }

  /** 一轮对话结束:持续模式回到 listening,否则 idle */
  private afterRound(): void {
    if (this.continuous) {
      this.enterListening()
    } else {
      this.stopMic()
      this.setState('idle')
    }
  }

  // ---------------- 内部:清理 ----------------

  private sendJson(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  private teardownWs(): void {
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        // 忽略
      }
      this.ws = null
    }
  }

  private teardown(): void {
    this.stopMic()
    this.stopTtsPlayback()
    this.teardownWs()
    if (this.sayResolve) {
      this.sayResolve()
      this.sayResolve = null
    }
  }
}
