/**
 * 宿主麦克风采集:getUserMedia + AudioWorklet 抓取原始 Float32 块,
 * 线性重采样到各消费者要求的采样率(默认 16k),按 frameMs 切帧输出 PCM16LE。
 * 支持多消费者(px.audio.mic 与 px.voice 同时用麦)。
 */

type FrameEmit = (consumerId: number, pcm: ArrayBuffer) => void
type ErrorEmit = (consumerId: number, message: string) => void

/** AudioWorklet 处理器源码(Blob URL 注册,避免打包器对 worklet 的特殊处理) */
const WORKLET_SOURCE = `
class PxMicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('px-mic-tap', PxMicTap);
`

/** 线性插值重采样 + 帧切分 */
class ConsumerPipe {
  private ratio: number
  private frameSamples: number
  private pending: Float32Array = new Float32Array(0)
  private srcPos = 0
  private out: number[] = []

  constructor(srcRate: number, dstRate: number, frameMs: number) {
    this.ratio = srcRate / dstRate
    this.frameSamples = Math.max(1, Math.round((dstRate * frameMs) / 1000))
  }

  /** 输入一块源采样,返回若干完整 PCM16 帧 */
  push(block: Float32Array): ArrayBuffer[] {
    // 拼接残留
    const merged = new Float32Array(this.pending.length + block.length)
    merged.set(this.pending)
    merged.set(block, this.pending.length)

    while (this.srcPos + 1 < merged.length) {
      const i = Math.floor(this.srcPos)
      const frac = this.srcPos - i
      this.out.push(merged[i] * (1 - frac) + merged[i + 1] * frac)
      this.srcPos += this.ratio
    }
    // 保留未消费的尾部
    const keepFrom = Math.floor(this.srcPos)
    this.pending = merged.slice(keepFrom)
    this.srcPos -= keepFrom

    const frames: ArrayBuffer[] = []
    while (this.out.length >= this.frameSamples) {
      const chunk = this.out.splice(0, this.frameSamples)
      const pcm = new Int16Array(this.frameSamples)
      for (let i = 0; i < chunk.length; i++) {
        const v = Math.max(-1, Math.min(1, chunk[i]))
        pcm[i] = Math.round(v * 32767)
      }
      frames.push(pcm.buffer)
    }
    return frames
  }
}

export class MicHost {
  private media: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private consumers = new Map<number, ConsumerPipe>()
  private emitFrame: FrameEmit
  private emitError: ErrorEmit
  private starting: Promise<void> | null = null
  private onActiveChange: (active: boolean) => void

  constructor(emitFrame: FrameEmit, emitError: ErrorEmit, onActiveChange: (active: boolean) => void) {
    this.emitFrame = emitFrame
    this.emitError = emitError
    this.onActiveChange = onActiveChange
  }

  async start(consumerId: number, sampleRate: number, frameMs: number): Promise<void> {
    try {
      await this.ensureCapture()
    } catch (err) {
      this.emitError(consumerId, err instanceof Error ? err.message : String(err))
      throw err
    }
    const srcRate = this.ctx?.sampleRate ?? 48000
    this.consumers.set(consumerId, new ConsumerPipe(srcRate, sampleRate, frameMs))
    this.onActiveChange(true)
  }

  stop(consumerId: number): void {
    this.consumers.delete(consumerId)
    if (this.consumers.size === 0) {
      this.teardown()
      this.onActiveChange(false)
    }
  }

  private async ensureCapture(): Promise<void> {
    if (this.node) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      })
      const ctx = new AudioContext()
      const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
      try {
        await ctx.audioWorklet.addModule(workletUrl)
      } finally {
        URL.revokeObjectURL(workletUrl)
      }
      const src = ctx.createMediaStreamSource(media)
      const node = new AudioWorkletNode(ctx, 'px-mic-tap')
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const block = ev.data
        for (const [id, pipe] of this.consumers) {
          for (const frame of pipe.push(block)) {
            this.emitFrame(id, frame)
          }
        }
      }
      src.connect(node)
      // Worklet 不需要输出到扬声器,接一个 0 增益结点保持图活跃
      const mute = ctx.createGain()
      mute.gain.value = 0
      node.connect(mute)
      mute.connect(ctx.destination)
      this.media = media
      this.ctx = ctx
      this.node = node
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private teardown(): void {
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    this.media?.getTracks().forEach((t) => t.stop())
    this.media = null
    void this.ctx?.close()
    this.ctx = null
  }

  dispose(): void {
    this.consumers.clear()
    this.teardown()
    this.onActiveChange(false)
  }
}
