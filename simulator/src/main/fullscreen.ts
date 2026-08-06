/**
 * 窗口全屏行为(main 进程)—— macOS 回归原生全屏 Space(v2.5,native-fullscreen 阶段 1/3)
 *
 * 背景(用户反馈):v2.4.x 的「拦截原生全屏 → 收敛伪全屏」方案,点绿灯后观感是
 * 「进去又被自动退出来」,体验太差 → 本次彻底移除拦截与转换,全部走原生:
 * - 绿灯 / ⌃⌘F / 系统菜单「进入全屏幕」(togglefullscreen 角色恢复 Electron 默认,
 *   不再接管应用菜单)任一入口 = 真正的原生全屏 Space(四指横滑可切换);
 * - 红绿灯在原生全屏下由 AppKit 管理:常驻不可见,鼠标悬停屏幕顶部时随系统工具条
 *   显示 —— 接受该原生行为(与 VS Code 一致);TitleBar 订阅全屏态,原生全屏时取消
 *   80px 红绿灯预留区(内容左移避免空缺),退出恢复(见 TitleBar.tsx);
 * - 全屏下系统菜单栏是否显示跟随系统设置(系统设置 › 控制中心 › 「全屏幕视图下
 *   自动隐藏和显示菜单栏」),应用不干预;
 * - hiddenInset 透明标题栏在全屏 Space 渲染正确:窗口内容顶部第一行即自绘标题栏
 *   主题色,无系统灰条(经 scripts/fullscreen-visual-check.mjs 截屏像素断言)。
 *
 * renderer 接线:win:is-fullscreen 查询 + win:fullscreen 广播(TitleBar 预留区切换);
 * 持久化经 windowState.ts 的 fullscreen 位(记录原生 isFullScreen;兼容读取旧
 * fullscreen/simpleFullScreen 字段),启动恢复由 index.ts 传 restoreFullScreen →
 * ready-to-show(show)之后 setFullScreen(true)。
 *
 * Windows/Linux 行为不变:F11 原生全屏(before-input-event 接线),不持久化。
 */
import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'

/** 全屏态变化 → 推送本窗 renderer(TitleBar 红绿灯预留区切换等样式微调) */
function broadcast(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.webContents.send('win:fullscreen', win.isFullScreen())
}

export function registerFullscreenIpc(): void {
  // 全屏态查询(renderer 挂载时对账一次,后续走 win:fullscreen 订阅)
  ipcMain.handle('win:is-fullscreen', (e): boolean => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? win.isFullScreen() : false
  })
}

export interface WireFullscreenOptions {
  /** 上次退出时处于全屏(windowState 落盘;含旧字段兼容):show 后恢复原生全屏 */
  restoreFullScreen?: boolean
}

/**
 * 主窗全屏行为接线:
 * - macOS:纯原生 —— 仅广播 enter/leave 全屏态 + 会话恢复 setFullScreen(true),
 *   无任何拦截/菜单接管(绿灯与 togglefullscreen 角色走系统默认)
 * - Windows/Linux:F11 切换原生全屏(既有行为不变)
 */
export function wireFullscreen(win: BrowserWindow, opts?: WireFullscreenOptions): void {
  win.on('enter-full-screen', () => {
    console.log(`[fullscreen] enter-full-screen native=${win.isFullScreen()}`)
    broadcast(win)
  })
  win.on('leave-full-screen', () => {
    console.log(`[fullscreen] leave-full-screen bounds=${JSON.stringify(win.getBounds())}`)
    broadcast(win)
  })

  if (process.platform === 'darwin') {
    // 会话恢复:上次退出时处于原生全屏 → show 后 setFullScreen(true)
    // (ready-to-show → index.ts show();稍作延迟等首帧稳定再进全屏 Space)
    if (opts?.restoreFullScreen === true) {
      win.once('show', () => {
        setTimeout(() => {
          if (!win.isDestroyed() && !win.isFullScreen()) {
            console.log('[fullscreen] 会话恢复 → setFullScreen(true)(原生全屏)')
            win.setFullScreen(true)
          }
        }, 120)
      })
    }
  } else {
    // Windows/Linux:F11 原生全屏切换(不持久化)
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
  }
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
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const nearRect = (a: Rectangle, b: Rectangle, tol = 2): boolean =>
  near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.width, b.width, tol) && near(a.height, b.height, tol)

