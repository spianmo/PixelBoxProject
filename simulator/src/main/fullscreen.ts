/**
 * 窗口全屏行为(main 进程)—— macOS 全屏收敛为 simpleFullScreen(IDEA 式)
 *
 * 问题:titleBarStyle: hiddenInset 下进入 macOS 原生全屏(绿灯 / ⌃⌘F / 菜单),
 * 系统会持久显示原生标题条(灰条 + 居中标题),与 IDEA 行为不符。
 *
 * 方案:拦截一切原生全屏入口,统一收敛到 setSimpleFullScreen —— 窗体铺满屏、
 * 菜单栏/Dock 自动隐藏、红绿灯保持在窗体内自绘标题栏行内,无任何原生条:
 * - enter-full-screen(仅原生态,setSimpleFullScreen 不产生原生态事件)→
 *   立即 setFullScreen(false),leave-full-screen 后 setSimpleFullScreen(true)
 *   (redirecting guard 防重入/防循环)
 * - 退出入口:simpleFullScreen 下 AppKit 会静默忽略 setFullScreen(true)
 *   (冒烟实测无任何 enter-full-screen 事件),默认菜单的 togglefullscreen 角色
 *   (⌃⌘F)因此失效 —— 故把该菜单项替换为自定义 click(保留 Electron 本地化
 *   标签与 ⌃⌘F 加速键),直控 simpleFullScreen 双向切换;若红绿灯仍可见,
 *   绿灯触发的原生态事件仍走上面的拦截(targetSimple=false → 退出)
 * - 全屏期间 win.setTitle('') 置空、退出恢复(双保险:防任何原生条残留文字)
 * - 进入 simpleFullScreen 后 setWindowButtonVisibility(true) 强制红绿灯可见
 *   (hiddenInset 位 x:12,y:10 仍在窗体内,renderer 80px 预留区不变)
 * - Windows/Linux 行为不变:F11 原生全屏(before-input-event 接线)
 *
 * renderer 接线:win:is-fullscreen 查询 + win:fullscreen 广播(TitleBar 全屏下
 * 禁用拖拽区等样式微调);持久化经 windowState.ts 的 simpleFullScreen 位,
 * 启动恢复由 index.ts 传 restoreSimpleFullScreen(会话恢复语义)。
 */
import { app, ipcMain, BrowserWindow, Menu, MenuItem } from 'electron'

/** 当前是否处于「全屏」(macOS simpleFullScreen / 各平台原生全屏) */
function isFullScreenState(win: BrowserWindow): boolean {
  return win.isFullScreen() || (process.platform === 'darwin' && win.isSimpleFullScreen())
}

/** 全屏态变化 → 推送本窗 renderer(TitleBar 样式微调) */
function broadcast(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.webContents.send('win:fullscreen', isFullScreenState(win))
}

export function registerFullscreenIpc(): void {
  // 全屏态查询(renderer 挂载时对账一次,后续走 win:fullscreen 订阅)
  ipcMain.handle('win:is-fullscreen', (e): boolean => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? isFullScreenState(win) : false
  })
}

export interface WireFullscreenOptions {
  /** 上次退出时处于 simpleFullScreen(windowState 落盘):show 后恢复 */
  restoreSimpleFullScreen?: boolean
}

/**
 * 主窗全屏行为接线:
 * - macOS:原生全屏全入口收敛 simpleFullScreen(见文件头)
 * - Windows/Linux:F11 切换原生全屏(既有行为补齐,不改其余语义)
 */
export function wireFullscreen(win: BrowserWindow, opts?: WireFullscreenOptions): void {
  if (process.platform === 'darwin') wireMac(win, opts?.restoreSimpleFullScreen === true)
  else wireOther(win)
}

/** 进入/退出 simpleFullScreen(标题双保险 + 红绿灯强制可见 + 状态日志/广播) */
function applySimpleFullScreen(win: BrowserWindow, on: boolean, normalTitle: string): void {
  if (win.isDestroyed()) return
  win.setSimpleFullScreen(on)
  if (on) {
    // 双保险:全屏期间标题置空,防任何原生条残留文字
    win.setTitle('')
    // Electron 在 simpleFullScreen 下若隐藏红绿灯:强制显示(hiddenInset 位不变)
    win.setWindowButtonVisibility(true)
  } else {
    win.setTitle(normalTitle)
  }
  console.log(
    `[fullscreen] state=simple:${win.isSimpleFullScreen()} native:${win.isFullScreen()}` +
      ` title="${win.getTitle()}"`
  )
  broadcast(win)
}

/** ⌃⌘F / 菜单「切换全屏」目标窗(仅主窗;设置窗/独立工具窗不具全屏能力) */
let macTarget: { win: BrowserWindow; normalTitle: string } | null = null
/** 应用菜单只替换一次(activate 重建主窗时不重复) */
let macMenuPatched = false

