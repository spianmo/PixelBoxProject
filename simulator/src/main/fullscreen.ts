/**
 * 窗口全屏行为(main 进程)—— macOS 全屏收敛为「伪全屏」(IDEA 观感对齐)
 *
 * 需求(用户反馈,对齐 IntelliJ IDEA 全屏观感):全屏时系统菜单栏保持可见(用户
 * macOS 设置在全屏下显示菜单栏),菜单栏之下直接是应用自绘标题栏,红绿灯在标题栏
 * 行内常驻可见,无任何系统灰色标题条。
 *
 * 方案取舍(均经真实 mac 截屏像素断言,scripts/fullscreen-visual-check.mjs):
 * - v2.4 的 simpleFullScreen:系统菜单栏被隐藏、红绿灯不显示 → 废弃(本次重做);
 * - 原生全屏 setFullScreen(方案 A,实测):hiddenInset 透明标题栏在全屏 Space
 *   渲染正确(菜单栏下第一行即自绘标题栏色,无灰条),但 AppKit 会把红绿灯移入
 *   顶部悬停显示条(NSToolbarFullScreenWindow),常驻不可见;
 *   setWindowButtonVisibility(true) 亦无效(截屏三色 0 像素命中)→ 不达标;
 * - 伪全屏(方案 B,本实现):自管理全屏态 —— 记录原 bounds,setBounds 到窗口
 *   所在显示器 workArea(菜单栏之下,多显示器按窗口位置取),窗口置前 + 禁移动/
 *   缩放;窗口保持普通态,红绿灯天然常驻(hiddenInset 位 x:12,y:10),菜单栏
 *   始终可见,无灰条。与 IDEA 的已知差异:非独立 Space;Dock 未设自动隐藏时
 *   仍占据 workArea 边缘(如实差异,见 README 手测章节)。
 *
 * 入口统一:
 * - 绿灯/系统菜单触发的原生全屏 → enter-full-screen 拦截,立即 setFullScreen(false),
 *   leave-full-screen 后切伪全屏(redirecting guard 防重入;瞬态期间 setTitle('')
 *   防原生条残留文字);伪全屏中再点绿灯 = 同一拦截流程 → 退出伪全屏
 * - ⌃⌘F / 菜单「切换全屏」:默认 togglefullscreen 角色走原生全屏(会有一次原生
 *   过渡动画再被拦回),故替换为自定义 click(保留 Electron 本地化标签与 ⌃⌘F
 *   加速键)直控伪全屏切换,进/退双向即时
 * - Windows/Linux 行为不变:F11 原生全屏(before-input-event 接线)
 *
 * renderer 接线:win:is-fullscreen 查询 + win:fullscreen 广播(TitleBar 全屏下
 * 禁用拖拽区等样式微调);持久化经 windowState.ts 的 fullscreen 位(兼容读取旧
 * simpleFullScreen 字段),启动恢复由 index.ts 传 restoreFullScreen(会话恢复语义)。
 */
import { app, ipcMain, BrowserWindow, Menu, MenuItem, screen, type Rectangle } from 'electron'

/** 伪全屏态(仅 macOS 主窗):进入前的还原信息 */
interface PseudoFsState {
  /** 进入前普通态矩形(最大化时为 getNormalBounds 还原矩形) */
  prevBounds: Rectangle
  /** 进入前处于最大化(退出时还原) */
  prevMaximized: boolean
}
const pseudoFs = new WeakMap<BrowserWindow, PseudoFsState>()

/** 当前窗口是否处于 macOS 伪全屏(windowState.ts 持久化判定用) */
export function isPseudoFullScreen(win: BrowserWindow): boolean {
  return pseudoFs.has(win)
}

/** 当前是否处于「全屏」(macOS 伪全屏 / 各平台原生全屏) */
function isFullScreenState(win: BrowserWindow): boolean {
  return win.isFullScreen() || pseudoFs.has(win)
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
  /** 上次退出时处于全屏(windowState 落盘;含旧 simpleFullScreen 字段兼容):show 后恢复 */
  restoreFullScreen?: boolean
}

/**
 * 主窗全屏行为接线:
 * - macOS:原生全屏全入口收敛伪全屏(见文件头)
 * - Windows/Linux:F11 切换原生全屏(既有行为补齐,不改其余语义)
 */
export function wireFullscreen(win: BrowserWindow, opts?: WireFullscreenOptions): void {
  if (process.platform === 'darwin') wireMac(win, opts?.restoreFullScreen === true)
  else wireOther(win)
}

