/**
 * px.screen —— 368x448 帧缓冲、全套绘图 API、离屏画布、帧动画、GIF
 *
 * 实现要点:
 * - 沙箱内用隐藏 <canvas> 作为帧缓冲,全部绘制同步完成;
 *   flush() 把 RGBA 帧零拷贝(transfer)推给宿主的可见画布(整数倍缩放 + pixelated)。
 * - onFrame 的节拍由宿主 rAF 驱动('tick' 事件,已按 setFps 节流),
 *   dt 为沙箱内实测毫秒;回调返回后自动 flush(与真机行为一致)。
 * - 直线/圆用 Bresenham/中点算法逐像素绘制,保证像素风格(无抗锯齿)。
 * - drawText 使用打包进 bundle 的缝合像素字体(见 fonts.ts)。
 */
import type { HostLink } from './rpc'
import { Emitter } from './events'
import { colorToCss, clamp } from './util'
import { resolveFont, type PxFontName } from './fonts'
import { decodeImageBytes, decodeGifFrames, withColorKey, type DecodedImage } from './images'
import type { Vfs } from './storage'

export const SCREEN_W = 368
export const SCREEN_H = 448

interface TextStyle {
  color?: number
  font?: PxFontName
  scale?: number
  align?: 'left' | 'center' | 'right'
}

interface DrawImageOpts {
  w?: number
  h?: number
  sx?: number
  sy?: number
  sw?: number
  sh?: number
  colorKey?: number
}

type BinaryLike = ArrayBuffer | Uint8Array

/** 图片源解析上下文(路径经 vfs 读取) */
export interface ImageResolver {
  resolve(src: BinaryLike | string | DrawSurface, colorKey?: number): {
    source: CanvasImageSource
    width: number
    height: number
  }
  decode(src: BinaryLike | string): DecodedImage
  /** 读取原始字节(路径经 /app/assets 便捷解析),loadGif 用 */
  readBytes(src: string): ArrayBuffer
}

export function createImageResolver(vfs: Vfs): ImageResolver {
  const pathCache = new Map<string, DecodedImage>()
  const binCache = new WeakMap<object, DecodedImage>()

  function decode(src: BinaryLike | string): DecodedImage {
    if (typeof src === 'string') {
      const p = src.startsWith('/') ? src : '/app/assets/' + src
      const hit = pathCache.get(p)
      if (hit) return hit
      const img = decodeImageBytes(vfs.readBytes(p))
      pathCache.set(p, img)
      return img
    }
    const key = src as object
    const hit = binCache.get(key)
    if (hit) return hit
    const img = decodeImageBytes(src)
    binCache.set(key, img)
    return img
  }

  function resolve(
    src: BinaryLike | string | DrawSurface,
    colorKey?: number
  ): { source: CanvasImageSource; width: number; height: number } {
    if (src instanceof DrawSurface) {
      if (colorKey === undefined) {
        return { source: src.canvasEl, width: src.width, height: src.height }
      }
      // 画布源 + colorKey:动态生成透明化副本(不缓存,画布内容可能变化)
      const tmp: DecodedImage = {
        width: src.width,
        height: src.height,
        canvas: src.canvasEl,
        keyed: new Map()
      }
      return { source: withColorKey(tmp, colorKey), width: src.width, height: src.height }
    }
    const img = decode(src)
    const source = colorKey === undefined ? img.canvas : withColorKey(img, colorKey)
    return { source, width: img.width, height: img.height }
  }

  function readBytes(src: string): ArrayBuffer {
    const p = src.startsWith('/') ? src : '/app/assets/' + src
    return vfs.readBytes(p)
  }

  return { resolve, decode, readBytes }
}

// ---------------------------------------------------------------
// 绘图目标基类(主屏与离屏画布共用)
// ---------------------------------------------------------------

export class DrawSurface {
  readonly canvasEl: HTMLCanvasElement
  protected ctx: CanvasRenderingContext2D
  protected resolver: ImageResolver
  private disposed = false

  constructor(w: number, h: number, resolver: ImageResolver) {
    this.canvasEl = document.createElement('canvas')
    this.canvasEl.width = w
    this.canvasEl.height = h
    const ctx = this.canvasEl.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('无法创建 2D 画布上下文')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false
    this.resolver = resolver
    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(0, 0, w, h)
  }

