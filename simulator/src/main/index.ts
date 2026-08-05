/**
 * PixelBox 模拟器 IDE — main 进程入口
 * 职责:创建主窗口 + 注册 workspace/builder/devd 三组 IPC 服务
 */
import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { registerWorkspaceIpc, disposeWorkspace } from './workspace'
import { registerBuilderIpc, disposeBuilder } from './builder'
import { registerDevdIpc, disposeDevd } from './devd'
import { registerSimBridgeIpc, disposeSimBridge } from './simbridge'

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
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
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
  registerWorkspaceIpc()
  registerBuilderIpc()
  registerDevdIpc()
  registerSimBridgeIpc()

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
})