/**
 * ⌃⌘F / 菜单「切换全屏」统一入口:窗口态 → 进 simpleFullScreen;已全屏 → 退出。
 * 聚焦在设置窗/独立工具窗时不生效(维持这些窗口不受全屏方案影响的语义)。
 */
function toggleMacFullScreen(): void {
  const t = macTarget
  if (!t || t.win.isDestroyed()) return
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && focused !== t.win) return
  // 原生全屏瞬态(enter→leave 收敛进行中)忽略,避免与拦截流程竞争
  if (t.win.isFullScreen()) return
  applySimpleFullScreen(t.win, !t.win.isSimpleFullScreen(), t.normalTitle)
}

/**
 * 替换默认应用菜单的 togglefullscreen 角色项(保留 Electron 本地化标签):
 * 原生角色调 setFullScreen,而 simpleFullScreen 下该调用被 AppKit 静默忽略,
 * ⌃⌘F 将无法退出全屏;改为自定义 click 直控 simpleFullScreen,进/退双向可靠。
 */
function patchMacMenu(): void {
  if (macMenuPatched) return
  const current = Menu.getApplicationMenu()
  if (!current) return
  const isToggleFs = (i: MenuItem): boolean =>
    (i.role ?? '').toLowerCase() === 'togglefullscreen'
  let found = false
  const root = new Menu()
  for (const top of current.items) {
    const sub = top.submenu
    if (!found && sub && sub.items.some(isToggleFs)) {
      // 仅重建含 togglefullscreen 的子菜单(视图菜单),其余项原样复用
      const newSub = new Menu()
      for (const it of sub.items) {
        if (isToggleFs(it)) {
          found = true
          newSub.append(
            new MenuItem({
              label: it.label, // 复用 Electron 本地化标签(Enter Full Screen 等)
              accelerator: 'Ctrl+Cmd+F',
              click: () => toggleMacFullScreen()
            })
          )
        } else {
          newSub.append(it)
        }
      }
      root.append(new MenuItem({ label: top.label, submenu: newSub }))
    } else {
      root.append(top)
    }
  }
  if (found) {
    Menu.setApplicationMenu(root)
    macMenuPatched = true
    console.log('[fullscreen] 应用菜单 togglefullscreen 已替换为 simpleFullScreen 切换(⌃⌘F)')
  }
}

/** macOS:拦截原生全屏(绿灯 / ⌃⌘F / Window 菜单同一事件入口)收敛 simpleFullScreen */
function wireMac(win: BrowserWindow, restoreSimpleFullScreen: boolean): void {
  const normalTitle = win.getTitle()
  macTarget = { win, normalTitle }
  win.on('closed', () => {
    if (macTarget?.win === win) macTarget = null
  })
  patchMacMenu()
  /** 收敛进行中(enter → setFullScreen(false) → leave 的窗口期,防重入/防循环) */
  let redirecting = false
  /** leave-full-screen 后的目标态:true 进入 simpleFullScreen,false 退出 */
  let targetSimple = false

  win.on('enter-full-screen', () => {
    // 仅拦原生态:isFullScreen() 为 false 说明事件源自 simpleFullScreen 切换(忽略)
    if (!win.isFullScreen() || redirecting) return
    redirecting = true
    // 已处于 simpleFullScreen 时再次触发(绿灯 / ⌃⌘F)= 请求退出全屏
    targetSimple = !win.isSimpleFullScreen()
    win.setTitle('') // 原生全屏瞬态期间同样不给原生条留标题
    console.log(`[fullscreen] 拦截原生全屏 → 收敛 simpleFullScreen(target=${targetSimple})`)
    // windowDidEnterFullScreen 后稍作延迟再退出,避开过渡动画中途调用被 AppKit 忽略
    setTimeout(() => {
      if (!win.isDestroyed()) win.setFullScreen(false)
    }, 120)
  })

  win.on('leave-full-screen', () => {
    if (!redirecting) return
    redirecting = false
    const target = targetSimple
    // 退出动画结束后再切 simpleFullScreen(无原生过渡,小延迟保证帧稳定)
    setTimeout(() => applySimpleFullScreen(win, target, normalTitle), 80)
  })

  // 会话恢复:上次退出时处于 simpleFullScreen → show 后直接进入
  if (restoreSimpleFullScreen) {
    win.once('show', () => {
      setTimeout(() => applySimpleFullScreen(win, true, normalTitle), 80)
    })
  }
}

/** Windows/Linux:F11 原生全屏切换 + 全屏态广播(其余行为不变) */
function wireOther(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.key === 'F11' &&
      !input.alt &&
      !input.control &&
      !input.meta &&
      !input.shift
    ) {
      event.preventDefault()
      win.setFullScreen(!win.isFullScreen())
    }
  })
  win.on('enter-full-screen', () => broadcast(win))
  win.on('leave-full-screen', () => broadcast(win))
}