  get width(): number {
    return this.canvasEl.width
  }

  get height(): number {
    return this.canvasEl.height
  }

  protected assertAlive(): void {
    if (this.disposed) throw new Error('画布已释放 (dispose)')
  }

  protected markDirty(): void {
    // 主屏覆写:标记待 flush
  }

  clear(color?: number): void {
    this.assertAlive()
    this.ctx.fillStyle = colorToCss(color ?? 0x000000)
    this.ctx.fillRect(0, 0, this.width, this.height)
    this.markDirty()
  }

  setPixel(x: number, y: number, color: number): void {
    this.assertAlive()
    this.ctx.fillStyle = colorToCss(color)
    this.ctx.fillRect(x | 0, y | 0, 1, 1)
    this.markDirty()
  }

  getPixel(x: number, y: number): number {
    this.assertAlive()
    const d = this.ctx.getImageData(x | 0, y | 0, 1, 1).data
    return ((d[0] << 16) | (d[1] << 8) | d[2]) >>> 0
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, color: number): void {
    this.assertAlive()
    // Bresenham,逐像素,保证无抗锯齿
    let ax = x0 | 0
    let ay = y0 | 0
    const bx = x1 | 0
    const by = y1 | 0
    const dx = Math.abs(bx - ax)
    const dy = -Math.abs(by - ay)
    const sx = ax < bx ? 1 : -1
    const sy = ay < by ? 1 : -1
    let err = dx + dy
    this.ctx.fillStyle = colorToCss(color)
    for (;;) {
      this.ctx.fillRect(ax, ay, 1, 1)
      if (ax === bx && ay === by) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        ax += sx
      }
      if (e2 <= dx) {
        err += dx
        ay += sy
      }
    }
    this.markDirty()
  }

  drawRect(x: number, y: number, w: number, h: number, color: number): void {
    this.assertAlive()
    const xi = x | 0
    const yi = y | 0
    const wi = w | 0
    const hi = h | 0
    if (wi <= 0 || hi <= 0) return
    this.ctx.fillStyle = colorToCss(color)
    this.ctx.fillRect(xi, yi, wi, 1)
    this.ctx.fillRect(xi, yi + hi - 1, wi, 1)
    this.ctx.fillRect(xi, yi, 1, hi)
    this.ctx.fillRect(xi + wi - 1, yi, 1, hi)
    this.markDirty()
  }

  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    this.assertAlive()
    this.ctx.fillStyle = colorToCss(color)
    this.ctx.fillRect(x | 0, y | 0, w | 0, h | 0)
    this.markDirty()
  }

  drawCircle(x: number, y: number, r: number, color: number): void {
    this.assertAlive()
    // 中点画圆
    const cx = x | 0
    const cy = y | 0
    let px = r | 0
    let py = 0
    let err = 1 - px
    this.ctx.fillStyle = colorToCss(color)
    const put = (ox: number, oy: number): void => {
      this.ctx.fillRect(ox, oy, 1, 1)
    }
    while (px >= py) {
      put(cx + px, cy + py)
      put(cx + py, cy + px)
      put(cx - py, cy + px)
      put(cx - px, cy + py)
      put(cx - px, cy - py)
      put(cx - py, cy - px)
      put(cx + py, cy - px)
      put(cx + px, cy - py)
      py++
      if (err < 0) err += 2 * py + 1
      else {
        px--
        err += 2 * (py - px) + 1
      }
    }
    this.markDirty()
  }

  fillCircle(x: number, y: number, r: number, color: number): void {
    this.assertAlive()
    const cx = x | 0
    const cy = y | 0
    const ri = r | 0
    this.ctx.fillStyle = colorToCss(color)
    for (let oy = -ri; oy <= ri; oy++) {
      const span = Math.floor(Math.sqrt(ri * ri - oy * oy))
      this.ctx.fillRect(cx - span, cy + oy, span * 2 + 1, 1)
    }
    this.markDirty()
  }

  drawText(text: string, x: number, y: number, style?: TextStyle): void {
    this.assertAlive()
    const { cssFont } = resolveFont(style?.font, style?.scale)
    this.ctx.font = cssFont
    this.ctx.textBaseline = 'top'
    this.ctx.fillStyle = colorToCss(style?.color ?? 0xffffff)
    let tx = Math.round(x)
    if (style?.align === 'center' || style?.align === 'right') {
      const w = this.ctx.measureText(text).width
      tx = style.align === 'center' ? Math.round(x - w / 2) : Math.round(x - w)
    }
    this.ctx.fillText(text, tx, Math.round(y))
    this.markDirty()
  }

  measureText(text: string, style?: TextStyle): { width: number; height: number } {
    this.assertAlive()
    const { cssFont, lineHeight } = resolveFont(style?.font, style?.scale)
    this.ctx.font = cssFont
    return { width: Math.ceil(this.ctx.measureText(text).width), height: lineHeight }
  }

  drawImage(src: BinaryLike | string | DrawSurface, x: number, y: number, opts?: DrawImageOpts): void {
    this.assertAlive()
    const { source, width, height } = this.resolver.resolve(src, opts?.colorKey)
    const sx = opts?.sx ?? 0
    const sy = opts?.sy ?? 0
    const sw = opts?.sw ?? width - sx
    const sh = opts?.sh ?? height - sy
    const dw = opts?.w ?? sw
    const dh = opts?.h ?? sh
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return
    this.ctx.imageSmoothingEnabled = false // 最近邻缩放,保像素风
    this.ctx.drawImage(source, sx, sy, sw, sh, x | 0, y | 0, dw, dh)
    this.markDirty()
  }

  /** 直接绘制一个画布源(动画帧绘制用,内部 API) */
  blit(source: CanvasImageSource, x: number, y: number): void {
    this.assertAlive()
    this.ctx.imageSmoothingEnabled = false
    this.ctx.drawImage(source, x | 0, y | 0)
    this.markDirty()
  }

  /** 释放(离屏画布用;主屏不调用) */
  disposeSurface(): void {
    this.disposed = true
    this.canvasEl.width = 0
    this.canvasEl.height = 0
  }
}

