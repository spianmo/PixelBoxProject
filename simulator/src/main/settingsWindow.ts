/**
 * IDE 设置独立窗口(main 进程)—— 复用 toolWindows.ts 的 ?query 分流模式
 *
 * - settings:window-open  打开(或聚焦)单例设置窗口:新 BrowserWindow 加载
 *   ?window=settings,renderer 入口(main.tsx)检测该参数分流渲染 SettingsWindow
 *   (不加载 Monaco / device-sim 等主窗重资产)
 * - 尺寸约 980×700,位置/尺寸记忆走统一 windowState.ts(window-state.json 的
 *   'settings' 键,move/resize 500ms 去抖落盘 + 越界显示器校正;
 *   旧 settings-window.json 机制已并入,不再读写)
 * - 关闭协议:✕ / Cmd+W 等系统关闭先被拦截,经 settings:close-request 交 renderer
 *   决定 —— 有未应用修改时弹确认框,确认(或本就干净)后 renderer 调
 *   settings:window-close 强制关闭;Esc=Cancel 语义在 renderer 侧实现
 * - 生命周期从属主窗:主窗关闭 / 应用退出时 disposeSettingsWindow() 关净
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { trackWindowState, windowStateFor } from './windowState'

let win: BrowserWindow | null = null
/** renderer 确认后置 true,放行 close(否则 close 一律转为 close-request) */
let allowClose = false

/** 打开(或聚焦)设置窗口(IPC 入口;PIXELBOX_OPEN_SETTINGS=1 冒烟亦直接调用) */
export async function openSettingsWindow(): Promise<void> {
  // 单例:再次打开即聚焦
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return
  }

  // 位置/尺寸记忆(统一 windowState 机制;「恢复上次会话」关闭时用默认值)
  const saved = windowStateFor('settings', { minWidth: 760, minHeight: 520 })
  allowClose = false
  const w = new BrowserWindow({
    width: saved?.bounds.width ?? 980,
    height: saved?.bounds.height ?? 700,
    ...(saved?.bounds.x !== undefined && saved.bounds.y !== undefined
      ? { x: saved.bounds.x, y: saved.bounds.y }
      : {}),
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'PixelBox Settings',
    backgroundColor: '#1e1f22', // 深色壳同主题
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
      nodeIntegration: false
    }
  })
  win = w
  if (saved?.maximized) w.maximize() // show 前最大化,避免普通态闪帧

  w.on('ready-to-show', () => {
    w.show()
    // 生命周期日志(dev 终端可见;无 UI 驱动的冒烟环境据此确认渲染链路真实走通)
    console.log('[settings-window] ready (?window=settings)')
  })
  // 位置/尺寸 500ms 去抖落盘(统一 windowState 机制)
  trackWindowState(w, 'settings')
  // 系统关闭(✕ / Cmd+W)→ 转交 renderer:有未应用修改时先弹确认框
  w.on('close', (e) => {
    if (allowClose || w.isDestroyed()) return
    e.preventDefault()
    w.webContents.send('settings:close-request')
  })
  w.on('closed', () => {
    if (win === w) win = null
  })
  // 外部链接一律交给系统浏览器
  w.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}?window=settings`)
  } else {
    void w.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'settings' } })
  }
}

export function registerSettingsWindowIpc(): void {
  // 打开(或聚焦)设置窗口 —— 主窗 ⚙ /「IDE 设置…」的统一入口
  ipcMain.handle('settings:window-open', async (): Promise<void> => openSettingsWindow())

  // renderer 确认关闭(Cancel/OK/确认丢弃后调用;草稿由 renderer 自行丢弃)
  ipcMain.handle('settings:window-close', (): void => {
    if (win && !win.isDestroyed()) {
      allowClose = true
      win.close()
    }
  })
}

/** 主窗关闭 / 应用退出:关净设置窗口 */
export function disposeSettingsWindow(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
