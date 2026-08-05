/**
 * 宿主音频播放器(WebAudio)
 * 承接沙箱 player.* RPC:文件/URL 播放、原始 PCM、流式 PCM(TTS)、蜂鸣、总音量
 */

type EndedCallback = (id: number) => void
type StateCallback = (playingCount: number) => void

interface BufferEntry {
  kind: 'buffer'
  buffer: AudioBuffer
  source: AudioBufferSourceNode | null
  gain: GainNode
  /** 已播放偏移秒(pause/resume 用) */
  offset: number
  startedAt: number
  state: 'playing' | 'paused' | 'stopped'
}

interface StreamEntry {
  kind: 'stream'
  sampleRate: number
  channels: number
  gain: GainNode
  /** 下一段排期时间(AudioContext 时钟) */
  nextTime: number
  endedDeclared: boolean
  endTimer: number | null
  state: 'playing' | 'stopped'
  sources: Set<AudioBufferSourceNode>
}

type Entry = BufferEntry | StreamEntry

export class AudioPlayerHost {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private entries = new Map<number, Entry>()
  private nextId = 1
  private volumePct = 80
  private onEnded: EndedCallback
  private onState: StateCallback

  constructor(onEnded: EndedCallback, onState: StateCallback) {
    this.onEnded = onEnded
    this.onState = onState
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volumePct / 100
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private notifyState(): void {
    let n = 0
    for (const e of this.entries.values()) {
      if (e.state === 'playing') n++
    }
    this.onState(n)
  }

  setVolume(pct: number): void {
    this.volumePct = Math.min(100, Math.max(0, pct))
    if (this.master) this.master.gain.value = this.volumePct / 100
  }

  // ---------------- 文件 / URL / PCM ----------------

  /** 播放已解码为字节的 wav/mp3(decodeAudioData) */
  async playBytes(bytes: ArrayBuffer): Promise<{ id: number }> {
    const ctx = this.ensureCtx()
    const buffer = await ctx.decodeAudioData(bytes.slice(0))
    return this.startBuffer(buffer)
  }

  playPcm(pcm: ArrayBuffer, sampleRate: number, channels: number): { id: number } {
    const ctx = this.ensureCtx()
    const buffer = this.pcmToAudioBuffer(ctx, pcm, sampleRate, channels)
    return this.startBuffer(buffer)
  }

  private pcmToAudioBuffer(
    ctx: AudioContext,
    pcm: ArrayBuffer,
    sampleRate: number,
    channels: number
  ): AudioBuffer {
    const int16 = new Int16Array(pcm)
    const frames = Math.max(1, Math.floor(int16.length / channels))
    const buffer = ctx.createBuffer(channels, frames, sampleRate)
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < frames; i++) {
        data[i] = int16[i * channels + ch] / 32768
      }
    }
    return buffer
  }

  private startBuffer(buffer: AudioBuffer): { id: number } {
    const ctx = this.ensureCtx()
    const id = this.nextId++
    const gain = ctx.createGain()
    gain.connect(this.master as GainNode)
    const entry: BufferEntry = {
      kind: 'buffer',
      buffer,
      source: null,
      gain,
      offset: 0,
      startedAt: 0,
      state: 'playing'
    }
    this.entries.set(id, entry)
    this.startBufferSource(id, entry)
    this.notifyState()
    return { id }
  }

  private startBufferSource(id: number, entry: BufferEntry): void {
    const ctx = this.ensureCtx()
    const src = ctx.createBufferSource()
    src.buffer = entry.buffer
    src.connect(entry.gain)
    entry.source = src
    entry.startedAt = ctx.currentTime
    src.onended = () => {
      // 仅自然播完触发(pause/stop 会先置状态)
      if (entry.state === 'playing' && this.entries.get(id) === entry) {
        entry.state = 'stopped'
        this.entries.delete(id)
        this.notifyState()
        this.onEnded(id)
      }
    }
    src.start(0, Math.min(entry.offset, Math.max(0, entry.buffer.duration - 0.001)))
  }

  // ---------------- 流式 PCM ----------------

  streamOpen(sampleRate: number, channels: number): { id: number } {
    const ctx = this.ensureCtx()
    const id = this.nextId++
    const gain = ctx.createGain()
    gain.connect(this.master as GainNode)
    this.entries.set(id, {
      kind: 'stream',
      sampleRate,
      channels,
      gain,
      nextTime: ctx.currentTime + 0.06, // 少量初始缓冲防卡顿
      endedDeclared: false,
      endTimer: null,
      state: 'playing',
      sources: new Set()
    })
    this.notifyState()
    return { id }
  }

  streamFeed(id: number, pcm: ArrayBuffer): { buffered: number } {
    const entry = this.entries.get(id)
    if (!entry || entry.kind !== 'stream' || entry.state !== 'playing') return { buffered: 0 }
    const ctx = this.ensureCtx()
    const buffer = this.pcmToAudioBuffer(ctx, pcm, entry.sampleRate, entry.channels)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(entry.gain)
    const at = Math.max(ctx.currentTime, entry.nextTime)
    src.start(at)
    entry.nextTime = at + buffer.duration
    entry.sources.add(src)
    src.onended = () => entry.sources.delete(src)
    return { buffered: Math.max(0, Math.round((entry.nextTime - ctx.currentTime) * 1000)) }
  }

  streamEnd(id: number): void {
    const entry = this.entries.get(id)
    if (!entry || entry.kind !== 'stream' || entry.endedDeclared) return
    entry.endedDeclared = true
    const ctx = this.ensureCtx()
    const remainMs = Math.max(0, (entry.nextTime - ctx.currentTime) * 1000)
    entry.endTimer = window.setTimeout(() => {
      if (this.entries.get(id) === entry && entry.state === 'playing') {
        entry.state = 'stopped'
        this.entries.delete(id)
        this.notifyState()
        this.onEnded(id)
      }
    }, remainMs + 30)
  }

  // ---------------- 控制 ----------------

  ctl(id: number, op: 'stop' | 'pause' | 'resume'): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.kind === 'buffer') {
      const ctx = this.ensureCtx()
      if (op === 'pause' && entry.state === 'playing') {
        entry.offset += ctx.currentTime - entry.startedAt
        entry.state = 'paused'
        entry.source?.stop()
        entry.source = null
        this.notifyState()
      } else if (op === 'resume' && entry.state === 'paused') {
        entry.state = 'playing'
        this.startBufferSource(id, entry)
        this.notifyState()
      } else if (op === 'stop') {
        entry.state = 'stopped'
        try {
          entry.source?.stop()
        } catch {
          // 已停止
        }
        this.entries.delete(id)
        this.notifyState()
      }
    } else {
      // 流:pause/resume 不支持,等价 stop
      if (op === 'resume') return
      entry.state = 'stopped'
      if (entry.endTimer !== null) clearTimeout(entry.endTimer)
      for (const s of entry.sources) {
        try {
          s.stop()
        } catch {
          // 已停止
        }
      }
      entry.sources.clear()
      this.entries.delete(id)
      this.notifyState()
    }
  }

  tone(freq: number, ms: number, volumePct: number): void {
    const ctx = this.ensureCtx()
    const osc = ctx.createOscillator()
    osc.type = 'square' // 蜂鸣器方波
    osc.frequency.value = Math.max(20, freq)
    const gain = ctx.createGain()
    const v = Math.min(100, Math.max(0, volumePct)) / 100
    gain.gain.setValueAtTime(v * 0.4, ctx.currentTime)
    gain.gain.setValueAtTime(v * 0.4, ctx.currentTime + Math.max(0.01, ms / 1000) - 0.008)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + Math.max(0.01, ms / 1000))
    osc.connect(gain)
    gain.connect(this.master as GainNode)
    osc.start()
    osc.stop(ctx.currentTime + Math.max(0.01, ms / 1000) + 0.01)
  }

  stopAll(): void {
    for (const id of Array.from(this.entries.keys())) {
      this.ctl(id, 'stop')
    }
  }

  dispose(): void {
    this.stopAll()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }
}
