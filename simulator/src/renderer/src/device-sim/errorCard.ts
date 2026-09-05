/**
 * errorCard —— 应用异常提示的 canvas 2D 渲染(与固件 errscreen 同款)
 *
 * 真机侧是 firmware/components/errscreen/src/error_card.cpp(纯 gfx 绘制)。
 * 这里是它的 canvas 2D 对照实现:配色、文案、留白、折行/截断规则逐条对齐,
 * 目的是模拟器上看到的报错画面与设备屏幕上的一致。
 *
 * 字体沿用沙箱那套 Fusion Pixel 像素字体,但沙箱是在 iframe 文档里注册的
 * (FontFace 不跨文档),故这里要在外壳文档再注册一次;注册失败退回 monospace,
 * 只影响字形不影响布局判断。
 *
 * 与固件的字号对照(见 sandbox/runtime/fonts.ts 的 FONT_MAP):
 *   pixel12 → 12px FusionPixel12   pixel16 → 16px FusionPixel8
 */
import font8Asset from './sandbox/fonts/fusion-pixel-8px-proportional-zh_hans.otf.woff2'
import font12Asset from './sandbox/fonts/fusion-pixel-12px-proportional-zh_hans.otf.woff2'

/* 配色:与 error_card.cpp 的常量逐一对应 */
const C_BG = '#1a0e10' // 卡片底
const C_HEAD = '#9b1c1c' // 顶部标题条 / 横幅底
const C_BORDER = '#ff5a5a' // 描边
const C_TITLE = '#ffffff' // 标题字
const C_SUB = '#e0b4b4' // 应用名/版本
const C_MSG = '#ff9a9a' // 错误摘要
const C_STACK = '#a88f92' // 堆栈
const C_FOOT_BG = '#2a1416' // 底部提示条
const C_FOOT = '#c8a8a8' // 底部提示字
const C_DIVIDER = '#5a2b2b'
const C_BANNER_MSG = '#ffd8d8'

/** 卡片内容(对应 error_card.hpp 的 CardInfo) */
export interface ErrorCardInfo {
  app?: string | null
  version?: string | null
  /** 首行 = 摘要,其余行 = 堆栈 */
  message: string
  /** 底部提示;省略时用默认文案 */
  hint?: string | null
  /** 同一错误的累计次数,>1 时标题带 ×N */
  repeat?: number
}

const DEFAULT_HINT = '工具栏「重新加载」重启应用'

/* ------------------------------------------------------------
 * 字体
 * ------------------------------------------------------------ */

const FAMILY_8 = 'FusionPixel8'
const FAMILY_12 = 'FusionPixel12'

let fontsPromise: Promise<void> | null = null

/**
 * 在外壳文档注册像素字体(幂等)。引擎构造时先行调用,
 * 等真出错要画卡片时字体已就位。失败静默退回 monospace。
 */
export function ensureErrorCardFonts(): Promise<void> {
  if (fontsPromise) return fontsPromise
  fontsPromise = (async () => {
    const defs: Array<[string, string]> = [
      [FAMILY_8, font8Asset],
      [FAMILY_12, font12Asset]
    ]
    await Promise.all(
      defs.map(async ([family, asset]) => {
        try {
          const face = new FontFace(family, `url(${asset})`)
          await face.load()
          document.fonts.add(face)
        } catch {
          /* 退回 monospace:字形不同但布局照样成立 */
        }
      })
    )
  })()
  return fontsPromise
}

/** 逻辑短边 ≥442 时整体放大一档(与固件 ui_scale 同口径) */
function uiScale(w: number, h: number): number {
  return Math.min(w, h) >= 442 ? 2 : 1
}

function font12(scale: number): { css: string; lh: number } {
  return { css: `${12 * scale}px "${FAMILY_12}", monospace`, lh: 12 * scale }
}

function font16(scale: number): { css: string; lh: number } {
  return { css: `${16 * scale}px "${FAMILY_8}", monospace`, lh: 16 * scale }
}

/* ------------------------------------------------------------
 * 文本排版(与 error_card.cpp 的 fit_text / wrap_text / split_message 同规则)
 * ------------------------------------------------------------ */

function textWidth(ctx: CanvasRenderingContext2D, s: string, css: string): number {
  ctx.font = css
  return ctx.measureText(s).width
}

/** 按像素宽度截断,超出补 "…"(单行用,堆栈行走这条) */
function fitText(ctx: CanvasRenderingContext2D, input: string, css: string, maxW: number): string {
  if (!input || textWidth(ctx, input, css) <= maxW) return input
  const cps = Array.from(input) // 按码点切,避免劈开代理对
  for (let i = cps.length; i > 0; i--) {
    const cand = cps.slice(0, i - 1).join('') + '…'
    if (textWidth(ctx, cand, css) <= maxW) return cand
  }
  return '…'
}

