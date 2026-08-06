/**
 * 极简 ANSI SGR 解析(构建输出着色:idf.py / esbuild 等)
 * 支持:0 重置 / 1 加粗 / 30-37 前景 / 90-97 亮前景;其余转义序列剥离
 */

export interface AnsiSpan {
  text: string
  /** CSS color(未设置沿用默认) */
  color?: string
  bold?: boolean
}

/**
 * 30-37 标准色 —— 经 CSS 变量承载(--pb-ansi-*,深浅两组值见 assets/main.css):
 * span 以 style.color 内联消费 var(),主题切换零 JS 重算即时跟随
 */
const FG: Record<number, string> = {
  30: 'var(--pb-ansi-30)',
  31: 'var(--pb-ansi-31)', // red
  32: 'var(--pb-ansi-32)', // green
  33: 'var(--pb-ansi-33)', // yellow
  34: 'var(--pb-ansi-34)', // blue
  35: 'var(--pb-ansi-35)', // magenta
  36: 'var(--pb-ansi-36)', // cyan
  37: 'var(--pb-ansi-37)'
}

/** 90-97 亮色(同上,变量承载) */
const FG_BRIGHT: Record<number, string> = {
  90: 'var(--pb-ansi-90)',
  91: 'var(--pb-ansi-91)',
  92: 'var(--pb-ansi-92)',
  93: 'var(--pb-ansi-93)',
  94: 'var(--pb-ansi-94)',
  95: 'var(--pb-ansi-95)',
  96: 'var(--pb-ansi-96)',
  97: 'var(--pb-ansi-97)'
}

// eslint 无此工程:控制字符正则为 ANSI 解析刻意使用
// \x1b[ ... 终止字节 0x40-0x7E;非 SGR(m 结尾)的序列一律剥离
const ANSI_RE = /\x1b\[([0-9;]*)([\x40-\x7e])/g

/** 把带 ANSI 转义的一行拆为着色片段 */
export function parseAnsiLine(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let color: string | undefined
  let bold = false
  let lastIndex = 0

  const push = (text: string): void => {
    if (text.length === 0) return
    spans.push({ text, color, bold })
  }

  ANSI_RE.lastIndex = 0
  for (let m = ANSI_RE.exec(input); m; m = ANSI_RE.exec(input)) {
    push(input.slice(lastIndex, m.index))
    lastIndex = m.index + m[0].length
    if (m[2] !== 'm') continue // 非 SGR 序列:仅剥离
    const codes = m[1].length === 0 ? [0] : m[1].split(';').map((s) => Number(s))
    for (const c of codes) {
      if (c === 0) {
        color = undefined
        bold = false
      } else if (c === 1) {
        bold = true
      } else if (c === 22) {
        bold = false
      } else if (c === 39) {
        color = undefined
      } else if (FG[c]) {
        color = FG[c]
      } else if (FG_BRIGHT[c]) {
        color = FG_BRIGHT[c]
      }
      // 背景色(40-47/100-107)与其余属性忽略
    }
  }
  push(input.slice(lastIndex))
  return spans.length > 0 ? spans : [{ text: input }]
}
