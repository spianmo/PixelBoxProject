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
import { registerSettingsIpc, getSettings, getSettingsSync, setSettings } from './settings'
import { registerThemeIpc, windowBackgroundColor, onThemeAppliedLine } from './theme'
import {
  registerSettingsWindowIpc,
  disposeSettingsWindow,
  openSettingsWindow
} from './settingsWindow'
import { registerSessionIpc, flushSessionState } from './sessionState'
import { trackWindowState, windowStateFor, flushWindowStates } from './windowState'
import { registerFullscreenIpc, wireFullscreen, runFullscreenSmoke } from './fullscreen'

// device-sim:沙箱 iframe 隐藏在页面中,禁用 Chromium 对后台/离屏帧的定时器与渲染节流,
// 否则沙箱内 setTimeout/setInterval(动画、IMU、GPS 定时回调)会被限到 1Hz
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

function createWindow(): BrowserWindow {
  // 会话恢复:上次主窗 bounds/最大化(受「恢复上次会话」开关控制;越界显示器已校正)
  const saved = windowStateFor('main', { minWidth: 1024, minHeight: 640 })
  const win = new BrowserWindow({
    width: saved?.bounds.width ?? 1480,
    height: saved?.bounds.height ?? 920,
    ...(saved?.bounds.x !== undefined && saved.bounds.y !== undefined
      ? { x: saved.bounds.x, y: saved.bounds.y }
      : {}),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'PixelBox Simulator',
    backgroundColor: windowBackgroundColor(), // 底色随当前有效主题(防首帧闪色;见 theme.ts)
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
  if (saved?.maximized) win.maximize() // show 前最大化,避免先普通态闪一帧

  win.on('ready-to-show', () => win.show())
  wireShellWindowEvents(win)
  // mac-fullscreen:原生全屏全入口(绿灯/⌃⌘F/菜单)收敛 simpleFullScreen,
  // 红绿灯保持窗体内自绘标题栏行内,无原生灰条;Win/Linux 补 F11 原生全屏。
  // 上次退出处于 simpleFullScreen 时随会话恢复(windowState 落盘位)
  wireFullscreen(win, { restoreSimpleFullScreen: saved?.simpleFullScreen === true })
  // 会话恢复:主窗 bounds/最大化 500ms 去抖落盘
  trackWindowState(win, 'main')
  // 退出双保险之一:主窗关闭即同步兜底落盘(before-quit 为另一道,见下)
  win.on('close', () => {
    flushSessionState()
    flushWindowStates()
  })
  // 独立工具窗/设置窗生命周期从属主窗:主窗关闭时一并关闭(macOS 下避免残留孤儿窗口)
  win.on('closed', () => {
    disposeToolWindows()
    disposeSettingsWindow()
  })

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
  return win
}

app.whenReady().then(async () => {
  // dev 模式 macOS Dock 图标(打包版由 electron-builder 的 icns 提供)。
  // 用 icon-mac.png(824 内容居中 + 185 圆角 + 透明留白, Apple 图标网格),
  // 直接用全幅方形 icon.png 会在 Dock 里显得过大且无圆角。
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = join(__dirname, '../../build/icon-mac.png')
    if (existsSync(dockIcon)) app.dock.setIcon(dockIcon)
  }
  registerSettingsIpc() // 最先注册:其余服务(工具链/终端)读设置时缓存已在预热
  registerThemeIpc() // 主题桥:theme:get-system / nativeTheme updated 广播 / 窗口底色同步
  registerSettingsWindowIpc()
  registerSessionIpc() // 会话恢复(session:startup / update / report)
  registerWorkspaceIpc()
  registerBuilderIpc()
  registerDevdIpc()
  registerSimBridgeIpc()
  registerShellIpc()
  registerFullscreenIpc() // 全屏态查询(win:is-fullscreen;变化经 win:fullscreen 广播)
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

  // 建窗前等设置就绪:windowStateFor 经 getSettingsSync 读「恢复上次会话」开关,
  // 需要真实落盘值而非默认值(getSettings 带缓存,registerSettingsIpc 已在预热)
  await getSettings()
  const mainWin = createWindow()

  // 冒烟钩子(与 pty.ts 的 PIXELBOX_FORCE_PIPE 同风格):启动即打开设置窗口,
  // 无 UI 驱动手段的环境也能真实走一遍 ?window=settings 渲染链路
  if (process.env.PIXELBOX_OPEN_SETTINGS === '1') void openSettingsWindow()

  // 冒烟钩子(mac-fullscreen,无 UI 驱动环境):模拟原生全屏请求 → 断言收敛为
  // simpleFullScreen → 再触发退出 → 断言回窗口态与 bounds 恢复(详见 fullscreen.ts)
  if (process.env.PIXELBOX_SMOKE_FS === '1') {
    mainWin.once('ready-to-show', () => runFullscreenSmoke(mainWin))
  }

  // 冒烟钩子(light-theme,无 UI 驱动环境):经 SettingsService 依次切
  // dark → light → system(走真实 set-many → settings:changed 广播链路),
  // renderer 主题管理器每次应用后经 theme:applied 回报,main 侧打印
  // 「[theme] applied=...」并收集断言:三种设置值各至少回报一次,且
  // dark/light 的有效主题与设置值一致;收尾恢复原值,打印 SMOKE PASS/FAIL 后退出
  if (process.env.PIXELBOX_SMOKE_THEME === '1') {
    // 监听须先于 renderer 初始化回报注册(首条 applied=<原值> 也计入证据)
    const seen = new Map<string, string>() // 设置值 → 有效主题
    onThemeAppliedLine((line) => {
      const m = /applied=(\S+) effective=(dark|light)/.exec(line)
      if (m) seen.set(m[1], m[2])
    })
    mainWin.once('ready-to-show', () => {
      const original = getSettingsSync().appearance.theme
      const seq: Array<'dark' | 'light' | 'system'> = ['dark', 'light', 'system']
      seq.forEach((theme, i) => {
        setTimeout(() => void setSettings({ 'appearance.theme': theme }), 1500 + i * 1200)
      })
      // 收尾:恢复冒烟前的主题设置(不污染真实用户配置)→ 断言 → 正常退出
      setTimeout(() => void setSettings({ 'appearance.theme': original }), 5400)
      setTimeout(() => {
        let failed = 0
        const assert = (label: string, pass: boolean): void => {
          if (pass) console.log(`[theme] ✓ ${label}`)
          else {
            failed++
            process.exitCode = 1
            console.error(`[theme] ✗ ${label}`)
          }
        }
        assert('applied=dark 回报且有效主题为 dark', seen.get('dark') === 'dark')
        assert('applied=light 回报且有效主题为 light', seen.get('light') === 'light')
        assert(
          `applied=system 回报(nativeTheme 解析为 ${seen.get('system') ?? '?'})`,
          seen.get('system') === 'dark' || seen.get('system') === 'light'
        )
        console.log(failed === 0 ? '[theme] SMOKE PASS' : `[theme] SMOKE FAIL(${failed} 项)`)
        app.quit()
      }, 6800)
    })
  }

  // 冒烟钩子(会话恢复,无 UI 驱动环境):
  // PIXELBOX_SMOKE_SESSION=1 第一轮 —— 模拟用户改窗口位置(setBounds,走 500ms 去抖
  //   落盘链路)+ 请求 renderer 打开 demo 工作区与文件(走真实 applyWorkspace/openFile
  //   → session:update 链路),随后正常退出(close/before-quit 双保险落盘);
  // PIXELBOX_SMOKE_SESSION=2 第二轮 —— 仅启动观察 [session-restore] 恢复日志后退出。
  const smokeSession = process.env.PIXELBOX_SMOKE_SESSION
  if (smokeSession === '1' || smokeSession === '2') {
    mainWin.once('ready-to-show', () => {
      if (smokeSession === '1') {
        // 模拟「用户拖动/调整窗口」:非默认位置与尺寸
        setTimeout(() => mainWin.setBounds({ x: 120, y: 96, width: 1180, height: 760 }), 1200)
        // 请求 renderer 打开 demo 工作区 + src/main.ts(renderer 侧真实走打开链路)
        setTimeout(() => {
          const demoRoot = join(__dirname, '../../demo')
          mainWin.webContents.send('smoke:session-prepare', {
            root: demoRoot,
            file: join(demoRoot, 'src/main.ts')
          })
        }, 2600)
      }
      // 两轮均正常退出(app.quit → 窗口 close → 双保险落盘)
      setTimeout(() => app.quit(), 8000)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 设置「关闭主窗口时退出应用」:macOS 默认驻留 Dock,勾选后与其他平台一致直接退出
  if (process.platform !== 'darwin' || getSettingsSync().system.quitOnMainWindowClose) app.quit()
})

app.on('before-quit', () => {
  // 退出双保险之二:会话/窗口状态同步兜底落盘(主窗 close 为另一道)
  flushSessionState()
  flushWindowStates()
  void disposeWorkspace()
  void disposeBuilder()
  disposeDevd()
  disposeSimBridge()
  disposeToolchain() // 不留后台固件构建/烧录进程
  disposeTerminal() // 杀净全部集成终端会话
  disposeToolWindows() // 关净全部独立工具窗
  disposeSettingsWindow() // 关净设置窗口
})