/**
 * 进入/退出伪全屏:
 * - 进入:记录还原信息(先置 WeakMap,windowState 的 move/resize 回调按全屏态处理,
 *   不覆写普通态矩形)→ 取消最大化 → setBounds 到窗口所在显示器 workArea
 *   (菜单栏之下;Dock 未自动隐藏时不含 Dock 区)→ 置前 + 禁移动
 *   (注意不可 setResizable(false):macOS 会连带禁用绿灯按钮 —— 变灰且不可点,
 *   实测截屏绿灯像素为灰 (115,116,118);保持 resizable 绿灯才是彩色可点的退出入口)
 * - 退出:恢复可移动 → 还原进入前矩形与最大化态
 */
export function applyPseudoFullScreen(win: BrowserWindow, on: boolean): void {
  if (win.isDestroyed() || on === pseudoFs.has(win)) return
  if (on) {
    pseudoFs.set(win, { prevBounds: win.getNormalBounds(), prevMaximized: win.isMaximized() })
    if (win.isMaximized()) win.unmaximize()
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea
    win.setMovable(false)
    win.setBounds(workArea)
    win.moveTop()
  } else {
    const st = pseudoFs.get(win)
    pseudoFs.delete(win)
    win.setMovable(true)
    if (st) {
      win.setBounds(st.prevBounds)
      if (st.prevMaximized) win.maximize()
    }
  }
  console.log(
    `[fullscreen] state=pseudo:${pseudoFs.has(win)} native:${win.isFullScreen()}` +
      ` bounds=${JSON.stringify(win.getBounds())}`
  )
  broadcast(win)
}

/** ⌃⌘F / 菜单「切换全屏」目标窗(仅主窗;设置窗/独立工具窗不具全屏能力) */
let macTarget: { win: BrowserWindow; normalTitle: string } | null = null
/** 应用菜单只替换一次(activate 重建主窗时不重复) */
let macMenuPatched = false

/**
 * ⌃⌘F / 菜单「切换全屏」统一入口:窗口态 → 进伪全屏;已全屏 → 退出。
 * 聚焦在设置窗/独立工具窗时不生效(维持这些窗口不受全屏方案影响的语义)。
 */
export function toggleMacFullScreen(): void {
  const t = macTarget
  if (!t || t.win.isDestroyed()) return
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && focused !== t.win) return
  // 原生全屏瞬态(enter→leave 收敛进行中)忽略,避免与拦截流程竞争
  if (t.win.isFullScreen()) return
  applyPseudoFullScreen(t.win, !pseudoFs.has(t.win))
}

