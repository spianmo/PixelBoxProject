/**
 * 本机等宽字体探测 —— canvas 测宽法逐一探测常见等宽字体候选
 *
 * 不用 queryLocalFonts(需 local-fonts 权限 + 用户激活手势,且无法按等宽过滤);
 * document.fonts.check 也不可靠(Chromium 对未安装字体族回退系统字体即报「可用」,
 * 全量假阳性,实测验证)。canvas 测宽法:候选字体分别以 serif / monospace 兜底
 * 各量一次样本串宽度,未安装时回退兜底字体 → 两次都与基线等宽 → 排除;
 * 任一宽度不同即字体存在。同步、零权限,结果供字体输入框 datalist 建议,
 * 清单外的字体用户仍可手动输入(缺字时 xterm/Monaco 回退链兜底)。
 * JetBrains Mono 为内置 @fontsource 字体,恒排建议首位(不参与探测)。
 */

/** 常见等宽字体候选(macOS / Windows / Linux 系统字体 + 流行编程字体 + 中文等宽) */
const MONO_FONT_CANDIDATES = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'Cascadia Code',
  'Cascadia Mono',
  'Courier New',
  'PT Mono',
  'Andale Mono',
  'Lucida Console',
  'Fira Code',
  'Fira Mono',
  'Source Code Pro',
  'IBM Plex Mono',
  'Hack',
  'Inconsolata',
  'Iosevka',
  'Victor Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Space Mono',
  'Geist Mono',
  'Monaspace Neon',
  'Noto Sans Mono',
  'Maple Mono',
  'Sarasa Mono SC',
  'LXGW WenKai Mono',
  'Noto Sans Mono CJK SC'
] as const

/** 宽窄字符混合样本(区分度高;含 CJK 探中文等宽) */
const SAMPLE = 'mmmMMMwwwililII1100@#%&WQ_-=终端字体'

/** 探测本机可用的等宽字体(JetBrains Mono 恒在首位;canvas 不可用时仅内置项) */
export function detectMonoFonts(): string[] {
  const out: string[] = ['JetBrains Mono']
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return out
    const widthWith = (font: string): number => {
      ctx.font = `16px ${font}`
      return ctx.measureText(SAMPLE).width
    }
    const baseSerif = widthWith('serif')
    const baseMono = widthWith('monospace')
    for (const family of MONO_FONT_CANDIDATES) {
      const quoted = `"${family}"`
      if (widthWith(`${quoted}, serif`) !== baseSerif || widthWith(`${quoted}, monospace`) !== baseMono) {
        out.push(family)
      }
    }
  } catch {
    // canvas 不可用:收束到内置项
  }
  return out
}
