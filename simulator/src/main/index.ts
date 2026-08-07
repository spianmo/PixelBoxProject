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
import { registerGitIpc, disposeGit } from './git'
import { registerSearchIpc } from './search'
import { initAppMenu } from './menu'
import { registerDeviceProfilesIpc, ensureDeviceProfilesDir } from './deviceProfiles'
import { registerToolchainIpc, disposeToolchain } from './toolchain'
import { registerClangdIpc, disposeClangd } from './clangd'
import { registerProjectScaffoldIpc } from './projectScaffold'
import { registerPrinterIpc, disposePrinter } from './printer'
import { registerHardwareExportIpc } from './hardwareExport'
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
import {
  registerFullscreenIpc,
  wireFullscreen,
  runFullscreenSmoke,
  runFullscreenVisualSmoke,
  runTrafficLightsDiffSmoke
} from './fullscreen'

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
  // native-fullscreen:macOS 全入口(绿灯/⌃⌘F/系统菜单)走原生全屏 Space,无任何
  // 拦截/转换;仅广播全屏态给 TitleBar(全屏时取消红绿灯 80px 预留区)。
  // Win/Linux 补 F11 原生全屏。上次退出处于全屏时随会话恢复(windowState 落盘位)
  wireFullscreen(win, { restoreFullScreen: saved?.fullscreen === true })
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
  registerGitIpc() // Git 集成(git:info/status/commit/push/pull…,见 main/git.ts)
  registerSearchIpc() // 项目内容检索(search:content,IDEA ⇧⌘F)
  registerFullscreenIpc() // 全屏态查询(win:is-fullscreen;变化经 win:fullscreen 广播)
  registerDeviceProfilesIpc()
  registerToolchainIpc()
  registerClangdIpc() // 固件工程 C/C++ LSP(clangd:start/stop/request/notify)
  registerProjectScaffoldIpc()
  registerPrinterIpc() // 3D 打印机联机(printer:test/pick-gcode/upload/job)
  registerHardwareExportIpc() // 硬件导出(hardware:export → <root>/export/<kind>/)
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
  initAppMenu() // 原生应用菜单(含 Git 顶级菜单;动态分支子菜单随 git 活动去抖重建)

  // 冒烟钩子(与 pty.ts 的 PIXELBOX_FORCE_PIPE 同风格):启动即打开设置窗口,
  // 无 UI 驱动手段的环境也能真实走一遍 ?window=settings 渲染链路
  if (process.env.PIXELBOX_OPEN_SETTINGS === '1') void openSettingsWindow()

  // 冒烟钩子(native-fullscreen,无 UI 驱动环境):setFullScreen(true)(绿灯同一
  // 原生入口)→ 断言进入原生全屏(isFullScreen 且非 simple、bounds 铺满显示器)
  // → 退出 → 断言回窗口态与 bounds 精确恢复(详见 fullscreen.ts)
  if (process.env.PIXELBOX_SMOKE_FS === '1') {
    mainWin.once('ready-to-show', () => runFullscreenSmoke(mainWin))
  }

  // 视觉冒烟钩子(native-fullscreen,配套 scripts/fullscreen-visual-check.mjs):
  // 进原生全屏 Space → 打印 [fs-visual] entered(外部脚本截屏断言窗口顶部第一行
  // 即主题标题栏色、红绿灯常驻不可见仅记录)→ 哨兵文件出现后退出 → 打印 bounds
  // 精确恢复结果(详见 fullscreen.ts)
  if (process.env.PIXELBOX_SMOKE_FS_VISUAL === '1') {
    mainWin.once('ready-to-show', () => runFullscreenVisualSmoke(mainWin))
  }

  // 红绿灯一比一对齐冒烟钩子(配套 scripts/traffic-lights-diff-check.mjs):
  // 窗口态已知矩形(真件基准采样)→ 哨兵进原生全屏(假件采样)→ 哨兵退出
  // (详见 fullscreen.ts runTrafficLightsDiffSmoke)
  if (process.env.PIXELBOX_SMOKE_TL_DIFF === '1') {
    mainWin.once('ready-to-show', () => runTrafficLightsDiffSmoke(mainWin))
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

  // 冒烟钩子(monaco ts.worker,无 UI 驱动环境):经 executeJavaScript 在真实
  // renderer 里对内容为 `px.` 的 TS 模型请求补全 —— 断言 worker 拉起成功且
  // pixelbox.d.ts extraLib 注入未回退(补全含 screen/system 等 px 命名空间)。
  // 配套暴露点见 monacoSetup.ts 尾部(window.__pixelboxMonaco)
  if (process.env.PIXELBOX_SMOKE_MONACO === '1') {
    mainWin.webContents.once('did-finish-load', () => {
      const probe = `(async () => {
        const deadline = Date.now() + 20000
        // monaco 初始化为渲染进程启动同步链路,此处轮询仅为对抗加载时序
        while (!window.__pixelboxMonaco && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
        }
        const monaco = window.__pixelboxMonaco
        if (!monaco) return { ok: false, reason: 'monaco 未就绪(20s)' }
        const model = monaco.editor.createModel(
          'px.', 'typescript', monaco.Uri.parse('file:///smoke/monaco-smoke.ts')
        )
        try {
          const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
          const client = await getWorker(model.uri)
          const info = await client.getCompletionsAtPosition(model.uri.toString(), 3)
          const names = (info && info.entries ? info.entries : []).map((e) => e.name)
          return {
            ok: names.includes('screen') && names.includes('system') && names.includes('wifi'),
            count: names.length,
            sample: names.slice(0, 8)
          }
        } finally {
          model.dispose()
        }
      })()`
      void mainWin.webContents
        .executeJavaScript(probe)
        .then((r: { ok: boolean; count?: number; sample?: string[]; reason?: string }) => {
          if (r.ok) {
            console.log(`[monaco] ✓ ts.worker 补全含 px 命名空间(共 ${r.count} 项)`)
            console.log('[monaco] SMOKE PASS')
          } else {
            process.exitCode = 1
            console.error(`[monaco] ✗ 补全断言失败:${r.reason ?? JSON.stringify(r.sample)}`)
            console.log('[monaco] SMOKE FAIL')
          }
          app.quit()
        })
        .catch((err: unknown) => {
          process.exitCode = 1
          console.error(`[monaco] ✗ 探针执行失败:${String(err)}`)
          console.log('[monaco] SMOKE FAIL')
          app.quit()
        })
    })
  }

  // 冒烟钩子(脚手架生成,无 UI 驱动环境):PIXELBOX_SMOKE_SCAFFOLD='<kind>:<目标目录>'
  // → createProject 生成后立即退出(配套 scripts/firmware-scaffold-check 等外部编译验证)
  const smokeScaffold = process.env.PIXELBOX_SMOKE_SCAFFOLD
  if (smokeScaffold && smokeScaffold.includes(':')) {
    const kind = smokeScaffold.slice(0, smokeScaffold.indexOf(':')) as 'app' | 'firmware' | 'hardware'
    const location = smokeScaffold.slice(smokeScaffold.indexOf(':') + 1)
    void (async () => {
      try {
        const { createProject } = await import('./projectScaffold')
        const created = await createProject({
          kind,
          name: 'smoke',
          location,
          chip: 'esp32s3',
          appId: 'com.example.smoke',
          template: 'blank'
        })
        console.log(`[scaffold-smoke] OK ${created.root}(kind=${created.kind})`)
      } catch (err) {
        process.exitCode = 1
        console.error(`[scaffold-smoke] FAIL ${String(err)}`)
      }
      app.quit()
    })()
  }

  // 冒烟钩子(硬件设计链路,无 UI 驱动环境):main 侧创建临时 hardware 工程,
  // 经 executeJavaScript 在真实 renderer 走 evaluateDesign(blob worker eval)→
  // 外壳分件 → HardwareViewer 离屏 STL 导出的完整生产链路。
  // 配套暴露点见 renderer/src/hardware/smoke.ts(window.__pbHwSmoke)
  if (process.env.PIXELBOX_SMOKE_HW === '1') {
    mainWin.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          const { mkdtemp, realpath } = await import('node:fs/promises')
          const { tmpdir } = await import('node:os')
          const { createProject } = await import('./projectScaffold')
          // macOS 临时目录是符号链接(/var/folders → /private/var/folders):
          // 先规范化,保证探针传入的 root 与 workspace 路径牢笼的规范化根一致
          const location = await realpath(await mkdtemp(join(tmpdir(), 'pb-hw-smoke-')))
          const created = await createProject({
            kind: 'hardware',
            name: 'hwsmoke',
            location,
            chip: 'esp32s3'
          })
          console.log(`[hw-smoke] 工程已创建:${created.root}(kind=${created.kind})`)
          const probe = `(async () => {
            const deadline = Date.now() + 20000
            while (!window.__pbHwSmoke && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 200))
            }
            if (!window.__pbHwSmoke) return { ok: false, error: 'smoke 入口未就绪(20s)' }
            return await window.__pbHwSmoke(${JSON.stringify(created.root)})
          })()`
          const r = (await mainWin.webContents.executeJavaScript(probe)) as {
            ok: boolean
            [k: string]: unknown
          }
          console.log(`[hw-smoke] 结果:${JSON.stringify(r)}`)
          if (r.ok) {
            console.log('[hw-smoke] SMOKE PASS')
          } else {
            process.exitCode = 1
            console.log('[hw-smoke] SMOKE FAIL')
          }
        } catch (err) {
          process.exitCode = 1
          console.error(`[hw-smoke] ✗ 执行异常:${String(err)}`)
          console.log('[hw-smoke] SMOKE FAIL')
        }
        app.quit()
      })()
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
  disposeGit() // 杀流式 push/pull 进程组 + 关 .git watcher
  disposeToolchain() // 不留后台固件构建/烧录进程
  disposeClangd() // 杀净 clangd LSP 进程
  disposePrinter() // 中止在飞的打印机请求(长上传不阻塞退出)
  disposeTerminal() // 杀净全部集成终端会话
  disposeToolWindows() // 关净全部独立工具窗
  disposeSettingsWindow() // 关净设置窗口
})
