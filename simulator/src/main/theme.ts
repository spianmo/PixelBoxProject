/**
 * 主题桥(main 进程)—— appearance.theme = system 的 nativeTheme 解析 + 窗口底色统一
 *
 * - theme:get-system(invoke):返回当前系统主题(nativeTheme.shouldUseDarkColors)
 * - nativeTheme 'updated' → theme:system-changed 广播到全部窗口(renderer 侧
 *   仅在「跟随系统」时据此重算有效主题并切 <html data-theme>)
 * - theme:applied(send):renderer 每次应用主题后回报 —— main 侧打
 *   「[theme] applied=...」日志(dev 冒烟断言证据,PIXELBOX_SMOKE_THEME=1)
 *   并把全部已开窗口的 backgroundColor 同步到新有效主题(防 resize 露底闪色)
 * - windowBackgroundColor():按「设置值 + 系统主题」解析当前有效主题的建窗底色,
 *   main 三处建窗点(主窗 / 设置窗 / 独立工具窗)统一调用,防背景闪白/闪黑
 */
import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import type { EffectiveTheme } from '../shared/ipc-types'
import { getSettingsSync } from './settings'

/** 有效主题对应的窗口底色(dark = JetBrains 编辑器背景 / light = 纯白编辑器背景) */
const WINDOW_BG: Record<EffectiveTheme, string> = {
  dark: '#1e1f22',
  light: '#ffffff'
}

/** 当前系统主题(nativeTheme 解析) */
function systemTheme(): EffectiveTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** 解析当前有效主题:设置值 system 时跟随操作系统 */
export function effectiveTheme(): EffectiveTheme {
  const t = getSettingsSync().appearance.theme
  return t === 'system' ? systemTheme() : t
}

/**
 * 当前有效主题的建窗底色 —— BrowserWindow backgroundColor 统一入口
 * (建窗早于 renderer 首帧,底色对齐可避免亮色主题下先闪一帧深色/反之)
 */
export function windowBackgroundColor(): string {
  return WINDOW_BG[effectiveTheme()]
}

/** 把全部已开窗口的底色同步到当前有效主题(主题切换 / 系统主题变化后调用) */
function syncWindowBackgrounds(): void {
  const bg = windowBackgroundColor()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(bg)
  }
}

/** theme:applied 日志行监听(冒烟钩子注入,收集 applied=<设置值> 取值做断言) */
let appliedLineListener: ((line: string) => void) | null = null
export function onThemeAppliedLine(cb: (line: string) => void): void {
  appliedLineListener = cb
}

export function registerThemeIpc(): void {
  // 系统主题查询(renderer 主题管理器初始化时拉取一次)
  ipcMain.handle('theme:get-system', (): EffectiveTheme => systemTheme())

  // renderer 应用主题回报:日志(冒烟断言)+ 窗口底色同步
  ipcMain.on('theme:applied', (_e, text: unknown): void => {
    if (typeof text === 'string' && text.startsWith('[theme]')) {
      const line = text.slice(0, 256)
      console.log(line)
      appliedLineListener?.(line)
    }
    syncWindowBackgrounds()
  })

  // 系统主题变化 → 全窗口广播(renderer 侧「跟随系统」据此重算)+ 底色同步
  nativeTheme.on('updated', () => {
    const mode = systemTheme()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('theme:system-changed', mode)
    }
    if (getSettingsSync().appearance.theme === 'system') syncWindowBackgrounds()
  })
}
