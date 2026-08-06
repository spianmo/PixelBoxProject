/**
 * PixelBox 模拟器 IDE — main 进程入口
 * 职责:创建主窗口 + 注册 workspace/builder/devd 三组 IPC 服务
 */
import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { registerWorkspaceIpc, disposeWorkspace } from './workspace'
import { registerBuilderIpc, disposeBuilder } from './builder'
import { registerDevdIpc, disposeDevd } from './devd'
import { registerSimBridgeIpc, disposeSimBridge } from './simbridge'
import { registerShellIpc, wireShellWindowEvents } from './shell'
import { registerDeviceProfilesIpc, ensureDeviceProfilesDir } from './deviceProfiles'
import { registerToolchainIpc, disposeToolchain } from './toolchain'
import { registerProjectScaffoldIpc } from './projectScaffold'
import { registerTerminalIpc, disposeTerminal } from './pty'
import { registerToolWindowIpc, disposeToolWindows } from './toolWindows'

// device-sim:沙箱 iframe 隐藏在页面中,禁用 Chromium 对后台/离屏帧的定时器与渲染节流,
// 否则沙箱内 setTimeout/setInterval(动画、IMU、GPS 定时回调)会被限到 1Hz
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'PixelBox Simulator',
    backgroundColor: '#1e1f22', // 对齐 JetBrains dark 编辑器背景
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    // 自绘标题栏:macOS 隐藏原生标题栏但保留红绿灯(hiddenInset);
    // Windows/Linux 完全无边框,由 renderer 自绘 最小化/最大化/关闭
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // device-sim:窗口失焦/遮挡时保持沙箱帧节拍与定时器不被节流
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => win.show())
  wireShellWindowEvents(win)
  // 独立工具窗生命周期从属主窗:主窗关闭时一并关闭(macOS 下避免残留孤儿工具窗)
  win.on('closed', () => disposeToolWindows())

  // 外部链接一律交给系统浏览器
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // dev 模式 macOS Dock 图标(打包版由 electron-builder 的 icns 提供)。
  // 用 icon-mac.png(824 内容居中 + 185 圆角 + 透明留白, Apple 图标网格),
  // 直接用全幅方形 icon.png 会在 Dock 里显得过大且无圆角。
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = join(__dirname, '../../build/icon-mac.png')
    if (existsSync(dockIcon)) app.dock.setIcon(dockIcon)
  }
  registerWorkspaceIpc()
  registerBuilderIpc()
  registerDevdIpc()
  registerSimBridgeIpc()
  registerShellIpc()
  registerDeviceProfilesIpc()
  registerToolchainIpc()
  registerProjectScaffoldIpc()
  registerTerminalIpc()
  registerToolWindowIpc()
  void ensureDeviceProfilesDir()

  // 设备模拟需要麦克风/摄像头(getUserMedia):本地开发工具,直接放行 media 权限
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disposeWorkspace()
  void disposeBuilder()
  disposeDevd()
  disposeSimBridge()
  disposeToolchain() // 不留后台固件构建/烧录进程
  disposeTerminal() // 杀净全部集成终端会话
  disposeToolWindows() // 关净全部独立工具窗
})
