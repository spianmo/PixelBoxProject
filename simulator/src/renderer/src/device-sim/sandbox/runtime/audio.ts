/**
 * px.audio —— 麦克风 / 播放器 / 录音
 *
 * 实际的 getUserMedia + AudioWorklet 采集与 WebAudio 播放都在宿主(renderer host)完成,
 * 沙箱内只做:
 *   - 麦克风多消费者分发(px.audio.mic 与 px.voice 可同时用麦)
 *   - 播放句柄/PCM 流的 RPC 代理与状态镜像
 *   - record() = 采集 + WAV 封装 + 写入虚拟 /data
 */
import type { HostLink } from './rpc'
import { Emitter } from './events'
import { clamp, toArrayBufferCopy } from './util'
import type { Vfs } from './storage'
import type { MicFramePayload, MicErrorPayload, PlayerEndedPayload, PlayerStatePayload } from '../../protocol'

type BinaryLike = ArrayBuffer | Uint8Array

// ---------------------------------------------------------------
// 麦克风桥(多消费者)
// ---------------------------------------------------------------

export interface MicConsumer {
  id: number
  stop(): void
}

export class MicBridge {
  private link: HostLink
  private nextId = 1
  private handlers = new Map<number, (pcm: ArrayBuffer) => void>()
  private errorHandlers = new Map<number, (msg: string) => void>()

  constructor(link: HostLink) {
    this.link = link
    link.on<MicFramePayload>('mic-frame', (ev) => {
      this.handlers.get(ev.consumerId)?.(ev.pcm)
    })
    link.on<MicErrorPayload>('mic-error', (ev) => {
      this.errorHandlers.get(ev.consumerId)?.(ev.message)
    })
  }

  start(
    sampleRate: number,
    frameMs: number,
    onData: (pcm: ArrayBuffer) => void,
    onError?: (msg: string) => void
  ): MicConsumer {
    const id = this.nextId++
    this.handlers.set(id, onData)
    if (onError) this.errorHandlers.set(id, onError)
    this.link
      .call('mic.start', { consumerId: id, sampleRate, frameMs })
      .catch((err) => onError?.(err instanceof Error ? err.message : String(err)))
    return {
      id,
      stop: () => {
        this.handlers.delete(id)
        this.errorHandlers.delete(id)
        void this.link.call('mic.stop', { consumerId: id }).catch(() => undefined)
      }
    }
  }
}

// ---------------------------------------------------------------
// 播放句柄代理
// ---------------------------------------------------------------

class PlayHandleImpl {
  private link: HostLink
  private id: number
  private playingFlag = true
  private endedEmitter = new Emitter<void>()

  constructor(link: HostLink, id: number, registry: Map<number, PlayHandleImpl>) {
    this.link = link
    this.id = id
    registry.set(id, this)
  }

  /** 宿主报告播放结束 */
  handleEnded(): void {
    this.playingFlag = false
    this.endedEmitter.emit()
  }

  stop(): void {
    this.playingFlag = false
    void this.link.call('player.ctl', { id: this.id, op: 'stop' }).catch(() => undefined)
  }

  pause(): void {
    this.playingFlag = false
    void this.link.call('player.ctl', { id: this.id, op: 'pause' }).catch(() => undefined)
  }

  resume(): void {
    this.playingFlag = true
    void this.link.call('player.ctl', { id: this.id, op: 'resume' }).catch(() => undefined)
  }

  get playing(): boolean {
    return this.playingFlag
  }

  onEnded(cb: () => void): () => void {
    return this.endedEmitter.on(cb)
  }
}

// ---------------------------------------------------------------
// PCM 流代理
// ---------------------------------------------------------------

class PcmStreamImpl {
  private link: HostLink
  private idPromise: Promise<number>
  private endedEmitter = new Emitter<void>()
  private bufferedMs = 0
  private bufferedAt = 0
  private closed = false

  constructor(link: HostLink, sampleRate: number, channels: number, registry: Map<number, PcmStreamImpl>) {
    this.link = link
    this.idPromise = link
      .call<{ id: number }>('player.stream.open', { sampleRate, channels })
      .then((r) => {
        registry.set(r.id, this)
        return r.id
      })
  }

  handleEnded(): void {
    this.endedEmitter.emit()
  }