/**
 * 贪心折行:优先在空格处断开,无空格(纯中文/长路径)按码点硬断;
 * 行数封顶 maxLines,被砍掉的部分在末行补 "…"。
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  input: string,
  css: string,
  maxW: number,
  maxLines: number
): string[] {
  const out: string[] = []
  if (!input || maxW <= 0 || maxLines <= 0) return out

  const cps = Array.from(input)
  let start = 0 // 当前行起始码点下标
  let lastSpace = 0 // 行内最后一个空格之后的下标(0 = 无)
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] === ' ') lastSpace = i + 1
    if (textWidth(ctx, cps.slice(start, i + 1).join(''), css) <= maxW) continue

    let cut = i > start ? i : i + 1 // 至少留一个码点,避免死循环
    if (lastSpace > start && lastSpace > start + (cut - start) / 3) cut = lastSpace
    out.push(cps.slice(start, cut).join(''))
    start = cut
    lastSpace = 0
    if (out.length >= maxLines) break
  }
  if (start < cps.length && out.length < maxLines) {
    out.push(cps.slice(start).join(''))
    start = cps.length
  }
  if (start < cps.length && out.length > 0) {
    out[out.length - 1] = fitText(ctx, out[out.length - 1] + '…', css, maxW)
  }
  return out
}

/** message 首行 = 摘要,其余 = 堆栈(逐行 trim,丢空行) */
function splitMessage(message: string): { summary: string; stack: string[] } {
  const stack: string[] = []
  let summary = ''
  for (const raw of (message ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (!summary) summary = line
    else stack.push(line)
  }
  return { summary: summary || '未知错误', stack }
}

function appLine(info: ErrorCardInfo): string {
  let s = info.app && info.app.length > 0 ? info.app : '未知应用'
  if (info.version && info.version.length > 0) s += ` v${info.version}`
  return s
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  css: string,
  color: string,
  align: 'left' | 'center' = 'left'
): void {
  ctx.font = css
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  const tx = align === 'center' ? Math.round(x - ctx.measureText(text).width / 2) : Math.round(x)
  ctx.fillText(text, tx, Math.round(y))
}

/* ------------------------------------------------------------
 * 对外:两种形态
 * ------------------------------------------------------------ */

/** 顶部横幅高度(与固件 banner_height 同式) */
export function bannerHeight(w: number, h: number): number {
  const s = uiScale(w, h)
  return 12 * s * 2 + 10 * s + 2
}

/** 全屏错误卡片(致命:应用已停止) */
export function paintFatalCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  info: ErrorCardInfo
): void {
  if (w <= 0 || h <= 0) return
  const s = uiScale(w, h)
  const pad = 8 * s
  const maxW = w - pad * 2

  const title = font16(s * 2)
  const sub = font12(s)
  const msg = font16(s)
  const stk = font12(s)

  const headH = title.lh + 10 * s
  const footH = sub.lh + 10 * s

  ctx.save()
  /* ---- 底:卡片 + 顶部标题条 + 底部提示条 + 描边 ---- */
  ctx.fillStyle = C_BG
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = C_HEAD
  ctx.fillRect(0, 0, w, headH)
  ctx.fillStyle = C_FOOT_BG
  ctx.fillRect(0, h - footH, w, footH)
  ctx.strokeStyle = C_BORDER
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3)

  let head = '应用异常'
  if ((info.repeat ?? 1) > 1) head += ` ×${info.repeat}`
  drawText(ctx, head, w / 2, 5 * s, title.css, C_TITLE, 'center')

  let y = headH + 6 * s
  drawText(ctx, fitText(ctx, appLine(info), sub.css, maxW), w / 2, y, sub.css, C_SUB, 'center')
  y += sub.lh + 6 * s
  ctx.fillStyle = C_DIVIDER
  ctx.fillRect(pad, y, maxW, 1)
  y += 6 * s

  /* ---- 摘要(折行,最多 5 行)---- */
  const { summary, stack } = splitMessage(info.message)
  for (const line of wrapText(ctx, summary, msg.css, maxW, 5)) {
    drawText(ctx, line, pad, y, msg.css, C_MSG)
    y += msg.lh + 2 * s
  }
  y += 4 * s

  /* ---- 堆栈(逐行截断,填到提示条上方为止)---- */
  const stackBottom = h - footH - 4 * s
  for (const line of stack) {
    if (y + stk.lh > stackBottom) {
      drawText(ctx, '…', pad, y, stk.css, C_STACK)
      break
    }
    drawText(ctx, fitText(ctx, line, stk.css, maxW), pad, y, stk.css, C_STACK)
    y += stk.lh + 1 * s
  }

  const hint = info.hint && info.hint.length > 0 ? info.hint : DEFAULT_HINT
  drawText(ctx, hint, w / 2, h - footH + 5 * s, sub.css, C_FOOT, 'center')
  ctx.restore()
}

/** 顶部横幅(非致命:应用仍在跑,叠在当前帧上) */
export function paintBanner(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  info: ErrorCardInfo
): void {
  if (w <= 0 || h <= 0) return
  const s = uiScale(w, h)
  const bh = bannerHeight(w, h)
  const pad = 6 * s
  const maxW = w - pad * 2
  const f = font12(s)

  ctx.save()
  ctx.fillStyle = C_HEAD
  ctx.fillRect(0, 0, w, bh)
  ctx.fillStyle = C_BORDER
  ctx.fillRect(0, bh - 2, w, 2)

  let title = '应用异常'
  if ((info.repeat ?? 1) > 1) title += ` ×${info.repeat}`
  title += '  (5 秒后自动隐藏)'

  const { summary } = splitMessage(info.message)
  let y = 4 * s
  drawText(ctx, fitText(ctx, title, f.css, maxW), pad, y, f.css, C_TITLE)
  y += f.lh + 2 * s
  drawText(ctx, fitText(ctx, summary, f.css, maxW), pad, y, f.css, C_BANNER_MSG)
  ctx.restore()
}