/**
 * dev 冒烟(PIXELBOX_SMOKE_FS=1,无 UI 驱动环境;与 PIXELBOX_SMOKE_SESSION 同风格):
 * 0. 归一起点:上次会话可能恢复了 simpleFullScreen/最大化(崩溃残留),先退出并
 *    设定已知矩形,保证断言从确定的窗口态出发
 * 1. setFullScreen(true) 模拟原生全屏请求(绿灯 / 菜单进入同一事件入口)
 *    → 断言最终态 isSimpleFullScreen()===true 且 isFullScreen()===false
 * 2. simpleFullScreen 下再调 setFullScreen(true) → 断言被 AppKit 静默忽略不破坏状态
 *    (这正是菜单项必须替换的原因,见 patchMacMenu)
 * 3. 经 toggleMacFullScreen()(⌃⌘F/菜单替换项的同一代码路径)退出
 *    → 断言回窗口态且 bounds 恢复
 * 全程打印 [fullscreen] 日志证据;失败置 process.exitCode=1;结束 app.quit() 杀净。
 */
export function runFullscreenSmoke(win: BrowserWindow): void {
  // 冒烟验证的是 macOS simpleFullScreen 收敛方案;其他平台(F11 原生全屏)直接跳过
  if (process.platform !== 'darwin') {
    console.log('[fullscreen] SMOKE SKIP(仅 macOS;Win/Linux 为 F11 原生全屏)')
    setTimeout(() => app.quit(), 1000)
    return
  }
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (cond()) return true
      await delay(100)
    }
    return cond()
  }
  let failed = 0
  const assert = (label: string, pass: boolean): void => {
    if (pass) console.log(`[fullscreen] ✓ ${label}`)
    else {
      failed++
      process.exitCode = 1
      console.error(`[fullscreen] ✗ ${label}`)
    }
  }
  const fmt = (): string => `simple=${win.isSimpleFullScreen()} native=${win.isFullScreen()}`

  void (async () => {
    await delay(1500) // 等窗口显示与首帧稳定
    // 步骤 0:归一起点(上次会话残留的 simpleFullScreen/最大化先行退出)
    if (win.isSimpleFullScreen()) {
      console.log('[fullscreen] smoke: 起点处于 simpleFullScreen(会话恢复)→ 先经切换入口退出')
      toggleMacFullScreen()
      await waitFor(() => !win.isSimpleFullScreen(), 8000)
      await delay(400)
    }
    if (win.isMaximized()) {
      win.unmaximize()
      await delay(400)
    }
    win.setBounds({ x: 80, y: 80, width: 1200, height: 800 })
    await delay(400)
    const before = win.getBounds()
    console.log(`[fullscreen] smoke: 模拟原生全屏请求 setFullScreen(true) bounds=${JSON.stringify(before)}`)
    win.setFullScreen(true)
    await waitFor(() => win.isSimpleFullScreen() && !win.isFullScreen(), 12000)
    await delay(400) // 稳态确认(不再有后续过渡)
    console.log(`[fullscreen] state=${fmt()}(期望 simple=true native=false)`)
    assert('原生全屏请求收敛为 simpleFullScreen', win.isSimpleFullScreen() && !win.isFullScreen())

    await delay(800)
    console.log('[fullscreen] smoke: simpleFullScreen 下调 setFullScreen(true)(应被 AppKit 忽略)')
    win.setFullScreen(true)
    await delay(1200)
    console.log(`[fullscreen] state=${fmt()}(期望保持 simple=true native=false)`)
    assert('simpleFullScreen 下原生入口惰性不破坏状态', win.isSimpleFullScreen() && !win.isFullScreen())

    console.log('[fullscreen] smoke: 经 toggleMacFullScreen()(⌃⌘F/菜单同一入口)退出全屏')
    toggleMacFullScreen()
    await waitFor(() => !win.isSimpleFullScreen() && !win.isFullScreen(), 12000)
    await delay(400)
    const after = win.getBounds()
    console.log(`[fullscreen] state=${fmt()} bounds=${JSON.stringify(after)}(期望回窗口态且恢复)`)
    assert('切换入口退出全屏回窗口态', !win.isSimpleFullScreen() && !win.isFullScreen())
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= 8
    assert(
      'bounds 恢复到进入前矩形',
      near(before.x, after.x) &&
        near(before.y, after.y) &&
        near(before.width, after.width) &&
        near(before.height, after.height)
    )

    console.log(failed === 0 ? '[fullscreen] SMOKE PASS' : `[fullscreen] SMOKE FAIL(${failed} 项)`)
    app.quit()
  })()
}
