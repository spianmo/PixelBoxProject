/**
 * 独立工具窗(视图模式 Window)—— main 进程窗口管理
 *
 * - toolwindow:open  打开(或聚焦已有)独立工具窗:新 BrowserWindow 加载 ?toolwindow=<id>,
 *   renderer 入口(main.tsx)检测该参数分流渲染 StandaloneToolWindow(深色壳同主题)
 * - toolwindow:close 关闭指定独立工具窗;toolwindow:list 返回当前打开的 id
 *   (renderer 重载后对账恢复 window 视图模式)
 * - 窗口关闭(用户 ✕ / IPC)→ 广播 toolwindow:closed,renderer 将该工具窗回 Dock Pinned
 * - 仅白名单 id(terminal / build):终端 PTY 数据与构建日志在 main 侧均为全窗口广播,
 *   跨窗完整可用;其余工具窗状态在主窗 renderer 内,由 UI 层置灰
 * - 生命周期从属主窗:主窗关闭 / 应用退出时 disposeToolWindows() 关净全部独立工具窗
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { StandaloneToolId, ToolWindowClosedEvent } from '../shared/ipc-types'
import { trackWindowState, windowStateFor } from './windowState'

/** 支持独立窗口的工具窗白名单(与 renderer shell/viewMode.ts 的 WINDOWABLE 一致) */
const SUPPORTED: ReadonlySet<string> = new Set<StandaloneToolId>(['terminal', 'build'])

const wins = new Map<StandaloneToolId, BrowserWindow>()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function openToolWindow(id: StandaloneToolId): void {
  // 已开:恢复 + 聚焦(视图模式菜单再次选择「独立窗口」即聚焦既有窗口)
  const existing = wins.get(id)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  // 位置/尺寸记忆(统一 windowState 机制,按工具窗 id 分键;
  // 「恢复上次会话」关闭时用默认值;越界显示器已校正)
  const saved = windowStateFor(`toolwindow-${id}`, { minWidth: 520, minHeight: 320 })
  const win = new BrowserWindow({
    width: saved?.bounds.width ?? (id === 'terminal' ? 980 : 900),
    height: saved?.bounds.height ?? 620,
    ...(saved?.bounds.x !== undefined && saved.bounds.y !== undefined
      ? { x: saved.bounds.x, y: saved.bounds.y }
      : {}),
    minWidth: 520,
    minHeight: 320,
    show: false,
    title: id === 'terminal' ? 'PixelBox Terminal' : 'PixelBox Build Output',
    backgroundColor: '#1e1f22', // 深色壳同主题(编辑器背景)
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    // 与主窗一致:macOS 隐藏原生标题栏保留红绿灯;Windows/Linux 无边框自绘
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 后台窗口不节流(终端输出 / 构建日志持续回流)
      backgroundThrottling: false
    }
  })
  wins.set(id, win)
  if (saved?.maximized) win.maximize() // show 前最大化,避免普通态闪帧

  win.on('ready-to-show', () => win.show())
  // 位置/尺寸 500ms 去抖落盘(统一 windowState 机制)
  trackWindowState(win, `toolwindow-${id}`)
  // 关闭(任何途径)→ 广播,renderer 将该工具窗回 Dock Pinned
  win.on('closed', () => {
    wins.delete(id)
    broadcast('toolwindow:closed', { id } satisfies ToolWindowClosedEvent)
  })
  // 外部链接一律交给系统浏览器(终端 WebLinksAddon 点击等)
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?toolwindow=${id}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { toolwindow: id } })
  }
}

export function registerToolWindowIpc(): void {
  // 打开(或聚焦)独立工具窗;非白名单 id 返回 false
  ipcMain.handle('toolwindow:open', (_e, id: string): boolean => {
    if (!SUPPORTED.has(id)) return false
    openToolWindow(id as StandaloneToolId)
    return true
  })

  // 关闭独立工具窗(closed 事件回流后广播)
  ipcMain.handle('toolwindow:close', (_e, id: string): void => {
    const win = wins.get(id as StandaloneToolId)
    if (win && !win.isDestroyed()) win.close()
  })

  // 当前打开的独立工具窗(renderer 重载后对账恢复 window 视图模式)
  ipcMain.handle('toolwindow:list', (): string[] => [...wins.keys()])
}

/** 主窗关闭 / 应用退出:关净全部独立工具窗(closed 广播随窗口销毁自然发出) */
export function disposeToolWindows(): void {
  for (const win of wins.values()) {
    if (!win.isDestroyed()) win.destroy()
  }
  wins.clear()
}