/**
 * 替换默认应用菜单的 togglefullscreen 角色项(保留 Electron 本地化标签):
 * 原生角色调 setFullScreen 会先走一遍原生全屏过渡动画再被 enter-full-screen
 * 拦截弹回;改为自定义 click 直控伪全屏切换,进/退双向即时无动画闪烁。
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
    console.log('[fullscreen] 应用菜单 togglefullscreen 已替换为伪全屏切换(⌃⌘F)')
  }
}

/** macOS:拦截原生全屏(绿灯 / Window 菜单同一事件入口)收敛伪全屏 */
function wireMac(win: BrowserWindow, restoreFullScreen: boolean): void {
  const normalTitle = win.getTitle()
  macTarget = { win, normalTitle }
  win.on('closed', () => {
    if (macTarget?.win === win) macTarget = null
  })
  patchMacMenu()
  /** 收敛进行中(enter → setFullScreen(false) → leave 的窗口期,防重入/防循环) */
  let redirecting = false
  /** leave-full-screen 后的目标态:true 进入伪全屏,false 退出 */
  let targetPseudo = false

  win.on('enter-full-screen', () => {
    // 双保险:isFullScreen() 为 false 的异常事件忽略
    if (!win.isFullScreen() || redirecting) return
    redirecting = true
    // 伪全屏中再触发(绿灯)= 请求退出全屏
    targetPseudo = !pseudoFs.has(win)
    win.setTitle('') // 原生全屏瞬态期间不给原生条留标题
    console.log(`[fullscreen] 拦截原生全屏 → 收敛伪全屏(target=${targetPseudo})`)
    // windowDidEnterFullScreen 后稍作延迟再退出,避开过渡动画中途调用被 AppKit 忽略
    setTimeout(() => {
      if (!win.isDestroyed()) win.setFullScreen(false)
    }, 120)
  })

  win.on('leave-full-screen', () => {
    if (!redirecting) return
    redirecting = false
    const target = targetPseudo
    // 退出动画结束后再切伪全屏(小延迟保证 bounds 已回普通态、帧稳定)
    setTimeout(() => {
      if (win.isDestroyed()) return
      win.setTitle(normalTitle) // 瞬态置空的标题恢复
      applyPseudoFullScreen(win, target)
    }, 80)
  })

  // 会话恢复:上次退出时处于全屏 → show 后直接进入伪全屏
  if (restoreFullScreen) {
    win.once('show', () => {
      setTimeout(() => applyPseudoFullScreen(win, true), 80)
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true
    await delay(100)
  }
  return cond()
}
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 8
const nearRect = (a: Rectangle, b: Rectangle): boolean =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height)

/** 冒烟起点归一:退出上次会话残留的伪全屏/最大化,回到确定的窗口矩形 */
async function smokeNormalize(win: BrowserWindow): Promise<void> {
  if (pseudoFs.has(win)) {
    console.log('[fullscreen] smoke: 起点处于伪全屏(会话恢复)→ 先经切换入口退出')
    toggleMacFullScreen()
    await delay(400)
  }
  if (win.isMaximized()) {
    win.unmaximize()
    await delay(400)
  }
  win.setBounds({ x: 80, y: 80, width: 1200, height: 800 })
  await delay(400)
}

/**
 * dev 冒烟(PIXELBOX_SMOKE_FS=1,无 UI 驱动环境;与 PIXELBOX_SMOKE_SESSION 同风格):
 * 0. 归一起点:退出上次会话残留的伪全屏/最大化,设定已知矩形
 * 1. setFullScreen(true) 模拟原生全屏请求(绿灯 / 系统菜单同一事件入口)
 *    → 断言收敛为伪全屏:native=false 且 pseudo=true
 * 2. 断言伪全屏 bounds ≈ 窗口所在显示器 workArea(菜单栏之下,红绿灯保持普通态可见)
 * 3. 经 toggleMacFullScreen()(⌃⌘F/菜单替换项的同一代码路径)退出 → 断言回窗口态
 * 4. 断言 bounds 恢复到进入前矩形
 * 全程打印 [fullscreen] 日志证据;失败置 process.exitCode=1;结束 app.quit() 杀净。
 */
export function runFullscreenSmoke(win: BrowserWindow): void {
  // 冒烟验证的是 macOS 伪全屏收敛方案;其他平台(F11 原生全屏)直接跳过
  if (process.platform !== 'darwin') {
    console.log('[fullscreen] SMOKE SKIP(仅 macOS;Win/Linux 为 F11 原生全屏)')
    setTimeout(() => app.quit(), 1000)
    return
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
  const fmt = (): string => `pseudo=${pseudoFs.has(win)} native=${win.isFullScreen()}`

  void (async () => {
    await delay(1500) // 等窗口显示与首帧稳定
    await smokeNormalize(win)
    const before = win.getBounds()
    console.log(`[fullscreen] smoke: 模拟原生全屏请求 setFullScreen(true) bounds=${JSON.stringify(before)}`)
    win.setFullScreen(true)
    await waitFor(() => pseudoFs.has(win) && !win.isFullScreen(), 12000)
    await delay(400) // 稳态确认(不再有后续过渡)
    console.log(`[fullscreen] state=${fmt()}(期望 pseudo=true native=false)`)
    assert('原生全屏请求收敛为伪全屏', pseudoFs.has(win) && !win.isFullScreen())

    const workArea = screen.getDisplayMatching(win.getBounds()).workArea
    const fsBounds = win.getBounds()
    console.log(
      `[fullscreen] smoke: bounds=${JSON.stringify(fsBounds)} workArea=${JSON.stringify(workArea)}`
    )
    assert('伪全屏 bounds ≈ 所在显示器 workArea(菜单栏之下)', nearRect(fsBounds, workArea))

    await delay(800)
    console.log('[fullscreen] smoke: 经 toggleMacFullScreen()(⌃⌘F/菜单同一入口)退出全屏')
    toggleMacFullScreen()
    await waitFor(() => !pseudoFs.has(win) && !win.isFullScreen(), 12000)
    await delay(400)
    const after = win.getBounds()
    console.log(`[fullscreen] state=${fmt()} bounds=${JSON.stringify(after)}(期望回窗口态且恢复)`)
    assert('切换入口退出全屏回窗口态', !pseudoFs.has(win) && !win.isFullScreen())
    assert('bounds 恢复到进入前矩形', nearRect(before, after))

    console.log(failed === 0 ? '[fullscreen] SMOKE PASS' : `[fullscreen] SMOKE FAIL(${failed} 项)`)
    app.quit()
  })()
}

/**
 * dev 视觉冒烟(PIXELBOX_SMOKE_FS_VISUAL=1,配套 scripts/fullscreen-visual-check.mjs):
 * 与外部脚本经 stdout 标记行 + 哨兵文件协作 ——
 * 1. 归一起点后把窗口挪到主显示器(截屏脚本固定截主显示器),经绿灯同一入口进伪全屏;
 * 2. 稳态后打印 [fs-visual] entered <json>(workArea/bounds/scaleFactor/主题标题栏色/
 *    红绿灯 hiddenInset 位),外部脚本据此截屏做像素断言;
 * 3. 轮询哨兵文件(PIXELBOX_SMOKE_FS_EXIT_FILE)出现 → 退出伪全屏 → 打印
 *    [fs-visual] exited <json>(含 bounds 恢复断言结果)→ app.quit()。
 */
export function runFullscreenVisualSmoke(win: BrowserWindow): void {
  if (process.platform !== 'darwin') {
    console.log('[fs-visual] SKIP(仅 macOS)')
    setTimeout(() => app.quit(), 1000)
    return
  }
  const exitFile = process.env.PIXELBOX_SMOKE_FS_EXIT_FILE || '/tmp/pb-fs-visual-exit'
  void (async () => {
    const { existsSync } = await import('node:fs')
    const { effectiveTheme } = await import('./theme')
    await delay(1500)
    await smokeNormalize(win)
    // 挪到主显示器工作区内(多显示器环境下外部截屏固定截主显示器)
    const primary = screen.getPrimaryDisplay()
    win.setBounds({
      x: primary.workArea.x + 40,
      y: primary.workArea.y + 40,
      width: 1200,
      height: 800
    })
    await delay(400)
    const before = win.getBounds()
    // 置前抢焦:保证伪全屏窗口位于最上层且红绿灯为激活彩色态
    app.focus({ steal: true })
    win.focus()
    console.log('[fs-visual] 模拟原生全屏请求 setFullScreen(true)(绿灯同一入口)')
    win.setFullScreen(true)
    await waitFor(() => pseudoFs.has(win) && !win.isFullScreen(), 12000)
    await delay(1500) // 等过渡与首帧稳定,外部脚本此后截屏
    app.focus({ steal: true })
    win.moveTop()
    const payload = {
      workArea: screen.getDisplayMatching(win.getBounds()).workArea,
      bounds: win.getBounds(),
      scaleFactor: primary.scaleFactor,
      theme: effectiveTheme(),
      titlebarHex: effectiveTheme() === 'dark' ? '#2B2D30' : '#F7F8FA',
      trafficLight: { x: 12, y: 10 }, // hiddenInset 位(BrowserWindow 构造参数)
      pseudo: pseudoFs.has(win),
      native: win.isFullScreen()
    }
    console.log(`[fs-visual] entered ${JSON.stringify(payload)}`)
    // 保焦 + 自愈:等待外部截屏期间持续置前抢焦(红绿灯须为激活彩色态;外部脚本
    // 动作可能短暂夺焦),且若期间被外部动作(如误触绿灯)踢出伪全屏则自动回进
    const keepFocus = setInterval(() => {
      if (win.isDestroyed() || win.isFullScreen()) return // 原生瞬态期间不干预
      if (!pseudoFs.has(win)) {
        console.log('[fs-visual] 检测到伪全屏被外部动作退出 → 自愈重进')
        applyPseudoFullScreen(win, true)
      }
      app.focus({ steal: true })
      win.moveTop()
    }, 600)
    // 等外部脚本截屏完成(哨兵文件),最长 120s
    await waitFor(() => existsSync(exitFile), 120000)
    clearInterval(keepFocus)
    // 显式退出(不经 toggle:若外部动作已退出则直接跳过),等原生瞬态先归零
    await waitFor(() => !win.isFullScreen(), 8000)
    applyPseudoFullScreen(win, false)
    await waitFor(() => !pseudoFs.has(win) && !win.isFullScreen(), 12000)
    await delay(400)
    const after = win.getBounds()
    const restored = nearRect(before, after)
    console.log(
      `[fs-visual] exited ${JSON.stringify({ before, after, restored, pseudo: pseudoFs.has(win), native: win.isFullScreen() })}`
    )
    app.quit()
  })()
}
