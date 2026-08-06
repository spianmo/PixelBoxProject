/**
 * xterm 实例注册表 —— 终端渲染层的常驻宿主(React 组件卸载不销毁)
 *
 * 每个会话持有一个脱离 React 的 holder div,xterm 打开在其中;
 * TermPane 挂载时把 holder 接入布局、卸载时摘下,工具窗隐藏/底部区切换
 * (日志 ⇄ 终端)期间实例与滚回缓冲全程保留。
 *
 * 主题:JetBrains Dark 近似 ANSI 16 色,背景对齐编辑器 #1E1F22,
 * 字号走 IDE 设置(工具 › 终端;settings:changed 对全部已开会话即时生效),
 * JetBrains Mono 优先的等宽回退链(与 tailwind fontFamily.mono 一致)。
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSessionInfo } from '../../../shared/ipc-types'
import { getAppSettings, subscribeSettings } from '../settings/store'

/** JetBrains Dark(Darcula console 系)近似 ANSI 色板;背景/前景对齐 IDE 色板 */
const JETBRAINS_DARK_THEME = {
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
} as const

const FONT_FAMILY = '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace'

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
        inst.term.options.fontFamily = FONT_FAMILY
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

// 终端字号即时生效:设置镜像变化 → 全部实例 options.fontSize + 重排(fit)
let appliedFontSize: number | null = null
subscribeSettings(() => {
  const size = getAppSettings().terminal.fontSize
  if (size === appliedFontSize) return
  appliedFontSize = size
  for (const inst of registry.values()) inst.term.options.fontSize = size
  fitAllTerms()
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
    fontFamily: FONT_FAMILY,
    theme: JETBRAINS_DARK_THEME,
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

/** 把常驻 holder 接入 React 挂载点(首次接入时才真正 term.open) */
export function attachTerm(id: string, host: HTMLElement): void {
  const inst = registry.get(id)
  if (!inst) return
  if (inst.holder.parentElement !== host) host.appendChild(inst.holder)
  if (!inst.opened) {
    inst.opened = true
    inst.term.open(inst.holder)
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
