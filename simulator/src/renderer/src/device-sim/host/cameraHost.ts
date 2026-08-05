/**
 * 宿主摄像头(px.camera 映射电脑摄像头)
 * getUserMedia(video) → 隐藏 <video> → canvas 截帧 → JPEG 编码回传沙箱
 */

type FrameEmit = (frame: ArrayBuffer) => void

export class CameraHost {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private width = 320
  private height = 240
  private quality = 0.8
  private streamTimer: number | null = null
  private onActiveChange: (active: boolean, stream: MediaStream | null) => void

  constructor(onActiveChange: (active: boolean, stream: MediaStream | null) => void) {
    this.onActiveChange = onActiveChange
  }

  async init(opts: { width: number; height: number; quality: number }): Promise<void> {
    this.width = opts.width
    this.height = opts.height
    // 契约 quality 1-63(越小越清晰)→ canvas 0-1(越大越清晰)
    this.quality = Math.min(0.95, Math.max(0.3, 1 - opts.quality / 63))
    if (this.stream) return
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: opts.width }, height: { ideal: opts.height } }
    })
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    this.stream = stream
    this.video = video
    this.canvas = document.createElement('canvas')
    this.onActiveChange(true, stream)
  }

  private async grabJpeg(): Promise<ArrayBuffer> {
    if (!this.video || !this.canvas) throw new Error('摄像头未初始化,请先调用 camera.init()')
    const canvas = this.canvas
    canvas.width = this.width
    canvas.height = this.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布上下文')
    ctx.drawImage(this.video, 0, 0, this.width, this.height)
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/jpeg', this.quality)
    )
    if (!blob) throw new Error('JPEG 编码失败')
    return blob.arrayBuffer()
  }

  async capture(): Promise<ArrayBuffer> {
    if (!this.stream) await this.init({ width: this.width, height: this.height, quality: 12 })
    return this.grabJpeg()
  }

  startStream(fps: number, emit: FrameEmit): void {
    this.stopStream()
    const interval = 1000 / Math.min(30, Math.max(1, fps))
    const tick = async (): Promise<void> => {
      try {
        if (!this.stream) await this.init({ width: this.width, height: this.height, quality: 12 })
        emit(await this.grabJpeg())
      } catch {
        // 单帧失败不终止流
      }
    }
    this.streamTimer = window.setInterval(() => void tick(), interval)
  }

  stopStream(): void {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer)
      this.streamTimer = null
    }
  }

  deinit(): void {
    this.stopStream()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video = null
    this.canvas = null
    this.onActiveChange(false, null)
  }

  dispose(): void {
    this.deinit()
  }
}
