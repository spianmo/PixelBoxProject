/** px.speech 的桌面实现：复用真实麦克风和 Azure HTTPS；ESP-SR 唤醒只在固件运行。 */
import type { HostLink } from './rpc'
import type { MicBridge, MicConsumer } from './audio'
import type { FetchRpcResult } from '../../protocol'

interface SpeechConfig { region: string; key: string; language?: string; voice?: string }
interface RecognizeOptions {
  maxMs?: number
  silenceMs?: number
  timeoutMs?: number
  onLevel?: (level: number) => void
}

const RATE = 16000

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!)
}

export function pcmWav(pcm: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(44 + pcm.byteLength)
  const bytes = new Uint8Array(result)
  const view = new DataView(result)
  const tag = (at: number, value: string): void => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
  }
  tag(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); tag(8, 'WAVE')
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  tag(36, 'data'); view.setUint32(40, pcm.byteLength, true); bytes.set(pcm, 44)
  return result
}

export class SpeechImpl {
  private config: Required<SpeechConfig> | null = null
  private generation = 0
  private busy = false
  private mic: MicConsumer | null = null
  private player: number | null = null
  private rejectPending: ((error: Error) => void) | null = null
  private playbackDone: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private link: HostLink, private micBridge: MicBridge, private enabled = true) {
    link.on<{ id: number }>('player-ended', ({ id }) => {
      if (id === this.player) this.playbackDone?.()
    })
  }

  available(): boolean { return this.enabled }

  readonly wakeword = {
    start: async (_options: { phrase: string; pinyin: string; threshold: number; onWake: () => void; onError?: (message: string) => void }): Promise<void> => {
      throw new Error('ENOTSUP: ESP-SR 本地唤醒仅在 PixelBox 固件可用')
    },
    stop: (): void => { /* 桌面没有 ESP-SR 检测任务。 */ }
  }

  configure(options: SpeechConfig): void {
    if (!this.enabled) throw new Error('ENOTSUP')
    if (!options || !/^[a-z0-9]{1,40}$/.test(options.region)
      || !/^[\x21-\x7e]{8,256}$/.test(options.key)) {
      throw new Error('Azure 区域或密钥无效')
    }
    const language = options.language ?? 'zh-CN'
    const voice = options.voice ?? 'zh-CN-XiaoxiaoNeural'
    if (!/^[A-Za-z0-9-]{1,80}$/.test(language) || !/^[A-Za-z0-9-]{1,80}$/.test(voice)) {
      throw new Error('Azure 语言或音色无效')
    }
    this.cancel()
    this.config = { region: options.region, key: options.key, language, voice }
  }

  private begin(): { config: Required<SpeechConfig>; generation: number } {
    if (!this.enabled) throw new Error('ENOTSUP')
    if (!this.config) throw new Error('请先配置 Azure 语音服务')
    if (this.busy) throw new Error('语音操作进行中')
    this.busy = true
    return { config: this.config, generation: ++this.generation }
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('语音操作已取消')
  }

  private waitRequest<T>(request: Promise<T>): Promise<T> {
    // 宿主 HTTP 会按自身超时回收；取消立即结束本轮，迟到结果不再触发播放或字幕。
    return new Promise((resolve, reject) => {
      this.rejectPending = reject
      request.then(resolve, reject)
    })
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  cancel(): void {
    ++this.generation
    this.clearTimer()
    this.mic?.stop(); this.mic = null
    if (this.player !== null) void this.link.call('player.ctl', { id: this.player, op: 'stop' }).catch(() => undefined)
    this.player = null
    this.playbackDone = null
    this.rejectPending?.(new Error('语音操作已取消'))
    this.rejectPending = null
    this.busy = false
  }

  dispose(): void { this.cancel(); this.config = null }

  async recognize(options: RecognizeOptions = {}): Promise<string> {
    const { config, generation } = this.begin()
    try {
      const maxMs = Math.max(1000, Math.min(30000, options.maxMs ?? 15000))
      const silenceMs = Math.max(300, Math.min(3000, options.silenceMs ?? 800))
      const pcm = await new Promise<Uint8Array>((resolve, reject) => {
        this.rejectPending = reject
        const frames: Uint8Array[] = []
        let duration = 0, silent = 0, voiced = 0, noise = 180
        let hasSpeech = false, completed = false
        const finish = (error?: Error): void => {
          if (completed) return
          completed = true
          this.mic?.stop(); this.mic = null; this.clearTimer()
          if (error || !hasSpeech) { reject(error ?? new Error('未检测到语音')); return }
          const bytes = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0))
          let at = 0
          for (const frame of frames) { bytes.set(frame, at); at += frame.length }
          resolve(bytes)
        }
        this.timer = setTimeout(() => finish(), maxMs + 1000)
        this.mic = this.micBridge.start(RATE, 32, (frame) => {
          if (generation !== this.generation || completed) return
          if (frame.byteLength === 0 || frame.byteLength % 2 !== 0) return
          const remaining = Math.max(0, Math.floor((maxMs - duration) * 32 / 2) * 2)
          const bytes = new Uint8Array(frame.slice(0, remaining))
          frames.push(bytes)
          const view = new DataView(bytes.buffer)
          let square = 0
          for (let i = 0; i < bytes.length; i += 2) square += view.getInt16(i, true) ** 2
          const rms = Math.sqrt(square / Math.max(1, bytes.length / 2))
          const ms = bytes.length / 32
          duration += ms
          const speech = rms > Math.max(350, noise * 3)
          if (speech) { voiced += ms; silent = 0; if (voiced >= 96) hasSpeech = true }
          else { voiced = 0; silent += ms; if (!hasSpeech) noise = noise * 0.95 + rms * 0.05 }
          options.onLevel?.(Math.min(100, Math.round(rms / 8192 * 100)))
          if (duration >= maxMs || (hasSpeech && silent >= silenceMs)) finish()
        }, () => finish(new Error('麦克风不可用')))
      })
      this.assertCurrent(generation)
      const response = await this.waitRequest(this.link.call<FetchRpcResult>('fetch', {
        url: `https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(config.language)}&format=simple`,
        method: 'POST', redirect: 'error', timeoutMs: Math.max(5000, Math.min(60000, options.timeoutMs ?? 20000)),
        headers: { 'Ocp-Apim-Subscription-Key': config.key, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000' },
        body: pcmWav(pcm)
      }))
      this.assertCurrent(generation)
      if (response.status !== 200) throw new Error(`Azure 识别失败 (${response.status})`)
      const result = JSON.parse(new TextDecoder().decode(response.body)) as { RecognitionStatus?: string; DisplayText?: string }
      if (result.RecognitionStatus !== 'Success' || typeof result.DisplayText !== 'string' || !result.DisplayText.trim()) {
        throw new Error('未识别到有效语音')
      }
      return result.DisplayText.trim()
    } finally {
      if (generation === this.generation) { this.busy = false; this.rejectPending = null; this.clearTimer() }
    }
  }

  async speak(text: string): Promise<void> {
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 6000) throw new Error('播报文本须为 1 至 6000 字节')
    const { config, generation } = this.begin()
    try {
      const response = await this.waitRequest(this.link.call<FetchRpcResult>('fetch', {
        url: `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        method: 'POST', redirect: 'error', timeoutMs: 30000,
        headers: { 'Ocp-Apim-Subscription-Key': config.key, 'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'raw-16khz-16bit-mono-pcm', 'User-Agent': 'ObeingHarness-PixelBox' },
        bodyText: `<speak version="1.0" xml:lang="${config.language}"><voice name="${config.voice}">${xml(text)}</voice></speak>`
      }))
      this.assertCurrent(generation)
      if (response.status !== 200) throw new Error(`Azure 播报失败 (${response.status})`)
      if (!response.body.byteLength || response.body.byteLength % 2 || response.body.byteLength > 2 * 1024 * 1024) {
        throw new Error('Azure 音频长度无效')
      }
      const { id } = await this.link.call<{ id: number }>('player.stream.open', { sampleRate: RATE, channels: 1 })
      if (generation !== this.generation) {
        await this.link.call('player.ctl', { id, op: 'stop' }); this.assertCurrent(generation)
      }
      this.player = id
      // 先登记实际播放结束回调，再提交音频，防止短句提前结束导致 Promise 永不完成。
      const done = new Promise<void>((resolve, reject) => {
        this.rejectPending = reject
        this.playbackDone = resolve
        this.timer = setTimeout(() => reject(new Error('音频播放超时')), 90000)
      })
      // 在逐块 RPC 期间也处理取消，避免播放结束 Promise 提前 reject 成未处理异常。
      void done.catch(() => undefined)
      for (let at = 0; at < response.body.byteLength; at += 4096) {
        this.assertCurrent(generation)
        const pcm = response.body.slice(at, at + 4096)
        await this.link.call('player.stream.feed', { id, pcm }, [pcm])
      }
      await this.link.call('player.stream.end', { id })
      await done
      this.assertCurrent(generation)
    } finally {
      if (generation === this.generation) {
        if (this.player !== null) void this.link.call('player.ctl', { id: this.player, op: 'stop' }).catch(() => undefined)
        this.player = null; this.playbackDone = null; this.rejectPending = null; this.busy = false; this.clearTimer()
      }
    }
  }
}
