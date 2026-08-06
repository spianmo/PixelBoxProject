/**
 * 窗口状态持久化(main 进程,会话恢复阶段 2)—— 主窗 / 设置窗 / 独立工具窗共用
 *
 * - 单一落盘:userData/pixelbox-sim/window-state.json,按窗口名分键
 *   (main / settings / toolwindow-terminal / toolwindow-build)
 * - trackWindowState():move/resize/最大化变化 → 内存即时记录 + 500ms 去抖落盘;
 *   最大化时以 getNormalBounds() 记录还原矩形,另记 maximized 位与所在显示器 id
 * - windowStateFor():启动还原 —— 校验记录的 bounds 与当前某显示器工作区有效相交
 *   (显示器拔掉 / 分辨率变化的越界校正:丢弃坐标交系统默认摆放,尺寸夹取到工作区内);
 *   受「启动时恢复上次会话」(system.restoreSession)控制,关闭时返回 null 用默认值
 * - flushWindowStates():同步兜底落盘(before-quit + 主窗 close 双保险;
 *   记录不受开关影响 —— 开关随后打开时可立即恢复最近状态)
 */
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSettingsSync } from './settings'
import { isPseudoFullScreen } from './fullscreen'

export interface SavedWindowState {
  /** 非最大化时的窗口矩形(最大化时为还原矩形 getNormalBounds) */
  bounds: Rectangle
  maximized: boolean
  /** macOS 全屏态(伪全屏,fullscreen.ts 收敛;启动经 fullscreen.ts 恢复) */
  fullscreen: boolean
  /** 记录时所在显示器 id(日志参考;越界校正以 bounds 相交判定为准) */
  displayId: number
}

type StateMap = Record<string, SavedWindowState>

function stateFile(): string {
  return join(app.getPath('userData'), 'pixelbox-sim', 'window-state.json')
}

let cache: StateMap | null = null
let dirty = false
let saveTimer: NodeJS.Timeout | null = null

function isRect(v: unknown): v is Rectangle {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.width === 'number' &&
    typeof r.height === 'number' &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    r.width >= 100 &&
    r.height >= 80
  )
}

/** 读取(带缓存;损坏条目丢弃,文件缺失/损坏按空表) */
function load(): StateMap {
  if (cache) return cache
  const out: StateMap = {}
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8')) as Record<string, unknown>
    for (const [name, entry] of Object.entries(raw)) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (!isRect(e.bounds)) continue
      out[name] = {
        bounds: {
          x: Math.round(e.bounds.x),
          y: Math.round(e.bounds.y),
          width: Math.round(e.bounds.width),
          height: Math.round(e.bounds.height)
        },
        maximized: e.maximized === true,
        // 兼容读取 v2.4 的 simpleFullScreen 字段(旧方案已删除,全屏语义迁移)
        fullscreen: e.fullscreen === true || e.simpleFullScreen === true,
        displayId: typeof e.displayId === 'number' ? e.displayId : -1
      }
    }
  } catch {
    // 首次启动 / 文件损坏:空表
  }
  cache = out
  return out
}

function scheduleSave(): void {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushWindowStates()
  }, 500)
}

/** 同步兜底落盘(before-quit / 主窗 close 双保险;去抖计时器一并清理) */
export function flushWindowStates(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!dirty || !cache) return
  dirty = false
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    // 只读文件系统等:静默(窗口状态属尽力而为)
  }
}

/** 两矩形是否有效相交(至少 40px 可见,避免窗口只剩边缘在屏内) */
function visiblyIntersects(a: Rectangle, b: Rectangle): boolean {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return x >= 40 && y >= 40
}

export interface WindowStateDefaults {
  minWidth: number
  minHeight: number
}

export interface RestoredWindowState {
  /** 校正后的矩形;x/y 可能缺省(越界时丢坐标交系统默认摆放) */
  bounds: Partial<Rectangle> & { width: number; height: number }
  maximized: boolean
  /** 上次退出时处于 macOS 全屏(伪全屏;index.ts 经 wireFullscreen 恢复) */
  fullscreen: boolean
}

/**
 * 启动还原:返回校正后的窗口状态;无记录 / 「恢复上次会话」关闭时返回 null(用默认值)。
 * 越界校正:记录矩形与所有显示器工作区均不相交(显示器已拔掉等)→ 丢弃坐标,
 * 尺寸夹取到主显示器工作区内。
 */
export function windowStateFor(name: string, defs: WindowStateDefaults): RestoredWindowState | null {
  if (!getSettingsSync().system.restoreSession) return null
  const saved = load()[name]
  if (!saved) return null

  const primary = screen.getPrimaryDisplay().workArea
  const width = Math.max(defs.minWidth, Math.min(saved.bounds.width, primary.width))
  const height = Math.max(defs.minHeight, Math.min(saved.bounds.height, primary.height))

  const onScreen = screen
    .getAllDisplays()
    .some((d) => visiblyIntersects(saved.bounds, d.workArea))
  const bounds: RestoredWindowState['bounds'] = onScreen
    ? { x: saved.bounds.x, y: saved.bounds.y, width, height }
    : { width, height } // 越界校正:丢坐标(Electron 按系统默认居中摆放)

  console.log(
    `[session-restore] 窗口 "${name}" 还原 bounds=${bounds.x ?? '?'},${bounds.y ?? '?'} ${width}x${height}` +
      ` maximized=${saved.maximized} fullscreen=${saved.fullscreen}` +
      `${onScreen ? '' : '(越界已校正)'}`
  )
  return { bounds, maximized: saved.maximized, fullscreen: saved.fullscreen }
}

/**
 * 跟踪窗口状态:move/resize/最大化 → 内存即时 + 500ms 去抖落盘。
 * 记录不看「恢复上次会话」开关(仅还原受控),开关打开后立即可用。
 */
export function trackWindowState(win: BrowserWindow, name: string): void {
  const update = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    // 原生全屏为瞬态(macOS 由 fullscreen.ts 立即收敛为伪全屏;
    // Win/Linux F11 不持久化):期间的 move/resize 一律不落盘
    if (win.isFullScreen()) return
    const prev = load()[name]
    const fullscreen = process.platform === 'darwin' && isPseudoFullScreen(win)
    if (fullscreen) {
      // 伪全屏铺满 workArea:不覆写普通态矩形(保留进入前记录),仅置全屏位
      load()[name] = {
        bounds: prev?.bounds ?? win.getNormalBounds(),
        maximized: prev?.maximized ?? false,
        fullscreen: true,
        displayId: screen.getDisplayMatching(win.getBounds()).id
      }
    } else {
      const maximized = win.isMaximized()
      load()[name] = {
        // 最大化时记还原矩形(取消最大化 / 下次以普通态启动时用)
        bounds: maximized ? win.getNormalBounds() : win.getBounds(),
        maximized,
        fullscreen: false,
        displayId: screen.getDisplayMatching(win.getBounds()).id
      }
    }
    scheduleSave()
  }
  win.on('move', update)
  win.on('resize', update)
  win.on('maximize', update)
  win.on('unmaximize', update)
  // 关窗前抓最终状态(flush 由 index.ts 的 close/before-quit 双保险统一触发)
  win.on('close', update)
}
