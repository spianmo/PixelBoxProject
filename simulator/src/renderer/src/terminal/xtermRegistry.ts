/**
 * xterm 实例注册表 —— 终端渲染层的常驻宿主(React 组件卸载不销毁)
 *
 * 每个会话持有一个脱离 React 的 holder div,xterm 打开在其中;
 * TermPane 挂载时把 holder 接入布局、卸载时摘下,工具窗隐藏/底部区切换
 * (日志 ⇄ 终端)期间实例与滚回缓冲全程保留。
 *
 * 主题:深浅两套 ANSI 16 色成对定义(dark = JetBrains Dark 近似,背景对齐编辑器
 * #1E1F22;light = IntelliJ Light 近似,背景纯白),subscribeTheme 对全部已开
 * 会话热切 options.theme(含滚回缓冲即时重绘,无需重开会话);
 * 字体族/字号/行高走 IDE 设置(工具 › 终端;settings:changed 对全部已开会话
 * 即时生效):设置的字体排回退链首位,缺字时按 JetBrains Mono 优先的等宽链
 * 兜底(与 tailwind fontFamily.mono 一致)。
 *
 * 渲染器:WebGL + customGlyphs(对齐 JetBrains 终端的自绘策略)——制表符
 * U+2500-257F / 方块与渐变 U+2580-259F / Powerline 三角 U+E0B0-E0B7 按单元格
 * 几何自绘,框线连续、半块无缝、p10k 箭头无需 Nerd Font;DOM 渲染器把这些
 * 字符当字形交给字体,会出现框线断裂/方块横纹/箭头缺字。WebGL 不可用或
 * 上下文丢失(远程桌面/驱动黑名单/超上下文数上限)时回退 DOM 渲染器。
 */
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSessionInfo } from '../../../shared/ipc-types'
import { getAppSettings, subscribeSettings } from '../settings/store'
import { getEffectiveTheme, subscribeTheme } from '../theme'

/** JetBrains Dark(Darcula console 系)近似 ANSI 色板;背景/前景对齐 IDE 色板 */
const JETBRAINS_DARK_THEME: ITheme = {
  background: '#1E1F22',
  foreground: '#DFE1E5',
  cursor: '#DFE1E5',
  cursorAccent: '#1E1F22',
  selectionBackground: '#2E436E',
  black: '#000000',
  red: '#F75464',
  green: '#5F9C4E',
  yellow: '#D6BF55',
  blue: '#548AF7',
  magenta: '#B189F5',
  cyan: '#299999',
  white: '#BBBBBB',
  brightBlack: '#5A5D63',
  brightRed: '#FA7B82',
  brightGreen: '#73BD79',
  brightYellow: '#F2C55C',
  brightBlue: '#6C9DFF',
  brightMagenta: '#D0A8FF',
  brightCyan: '#3EB8B8',
  brightWhite: '#FEFEFE'
}

/** IntelliJ Light 近似 ANSI 色板(白底终端惯例:普通档加深保对比,亮档略饱和) */
const INTELLIJ_LIGHT_THEME: ITheme = {
  background: '#FFFFFF',
  foreground: '#27282E',
  cursor: '#27282E',
  cursorAccent: '#FFFFFF',
  selectionBackground: '#D4E2FF',
  black: '#000000',
  red: '#C22B35',
  green: '#1F7536',
  yellow: '#A8730A',
  blue: '#2E62CC',
  magenta: '#8F5BB8',
  cyan: '#0E7C86',
  white: '#8E9299',
  brightBlack: '#6C707E',
  brightRed: '#DB3B4B',
  brightGreen: '#208A3C',
  brightYellow: '#9E6C00',
  brightBlue: '#3574F0',
  brightMagenta: '#B05EDA',
  brightCyan: '#0598BC',
  brightWhite: '#27282E'
}

/** 当前有效主题对应的 xterm 色板(建实例与热切共用同一入口) */
function xtermTheme(): ITheme {
  return getEffectiveTheme() === 'light' ? INTELLIJ_LIGHT_THEME : JETBRAINS_DARK_THEME
}

const FONT_FALLBACK = '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace'

/** 设置的字体族排链首(空串/默认值时即纯回退链) */
function terminalFontFamily(): string {
  const family = getAppSettings().terminal.fontFamily.trim()
  if (family.length === 0 || family === 'JetBrains Mono') return FONT_FALLBACK
  return `"${family.replace(/"/g, '')}", ${FONT_FALLBACK}`
}

/**
 * JetBrains Mono(@fontsource woff2)异步加载:若实例在字体就绪前创建,
 * xterm 已按回退字体量字 —— 字体就绪后重设 fontFamily 触发重新量字 + fit。
 * (options 同值赋值会被 xterm 去重,先切 monospace 再切回强制刷新)
 */
function remeasureAfterFontLoad(id: string, fontSize: number): void {
  try {
    void document.fonts
      .load(`${fontSize}px "JetBrains Mono"`)
      .then(() => {
        const inst = registry.get(id)
        if (!inst) return
        inst.term.options.fontFamily = 'monospace'
        inst.term.options.fontFamily = terminalFontFamily()
        fitTerm(id)
      })
      .catch(() => undefined)
  } catch {
    // FontFaceSet 不可用:跳过,回退字体链兜底
  }
}

export interface TermInstance {
  info: TerminalSessionInfo
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** 常驻宿主(React 挂载点 appendChild/removeChild) */
  holder: HTMLDivElement
  /** term.open 延迟到首次接入布局(xterm 需在已挂载 DOM 上量字) */
  opened: boolean
}

const registry = new Map<string, TermInstance>()

