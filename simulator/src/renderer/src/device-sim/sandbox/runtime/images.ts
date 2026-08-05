/**
 * 图片解码(沙箱内同步解码,契约 drawImage 为同步 API)
 * - PNG:fast-png(纯 JS)
 * - JPEG:jpeg-js(纯 JS)
 * - GIF:gifuct-js(loadGif 用,含逐帧合成)
 *
 * 解码结果缓存为 <canvas>,colorKey 变体按颜色二次缓存。
 */
import { decode as decodePng } from 'fast-png'
import { decode as decodeJpeg } from 'jpeg-js'
import { parseGIF, decompressFrames } from 'gifuct-js'
import { toU8 } from './util'

/** 解码后的位图:canvas 供 drawImage,rgba 供 colorKey 处理 */
export interface DecodedImage {
  width: number
  height: number
  canvas: HTMLCanvasElement
  /** colorKey 变体缓存(颜色 → 透明化后的 canvas) */
  keyed: Map<number, HTMLCanvasElement>
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 2D 画布上下文')
  ctx.imageSmoothingEnabled = false
  return { canvas, ctx }
}

function fromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): DecodedImage {
  const { canvas, ctx } = makeCanvas(w, h)
  // 拷贝到独立缓冲(规避 ArrayBufferLike 泛型不匹配 ImageData 的问题)
  const data = new Uint8ClampedArray(w * h * 4)
  data.set(rgba.subarray(0, data.length))
  ctx.putImageData(new ImageData(data, w, h), 0, 0)
  return { width: w, height: h, canvas, keyed: new Map() }
}

/** 灰度/RGB → RGBA 归一化 */
function normalizeChannels(
  data: Uint8Array | Uint16Array | Uint8ClampedArray,
  channels: number,
  w: number,
  h: number
): Uint8ClampedArray {
  const px = w * h
  const out = new Uint8ClampedArray(px * 4)
  // 16 位深度压到 8 位
  const to8 = (v: number): number => (data instanceof Uint16Array ? v >> 8 : v)
  for (let i = 0; i < px; i++) {
    const s = i * channels
    if (channels === 1) {
      const g = to8(data[s])
      out[i * 4] = g
      out[i * 4 + 1] = g
      out[i * 4 + 2] = g
      out[i * 4 + 3] = 255
    } else if (channels === 2) {
      const g = to8(data[s])
      out[i * 4] = g
      out[i * 4 + 1] = g
      out[i * 4 + 2] = g
      out[i * 4 + 3] = to8(data[s + 1])
    } else if (channels === 3) {
      out[i * 4] = to8(data[s])
      out[i * 4 + 1] = to8(data[s + 1])
      out[i * 4 + 2] = to8(data[s + 2])
      out[i * 4 + 3] = 255
    } else {
      out[i * 4] = to8(data[s])
      out[i * 4 + 1] = to8(data[s + 1])
      out[i * 4 + 2] = to8(data[s + 2])
      out[i * 4 + 3] = to8(data[s + 3])
    }
  }
  return out
}

/** 按魔数同步解码 PNG/JPEG 二进制 */
export function decodeImageBytes(bytes: ArrayBuffer | Uint8Array): DecodedImage {
  const u8 = toU8(bytes)
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    const png = decodePng(u8)
    const rgba = normalizeChannels(
      png.data,
      png.channels,
      png.width,
      png.height
    )
    return fromRgba(rgba, png.width, png.height)
  }
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8) {
    const jpg = decodeJpeg(u8, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 })
    return fromRgba(new Uint8ClampedArray(jpg.data.buffer, jpg.data.byteOffset, jpg.data.byteLength), jpg.width, jpg.height)
  }
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
    // GIF:取第一帧作为静态图(动画请用 loadGif)
    const frames = decodeGifFrames(u8)
    if (frames.frames.length > 0) {
      return frames.frames[0].image
    }
    throw new Error('GIF 无有效帧')
  }
  throw new Error('无法识别的图片格式(仅支持 PNG/JPEG/GIF)')
}

/** colorKey 变体:指定颜色的像素透明化(结果缓存) */
export function withColorKey(img: DecodedImage, colorKey: number): HTMLCanvasElement {
  const key = colorKey & 0xffffff
  const cached = img.keyed.get(key)
  if (cached) return cached
  const { canvas, ctx } = makeCanvas(img.width, img.height)
  ctx.drawImage(img.canvas, 0, 0)
  const im = ctx.getImageData(0, 0, img.width, img.height)
  const d = im.data
  const kr = (key >> 16) & 0xff
  const kg = (key >> 8) & 0xff
  const kb = key & 0xff
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === kr && d[i + 1] === kg && d[i + 2] === kb) d[i + 3] = 0
  }
  ctx.putImageData(im, 0, 0)
  img.keyed.set(key, canvas)
  return canvas
}

// ---------------------------------------------------------------
// GIF 逐帧解码 + 合成(处理 disposal)
// ---------------------------------------------------------------

export interface GifFrame {
  image: DecodedImage
  /** 帧延迟毫秒 */
  delayMs: number
}

export interface DecodedGif {
  width: number
  height: number
  frames: GifFrame[]
}

export function decodeGifFrames(bytes: ArrayBuffer | Uint8Array): DecodedGif {
  const u8 = toU8(bytes)
  // parseGIF 需要 ArrayBuffer;拷贝一份保证偏移干净
  const gif = parseGIF(u8.slice().buffer)
  const raw = decompressFrames(gif, true)
  if (raw.length === 0) return { width: 0, height: 0, frames: [] }
  const W = gif.lsd.width
  const H = gif.lsd.height

  // 逐帧合成画布(disposal=2 恢复背景/透明,其余保留上一帧)
  const { canvas: compose, ctx: composeCtx } = makeCanvas(W, H)
  const frames: GifFrame[] = []
  for (const fr of raw) {
    const dims = fr.dims
    // patch 为该帧局部 RGBA
    const patch = new ImageData(new Uint8ClampedArray(fr.patch), dims.width, dims.height)
    const { canvas: patchCanvas, ctx: patchCtx } = makeCanvas(dims.width, dims.height)
    patchCtx.putImageData(patch, 0, 0)

    // disposal 处理:先保存需要恢复的区域
    const disposal = fr.disposalType
    let restore: ImageData | null = null
    if (disposal === 3) {
      restore = composeCtx.getImageData(0, 0, W, H)
    }
    composeCtx.drawImage(patchCanvas, dims.left, dims.top)

    // 快照当前合成结果为一帧
    const { canvas: snap, ctx: snapCtx } = makeCanvas(W, H)
    snapCtx.drawImage(compose, 0, 0)
    frames.push({
      image: { width: W, height: H, canvas: snap, keyed: new Map() },
      delayMs: Math.max(20, fr.delay || 100)
    })

    if (disposal === 2) {
      composeCtx.clearRect(dims.left, dims.top, dims.width, dims.height)
    } else if (disposal === 3 && restore) {
      composeCtx.putImageData(restore, 0, 0)
    }
  }
  return { width: W, height: H, frames }
}
