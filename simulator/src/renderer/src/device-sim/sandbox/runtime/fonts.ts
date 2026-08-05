/**
 * 像素字体加载与 PxTextStyle → canvas font 映射
 *
 * 使用开源像素字体「缝合像素字体 / Fusion Pixel Font」(TakWolf/fusion-pixel-font),
 * 简体中文子集,SIL Open Font License 1.1 授权(见 ../fonts/OFL.txt)。
 * woff2 经 esbuild base64 loader 打进 runtime bundle,在沙箱内以 FontFace(ArrayBuffer) 注册,
 * 不依赖任何网络/文件加载(沙箱 opaque origin 无法 fetch 宿主资源)。
 *
 * 字体映射(与 d.ts 的 'pixel8' | 'pixel12' | 'pixel16' 对齐):
 *   pixel8  → Fusion Pixel 8px  @ 8px (ASCII + 常用中文)
 *   pixel12 → Fusion Pixel 12px @ 12px(含常用中文)
 *   pixel16 → Fusion Pixel 8px  @ 16px(8px 字形 2 倍整数放大,保持像素锐利)
 */
import { b64decode } from './util'
import font8B64 from '../fonts/fusion-pixel-8px-proportional-zh_hans.otf.woff2'
import font12B64 from '../fonts/fusion-pixel-12px-proportional-zh_hans.otf.woff2'

const FAMILY_8 = 'FusionPixel8'
const FAMILY_12 = 'FusionPixel12'

export type PxFontName = 'pixel8' | 'pixel12' | 'pixel16'

interface FontSpec {
  family: string
  /** 基准字号(px),整数倍缩放的单位 */
  size: number
}

const FONT_MAP: Record<PxFontName, FontSpec> = {
  pixel8: { family: FAMILY_8, size: 8 },
  pixel12: { family: FAMILY_12, size: 12 },
  pixel16: { family: FAMILY_8, size: 16 }
}

let installed = false

/** 注册字体(load() 前调用一次;失败时降级 monospace 并告警) */
export async function installFonts(warn: (msg: string) => void): Promise<void> {
  if (installed) return
  installed = true
  const jobs: Array<Promise<void>> = []
  const defs: Array<[string, string]> = [
    [FAMILY_8, font8B64],
    [FAMILY_12, font12B64]
  ]
  for (const [family, b64] of defs) {
    jobs.push(
      (async () => {
        try {
          const face = new FontFace(family, b64decode(b64))
          await face.load()
          document.fonts.add(face)
        } catch (err) {
          warn(`像素字体 ${family} 加载失败,drawText 将回退 monospace: ${String(err)}`)
        }
      })()
    )
  }
  await Promise.all(jobs)
}

/** PxTextStyle → { cssFont, lineHeight } */
export function resolveFont(
  font: PxFontName | undefined,
  scale: number | undefined
): { cssFont: string; lineHeight: number } {
  const spec = FONT_MAP[font ?? 'pixel12'] ?? FONT_MAP.pixel12
  const s = Math.max(1, Math.floor(scale ?? 1))
  const size = spec.size * s
  return { cssFont: `${size}px "${spec.family}", monospace`, lineHeight: size }
}