/** 离屏画布(px.screen.createCanvas) */
export class PxCanvasImpl extends DrawSurface {
  dispose(): void {
    this.disposeSurface()
  }
}

// ---------------------------------------------------------------
// 帧动画(createAnimation / loadGif)
// ---------------------------------------------------------------

interface AnimFrame {
  source: CanvasImageSource
  width: number
  height: number
  /** GIF 单帧时长;普通动画为 undefined(用统一 fps) */
  delayMs?: number
}

export class AnimationImpl {
  private frames: AnimFrame[]
  private fps: number
  private loop: boolean
  private index = 0
  private timer: number | null = null
  private endEmitter = new Emitter<void>()
  private disposed = false
  private screen: ScreenImpl

  constructor(frames: AnimFrame[], fps: number, loop: boolean, screen: ScreenImpl) {
    this.frames = frames
    this.fps = clamp(fps, 1, 60)
    this.loop = loop
    this.screen = screen
  }

  get playing(): boolean {
    return this.timer !== null
  }

  get frameCount(): number {
    return this.frames.length
  }

  get currentFrame(): number {
    return this.index
  }

  private scheduleNext(): void {
    if (this.disposed) return
    const cur = this.frames[this.index]
    const delay = cur?.delayMs ?? 1000 / this.fps
    this.timer = window.setTimeout(() => {
      if (this.index + 1 >= this.frames.length) {
        if (this.loop) {
          this.index = 0
          this.scheduleNext()
        } else {
          this.timer = null
          this.endEmitter.emit()
        }
      } else {
        this.index++
        this.scheduleNext()
      }
    }, delay)
  }

  play(): void {
    if (this.disposed || this.timer !== null || this.frames.length === 0) return
    this.scheduleNext()
  }

  pause(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  stop(): void {
    this.pause()
    this.index = 0
  }

  seek(frame: number): void {
    this.index = clamp(frame | 0, 0, Math.max(0, this.frames.length - 1))
  }

  draw(x: number, y: number, target?: unknown): void {
    if (this.disposed || this.frames.length === 0) return
    const fr = this.frames[this.index]
    const surface = target instanceof DrawSurface ? target : this.screen
    surface.blit(fr.source, x, y)
  }

  onEnd(cb: () => void): () => void {
    return this.endEmitter.on(cb)
  }

  dispose(): void {
    this.pause()
    this.disposed = true
    this.frames = []
  }
}

// ---------------------------------------------------------------
// 主屏
// ---------------------------------------------------------------

export class ScreenImpl extends DrawSurface {
  private link: HostLink
  private frameSubs = new Emitter<number>()
  private lastTickAt = 0
  private brightness: number