/** 冒烟起点归一:退出上次会话残留的全屏/最大化,回到确定的窗口矩形 */
async function smokeNormalize(win: BrowserWindow): Promise<void> {
  if (win.isFullScreen()) {
    console.log('[fullscreen] smoke: 起点处于原生全屏(会话恢复)→ 先退出')
    win.setFullScreen(false)
    await waitFor(() => !win.isFullScreen(), 12000)
    await delay(600)
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
 * 0. 归一起点:退出上次会话残留的全屏/最大化,设定已知矩形
 * 1. setFullScreen(true)(绿灯/⌃⌘F/系统菜单同一原生入口)→ 断言进入原生全屏:
 *    isFullScreen()===true 且 isSimpleFullScreen()===false(无伪全屏/简单全屏残留)
 * 2. 断言全屏 bounds 铺满所在显示器(宽=屏宽;高≥workArea 高,菜单栏行为跟随系统设置)
 * 3. setFullScreen(false) 退出 → 断言回窗口态且 bounds 精确恢复(原生自行还原窗口框架)
 * 全程打印 [fullscreen] 日志证据;失败置 process.exitCode=1;结束 app.quit() 杀净。
 */
export function runFullscreenSmoke(win: BrowserWindow): void {
  // 冒烟验证的是 macOS 原生全屏;其他平台(F11 原生全屏)直接跳过
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
  const fmt = (): string => `native=${win.isFullScreen()} simple=${win.isSimpleFullScreen()}`

  void (async () => {
    await delay(1500) // 等窗口显示与首帧稳定
    await smokeNormalize(win)
    const before = win.getBounds()
    console.log(
      `[fullscreen] smoke: setFullScreen(true)(绿灯同一原生入口)bounds=${JSON.stringify(before)}`
    )
    win.setFullScreen(true)
    await waitFor(() => win.isFullScreen(), 12000)
    await delay(1500) // 全屏 Space 过渡动画余量
    console.log(`[fullscreen] state=${fmt()}(期望 native=true simple=false)`)
    assert('进入原生全屏(isFullScreen=true)', win.isFullScreen())
    assert('非 simpleFullScreen(伪/简单全屏已移除)', !win.isSimpleFullScreen())

    const disp = screen.getDisplayMatching(win.getBounds())
    const fsBounds = win.getBounds()
    console.log(
      `[fullscreen] smoke: bounds=${JSON.stringify(fsBounds)} display=${JSON.stringify(disp.bounds)}` +
        ` workArea=${JSON.stringify(disp.workArea)}`
    )
    // 菜单栏是否占据顶部跟随系统设置:只断言宽度铺满 + 高度不低于 workArea 高
    assert(
      '全屏 bounds 铺满所在显示器(宽=屏宽,高≥workArea 高)',
      near(fsBounds.width, disp.bounds.width, 2) && fsBounds.height >= disp.workArea.height - 2
    )

    await delay(800)
    console.log('[fullscreen] smoke: setFullScreen(false) 退出原生全屏')
    win.setFullScreen(false)
    await waitFor(() => !win.isFullScreen(), 12000)
    await delay(1200) // 退出过渡动画余量(bounds 恢复到位)
    const after = win.getBounds()
    console.log(`[fullscreen] state=${fmt()} bounds=${JSON.stringify(after)}(期望回窗口态且精确恢复)`)
    assert('退出全屏回窗口态', !win.isFullScreen() && !win.isSimpleFullScreen())
    assert('bounds 精确恢复到进入前矩形(±2px)', nearRect(before, after))

    console.log(failed === 0 ? '[fullscreen] SMOKE PASS' : `[fullscreen] SMOKE FAIL(${failed} 项)`)
    app.quit()
  })()
}

/**
 * dev 视觉冒烟(PIXELBOX_SMOKE_FS_VISUAL=1,配套 scripts/fullscreen-visual-check.mjs):
 * 与外部脚本经 stdout 标记行 + 哨兵文件协作 ——
 * 1. 归一起点后把窗口挪到主显示器(截屏脚本固定截主显示器),setFullScreen(true)
 *    进原生全屏 Space(绿灯同一入口);
 * 2. 稳态后打印 [fs-visual] entered <json>(display/workArea/bounds/scaleFactor/
 *    主题标题栏色/native/simple),外部脚本据此截屏做像素断言;
 * 3. 轮询哨兵文件(PIXELBOX_SMOKE_FS_EXIT_FILE)出现 → setFullScreen(false) 退出 →
 *    打印 [fs-visual] exited <json>(含 bounds 精确恢复断言结果)→ app.quit()。
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
    // 置前抢焦:保证全屏 Space 为当前活动 Space(screencapture 截当前显示内容)
    app.focus({ steal: true })
    win.focus()
    console.log('[fs-visual] setFullScreen(true) 进原生全屏 Space(绿灯同一入口)')
    win.setFullScreen(true)
    await waitFor(() => win.isFullScreen(), 12000)
    await delay(2000) // 等全屏 Space 过渡动画与首帧稳定,外部脚本此后截屏
    app.focus({ steal: true })
    const payload = {
      display: primary.bounds,
      workArea: primary.workArea,
      bounds: win.getBounds(),
      scaleFactor: primary.scaleFactor,
      theme: effectiveTheme(),
      titlebarHex: effectiveTheme() === 'dark' ? '#2B2D30' : '#F7F8FA',
      native: win.isFullScreen(),
      simple: win.isSimpleFullScreen()
    }
    console.log(`[fs-visual] entered ${JSON.stringify(payload)}`)
    // 保焦 + 自愈:等待外部截屏期间保持全屏 Space 活动(外部脚本动作可能短暂夺焦),
    // 若期间被外部动作意外退出全屏则自动回进
    const keepFocus = setInterval(() => {
      if (win.isDestroyed()) return
      if (!win.isFullScreen()) {
        console.log('[fs-visual] 检测到全屏被外部动作退出 → 自愈重进')
        win.setFullScreen(true)
        return
      }
      app.focus({ steal: true })
    }, 600)
    // 等外部脚本截屏完成(哨兵文件),最长 120s
    await waitFor(() => existsSync(exitFile), 120000)
    clearInterval(keepFocus)
    // 退出原生全屏 → 断言 bounds 精确恢复(原生自行还原窗口框架)
    win.setFullScreen(false)
    await waitFor(() => !win.isFullScreen(), 12000)
    await delay(1200) // 退出过渡动画余量
    const after = win.getBounds()
    const restored = nearRect(before, after)
    console.log(
      `[fs-visual] exited ${JSON.stringify({ before, after, restored, native: win.isFullScreen(), simple: win.isSimpleFullScreen() })}`
    )
    app.quit()
  })()
}