  feed(pcm: BinaryLike): void {
    if (this.closed) return
    const buf = toArrayBufferCopy(pcm)
    void this.idPromise.then((id) =>
      this.link
        .call<{ buffered: number }>('player.stream.feed', { id, pcm: buf }, [buf])
        .then((r) => {
          this.bufferedMs = r.buffered
          this.bufferedAt = performance.now()
        })
        .catch(() => undefined)
    )
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    void this.idPromise.then((id) => this.link.call('player.stream.end', { id }).catch(() => undefined))
  }

  stop(): void {
    this.closed = true
    void this.idPromise.then((id) =>
      this.link.call('player.ctl', { id, op: 'stop' }).catch(() => undefined)
    )
  }

  onEnded(cb: () => void): () => void {
    return this.endedEmitter.on(cb)
  }

  buffered(): number {
    // 以最近一次 feed 回执为基准做时间衰减估算
    const elapsed = this.bufferedAt === 0 ? 0 : performance.now() - this.bufferedAt
    return Math.max(0, Math.round(this.bufferedMs - elapsed))
  }
}

// ---------------------------------------------------------------
// px.audio 组装
// ---------------------------------------------------------------

export interface AudioNamespace {
  audio: Record<string, unknown>
  mic: MicBridge
}

export function createAudio(link: HostLink, vfs: Vfs, logWarn: (msg: string) => void): AudioNamespace {
  const micBridge = new MicBridge(link)
  const handles = new Map<number, PlayHandleImpl>()
  const streams = new Map<number, PcmStreamImpl>()
  let volume = 80
  let playingCount = 0
  let userMic: MicConsumer | null = null
  let micGain = 100

  link.on<PlayerEndedPayload>('player-ended', (ev) => {
    handles.get(ev.id)?.handleEnded()
    streams.get(ev.id)?.handleEnded()
    handles.delete(ev.id)
    streams.delete(ev.id)
  })
  link.on<PlayerStatePayload>('player-state', (ev) => {
    playingCount = ev.playingCount
  })

  /** 增益(0-100,100=原始电平)应用到 PCM16 帧 */
  function applyGain(pcm: ArrayBuffer): ArrayBuffer {
    if (micGain === 100) return pcm
    const factor = micGain / 100
    const view = new Int16Array(pcm)
    for (let i = 0; i < view.length; i++) {
      view[i] = clamp(Math.round(view[i] * factor), -32768, 32767)
    }
    return pcm
  }

  const mic = {
    start(opts: {
      sampleRate?: number
      frameMs?: number
      onData: (pcm: ArrayBuffer) => void
    }): void {
      if (!opts || typeof opts.onData !== 'function') {
        throw new Error('mic.start 需要 onData 回调')
      }
      if (userMic) userMic.stop()
      const rate = opts.sampleRate ?? 16000
      const frameMs = opts.frameMs ?? 32
      userMic = micBridge.start(
        rate,
        frameMs,
        (pcm) => opts.onData(applyGain(pcm)),
        (msg) => logWarn(`麦克风错误: ${msg}`)
      )
    },
    stop(): void {
      userMic?.stop()
      userMic = null
    },
    get active(): boolean {
      return userMic !== null
    },
    setGain(percent: number): void {
      micGain = clamp(percent, 0, 100)
    }
  }

  const player = {
    async play(src: string): Promise<PlayHandleImpl> {
      let params: { bytes?: ArrayBuffer; url?: string }
      if (/^https?:\/\//.test(src)) {
        params = { url: src }
      } else {
        const bytes = vfs.readBytes(src.startsWith('/') ? src : '/app/assets/' + src)
        params = { bytes }
      }
      const r = await link.call<{ id: number }>(
        'player.play',
        params,
        params.bytes ? [params.bytes] : []
      )
      return new PlayHandleImpl(link, r.id, handles)
    },

    playPcm(pcm: BinaryLike, opts?: { sampleRate?: number; channels?: 1 | 2 }): PlayHandleImpl {
      const buf = toArrayBufferCopy(pcm)
      // 同步返回句柄:先占位 id,由宿主回填(rpc 完成前 stop/pause 会排队)
      const handle = new LazyPlayHandle(link, handles)
      void link
        .call<{ id: number }>(
          'player.playPcm',
          { pcm: buf, sampleRate: opts?.sampleRate ?? 16000, channels: opts?.channels ?? 1 },
          [buf]
        )
        .then((r) => handle.attach(r.id))
        .catch((err) => logWarn(`playPcm 失败: ${err.message}`))
      return handle as unknown as PlayHandleImpl
    },

    openPcmStream(opts?: { sampleRate?: number; channels?: 1 | 2 }): PcmStreamImpl {
      return new PcmStreamImpl(link, opts?.sampleRate ?? 16000, opts?.channels ?? 1, streams)
    },

    tone(freqHz: number, durationMs: number, volumePct?: number): void {
      void link
        .call('player.tone', {
          freq: freqHz,
          ms: durationMs,
          volume: clamp(volumePct ?? 80, 0, 100)
        })
        .catch(() => undefined)
    },

    stopAll(): void {
      void link.call('player.stopAll', {}).catch(() => undefined)
    },

    get playing(): boolean {
      return playingCount > 0
    }
  }

  /** 录音到 /data(WAV 封装),返回实际时长毫秒 */
  async function record(path: string, opts?: { maxMs?: number; sampleRate?: number }): Promise<number> {
    const maxMs = opts?.maxMs ?? 5000
    const rate = opts?.sampleRate ?? 16000
    const chunks: Uint8Array[] = []
    let total = 0
    return new Promise<number>((resolve, reject) => {
      const consumer = micBridge.start(
        rate,
        32,
        (pcm) => {
          chunks.push(new Uint8Array(pcm))
          total += pcm.byteLength
        },
        (msg) => {
          consumer.stop()
          reject(new Error(`录音失败: ${msg}`))
        }
      )
      setTimeout(() => {
        consumer.stop()
        try {
          const pcmData = new Uint8Array(total)
          let off = 0
          for (const c of chunks) {
            pcmData.set(c, off)
            off += c.length
          }
          vfs.writeBytes(path, encodeWav(pcmData, rate, 1))
          const durationMs = Math.round((total / 2 / rate) * 1000)
          resolve(durationMs)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }, maxMs)
    })
  }

  const audio = {
    setVolume(percent: number): void {
      volume = clamp(percent, 0, 100)
      void link.call('player.setVolume', { volume }).catch(() => undefined)
    },
    getVolume(): number {
      return volume
    },
    mic,
    player,
    record
  }

  return { audio, mic: micBridge }
}

/** 延迟绑定 id 的播放句柄(playPcm 同步返回) */
class LazyPlayHandle {
  private link: HostLink
  private registry: Map<number, PlayHandleImpl>
  private id: number | null = null
  private queue: Array<() => void> = []
  private playingFlag = true
  private endedEmitter = new Emitter<void>()

  constructor(link: HostLink, registry: Map<number, PlayHandleImpl>) {
    this.link = link
    this.registry = registry
  }

  attach(id: number): void {
    this.id = id
    this.registry.set(id, this as unknown as PlayHandleImpl)
    for (const fn of this.queue) fn()
    this.queue = []
  }

  handleEnded(): void {
    this.playingFlag = false
    this.endedEmitter.emit()
  }

  private ctl(op: string): void {
    const send = (): void => {
      if (this.id !== null) {
        void this.link.call('player.ctl', { id: this.id, op }).catch(() => undefined)
      }
    }
    if (this.id === null) this.queue.push(send)
    else send()
  }

  stop(): void {
    this.playingFlag = false
    this.ctl('stop')
  }

  pause(): void {
    this.playingFlag = false
    this.ctl('pause')
  }

  resume(): void {
    this.playingFlag = true
    this.ctl('resume')
  }

  get playing(): boolean {
    return this.playingFlag
  }

  onEnded(cb: () => void): () => void {
    return this.endedEmitter.on(cb)
  }
}

/** PCM16LE → WAV(RIFF)封装 */
export function encodeWav(pcm: Uint8Array, sampleRate: number, channels: number): ArrayBuffer {
  const header = new ArrayBuffer(44)
  const dv = new DataView(header)
  const byteRate = sampleRate * channels * 2
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + pcm.length, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, channels, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, byteRate, true)
  dv.setUint16(32, channels * 2, true)
  dv.setUint16(34, 16, true)
  writeStr(36, 'data')
  dv.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header))
  out.set(pcm, 44)
  return out.buffer
}