  constructor(link: HostLink, resolver: ImageResolver, brightness: number) {
    super(SCREEN_W, SCREEN_H, resolver)
    this.link = link
    this.brightness = clamp(brightness, 0, 100)
  }

  // ---- 帧提交 ----

  flush(): void {
    const im = this.ctx.getImageData(0, 0, SCREEN_W, SCREEN_H)
    const buf = im.data.buffer
    this.link.emit('frame', { buf, width: SCREEN_W, height: SCREEN_H }, [buf])
  }

  /** 宿主 tick 到来(已按 setFps 节流) */
  handleTick(): void {
    const now = performance.now()
    const dt = this.lastTickAt === 0 ? 1000 / 30 : now - this.lastTickAt
    this.lastTickAt = now
    if (this.frameSubs.size === 0) return
    this.frameSubs.emit(dt)
    // 回调返回后自动提交
    this.flush()
  }

  onFrame(cb: (dt: number) => void): () => void {
    return this.frameSubs.on(cb)
  }

  setFps(fps: number): void {
    this.link.emit('set-fps', { fps: clamp(fps | 0, 1, 60) })
  }

  // ---- 屏幕控制 ----

  setBrightness(percent: number): void {
    this.brightness = clamp(percent, 0, 100)
    this.link.emit('screen-ctl', { brightness: this.brightness })
  }

  getBrightness(): number {
    return this.brightness
  }

  setPower(on: boolean): void {
    this.link.emit('screen-ctl', { power: !!on })
  }

  setRotation(deg: 0 | 90 | 180 | 270): void {
    if (deg !== 0 && deg !== 90 && deg !== 180 && deg !== 270) {
      throw new Error('rotation 仅支持 0/90/180/270')
    }
    this.link.emit('screen-ctl', { rotation: deg })
  }

  // ---- 工厂 ----

  createCanvas(w: number, h: number): PxCanvasImpl {
    const wi = Math.max(1, w | 0)
    const hi = Math.max(1, h | 0)
    return new PxCanvasImpl(wi, hi, this.resolver)
  }

  createAnimation(opts: {
    frames:
      | Array<string | BinaryLike | DrawSurface>
      | { sheet: string | BinaryLike; frameW: number; frameH: number }
    fps?: number
    loop?: boolean
  }): AnimationImpl {
    const fps = opts.fps ?? 12
    const loop = opts.loop ?? true
    const frames: AnimFrame[] = []
    if (Array.isArray(opts.frames)) {
      for (const f of opts.frames) {
        const r = this.resolver.resolve(f)
        frames.push({ source: r.source, width: r.width, height: r.height })
      }
    } else {
      // 雪碧图:从左到右、从上到下切帧
      const { sheet, frameW, frameH } = opts.frames
      const img = this.resolver.decode(sheet)
      const cols = Math.floor(img.width / frameW)
      const rows = Math.floor(img.height / frameH)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cvs = document.createElement('canvas')
          cvs.width = frameW
          cvs.height = frameH
          const cctx = cvs.getContext('2d')
          if (!cctx) continue
          cctx.imageSmoothingEnabled = false
          cctx.drawImage(img.canvas, c * frameW, r * frameH, frameW, frameH, 0, 0, frameW, frameH)
          frames.push({ source: cvs, width: frameW, height: frameH })
        }
      }
    }
    if (frames.length === 0) throw new Error('createAnimation: 帧列表为空')
    return new AnimationImpl(frames, fps, loop, this)
  }

  loadGif(src: string | BinaryLike): AnimationImpl {
    const raw: ArrayBuffer | Uint8Array = typeof src === 'string' ? this.resolver.readBytes(src) : src
    const gif = decodeGifFrames(raw)
    if (gif.frames.length === 0) throw new Error('loadGif: GIF 无有效帧')
    const frames: AnimFrame[] = gif.frames.map((f) => ({
      source: f.image.canvas,
      width: f.image.width,
      height: f.image.height,
      delayMs: f.delayMs
    }))
    return new AnimationImpl(frames, 10, true, this)
  }
}