// 终端字体族/字号/行高即时生效:设置镜像变化 → 全部实例 options + 重排(fit)
let appliedFontKey: string | null = null
subscribeSettings(() => {
  const { fontSize, lineHeight } = getAppSettings().terminal
  const fontFamily = terminalFontFamily()
  const key = `${fontSize}|${lineHeight}|${fontFamily}`
  if (key === appliedFontKey) return
  appliedFontKey = key
  for (const inst of registry.values()) {
    inst.term.options.fontSize = fontSize
    inst.term.options.fontFamily = fontFamily
    inst.term.options.lineHeight = lineHeight
  }
  fitAllTerms()
})

// 主题热切换:有效主题变化 → 全部已开会话 options.theme(xterm 即时重绘,
// 含滚回缓冲;仅 SGR 指定过的前景/背景色保持原义,默认色随新色板)
subscribeTheme(() => {
  const theme = xtermTheme()
  for (const inst of registry.values()) inst.term.options.theme = theme
})

/** ⌘F 请求回调(UI 层注入,打开对应会话的搜索条) */
let searchRequestHandler: ((sessionId: string) => void) | null = null
export function setSearchRequestHandler(cb: (sessionId: string) => void): void {
  searchRequestHandler = cb
}

/** 创建(或返回已有)会话的 xterm 实例 */
export function createTermInstance(info: TerminalSessionInfo): TermInstance {
  const existing = registry.get(info.id)
  if (existing) return existing

  const holder = document.createElement('div')
  holder.style.width = '100%'
  holder.style.height = '100%'

  const term = new Terminal({
    fontSize: getAppSettings().terminal.fontSize,
    fontFamily: terminalFontFamily(),
    lineHeight: getAppSettings().terminal.lineHeight,
    theme: xtermTheme(), // 深浅色板随当前有效主题(后续切换经 subscribeTheme 热切)
    customGlyphs: true, // 制表/方块/Powerline 自绘(WebGL 渲染器下生效)
    cursorBlink: true,
    scrollback: 8000,
    // pipe 兜底模式输出是裸 \n(无 pty 不做 ONLCR 翻译),xterm 侧补 CR
    convertEol: info.backend === 'pipe'
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  // 链接点击 → window.open → main 的 setWindowOpenHandler 转交系统浏览器
  term.loadAddon(new WebLinksAddon())

  // ⌘K 清屏 / ⌘F 搜索条(仅终端聚焦时生效,不与 Monaco 冲突)
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    const mod = ev.metaKey || ev.ctrlKey
    if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault()
      term.clear()
      return false
    }
    if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault()
      searchRequestHandler?.(info.id)
      return false
    }
    return true
  })

  // 键入 → main PtyService(粘贴多行由 xterm bracketed paste 默认处理)
  term.onData((data) => window.api.terminalWrite(info.id, data))
  // fit 改变行列 → 回传 pty resize(pipe 模式 main 侧为 no-op)
  term.onResize(({ cols, rows }) => void window.api.terminalResize(info.id, cols, rows))

  const inst: TermInstance = { info, term, fit, search, holder, opened: false }
  registry.set(info.id, inst)
  // 字体文件就绪后重新量字(已就绪时立即 resolve,近乎零开销)
  remeasureAfterFontLoad(info.id, term.options.fontSize ?? 12)
  return inst
}

export function getTermInstance(id: string): TermInstance | undefined {
  return registry.get(id)
}

/** WebGL 渲染器(须在 term.open 之后加载;失败/丢上下文回退 DOM 渲染器) */
function loadWebglRenderer(inst: TermInstance): void {
  try {
    const webgl = new WebglAddon()
    // 上下文丢失(GPU 重置/超出浏览器 WebGL 上下文数上限):销毁即回退 DOM 渲染
    webgl.onContextLoss(() => webgl.dispose())
    inst.term.loadAddon(webgl)
  } catch {
    // WebGL 不可用(远程桌面/驱动黑名单等):DOM 渲染器兜底
  }
}

/** 把常驻 holder 接入 React 挂载点(首次接入时才真正 term.open) */
export function attachTerm(id: string, host: HTMLElement): void {
  const inst = registry.get(id)
  if (!inst) return
  if (inst.holder.parentElement !== host) host.appendChild(inst.holder)
  if (!inst.opened) {
    inst.opened = true
    inst.term.open(inst.holder)
    loadWebglRenderer(inst)
  }
}

/** 从挂载点摘下(实例与缓冲保留,工具窗隐藏/切换布局用) */
export function detachTerm(id: string, host: HTMLElement): void {
  const inst = registry.get(id)
  if (inst && inst.holder.parentElement === host) host.removeChild(inst.holder)
}

/** 输出流写入(终端不存在时静默丢弃 —— 关闭竞态) */
export function writeToTerm(id: string, data: string): void {
  registry.get(id)?.term.write(data)
}

/** 按当前宿主尺寸重排(隐藏态尺寸为 0 时跳过,避免 fit 抛错) */
export function fitTerm(id: string): void {
  const inst = registry.get(id)
  if (!inst) return
  if (inst.holder.clientWidth < 20 || inst.holder.clientHeight < 20) return
  try {
    inst.fit.fit()
  } catch {
    /* 渲染器未就绪等瞬态,忽略 */
  }
}

/** 全部会话按宿主尺寸重排(视图模式切换后的布局平滑复位) */
export function fitAllTerms(): void {
  for (const id of registry.keys()) fitTerm(id)
}

export function focusTerm(id: string): void {
  registry.get(id)?.term.focus()
}

/** 会话关闭:销毁 xterm 与常驻 DOM */
export function disposeTermInstance(id: string): void {
  const inst = registry.get(id)
  if (!inst) return
  registry.delete(id)
  try {
    inst.term.dispose()
  } catch {
    /* 已销毁 */
  }
  inst.holder.remove()
}
