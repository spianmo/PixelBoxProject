/**
 * 工具窗视图模式(五态,JetBrains 式)—— 状态 + 持久化 + 菜单构建(阶段 2/2)
 *
 * 五态:
 * - dockPinned    停靠固定(默认):占据停靠槽位,挤压编辑器布局
 * - dockUnpinned  停靠自动隐藏:以覆盖层浮出(不挤压布局),点外部自动收起(轨道图标豁免)
 * - undock        取消停靠:同覆盖层但常驻,直至轨道图标切换或改模式
 * - float         浮动:FloatPanel 可拖拽/八向 resize 浮窗,位置尺寸记忆
 * - window        独立窗口:main 进程 BrowserWindow(仅 terminal/build 白名单),
 *                 关闭后自动回 dockPinned;window 态不跨 IDE 重启持久化,
 *                 但 renderer 重载后经 toolwindow:list 对账恢复
 *
 * 持久化:localStorage 按工具窗 id 记模式与 Float 矩形(拖拽期间 300ms 去抖落盘)。
 * 切模式布局平滑复位:rAF 派发 window resize(Monaco automaticLayout / SimPanel
 * ResizeObserver 兜底联动)+ 全部终端 fit。
 */
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { createStore, type Store } from '../device-sim/store'
import { fitAllTerms } from '../terminal/xtermRegistry'
import type { DropdownItem } from './Dropdown'
import type { MenuItem } from '../components/ContextMenu'

// ---------------------------------------------------------------
// 类型
// ---------------------------------------------------------------

export type ToolWindowViewMode = 'dockPinned' | 'dockUnpinned' | 'undock' | 'float' | 'window'

/**
 * 工具窗 id(轨道图标粒度):
 * 'build' 为底部日志窗的「构建」tab 在独立窗口场景下的虚拟 id(无停靠槽位,
 * 仅 window 模式有意义;日志窗容器本身的停靠/浮动模式记在 'logs' 名下)
 */
export type ToolWindowId =
  | 'project'
  | 'structure'
  | 'devices'
  | 'running'
  | 'logs'
  | 'terminal'
  | 'build'

/** 菜单展示顺序(与 JetBrains View Mode 一致) */
export const VIEW_MODES: readonly ToolWindowViewMode[] = [
  'dockPinned',
  'dockUnpinned',
  'undock',
  'float',
  'window'
]

/** 支持「独立窗口」的工具窗(与 main/toolWindows.ts 白名单一致) */
export const WINDOWABLE: ReadonlySet<ToolWindowId> = new Set<ToolWindowId>(['terminal', 'build'])

export interface FloatRect {
  x: number
  y: number
  w: number
  h: number
}

interface ViewModeState {
  modes: Record<ToolWindowId, ToolWindowViewMode>
  floatRects: Partial<Record<ToolWindowId, FloatRect>>
}

// ---------------------------------------------------------------
// 持久化(localStorage)
// ---------------------------------------------------------------

const KEY = 'pixelbox-sim.toolwindow-view-modes'

const ALL_IDS: readonly ToolWindowId[] = [
  'project',
  'structure',
  'devices',
  'running',
  'logs',
  'terminal',
  'build'
]

const VALID_MODES = new Set<string>(VIEW_MODES)

function defaultModes(): Record<ToolWindowId, ToolWindowViewMode> {
  const m = {} as Record<ToolWindowId, ToolWindowViewMode>
  for (const id of ALL_IDS) m[id] = 'dockPinned'
  return m
}

/** 读取持久化状态(损坏项回默认;window 态启动降级 dockPinned,再经对账恢复) */
function loadPersisted(): ViewModeState {
  const modes = defaultModes()
  const floatRects: Partial<Record<ToolWindowId, FloatRect>> = {}
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as {
      modes?: Record<string, unknown>
      floatRects?: Record<string, unknown>
    }
    for (const id of ALL_IDS) {
      const m = raw.modes?.[id]
      if (typeof m === 'string' && VALID_MODES.has(m)) {
        // 独立窗口不跨重启恢复(窗口已不在);renderer 重载场景由 initViewModes 对账
        modes[id] = m === 'window' ? 'dockPinned' : (m as ToolWindowViewMode)
      }
      const r = raw.floatRects?.[id] as Partial<FloatRect> | undefined
      if (
        r &&
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.w === 'number' &&
        typeof r.h === 'number'
      ) {
        floatRects[id] = { x: r.x, y: r.y, w: r.w, h: r.h }
      }
    }
  } catch {
    // 损坏的存储:重置为默认
  }
  return { modes, floatRects }
}

export const viewModeStore: Store<ViewModeState> = createStore<ViewModeState>(loadPersisted())

function persist(): void {
  localStorage.setItem(KEY, JSON.stringify(viewModeStore.get()))
}

/** Float 拖拽期间高频更新:300ms 去抖落盘 */
let persistTimer: number | null = null
function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    persist()
  }, 300)
}

// ---------------------------------------------------------------
// 读取 / 变更
// ---------------------------------------------------------------

export function useViewModes(): Record<ToolWindowId, ToolWindowViewMode> {
  return useSyncExternalStore(viewModeStore.subscribe, () => viewModeStore.get().modes)
}

export function getViewMode(id: ToolWindowId): ToolWindowViewMode {
  return viewModeStore.get().modes[id]
}

/**
 * 切换视图模式:
 * - window:仅白名单;IPC 打开独立窗口(已开则聚焦)
 * - 离开 window:IPC 关闭对应独立窗口
 * - 任意切换后 rAF 布局平滑复位
 */
export function setViewMode(id: ToolWindowId, mode: ToolWindowViewMode): void {
  const st = viewModeStore.get()
  const prev = st.modes[id]
  if (mode === 'window') {
    if (!WINDOWABLE.has(id)) return
    // 再次选择「独立窗口」= 聚焦既有窗口(main 侧幂等)
    void window.api.toolwindowOpen(id as 'terminal' | 'build').catch(() => undefined)
  } else if (prev === 'window') {
    void window.api.toolwindowClose(id as 'terminal' | 'build').catch(() => undefined)
  }
  if (prev !== mode) {
    viewModeStore.set({ modes: { ...st.modes, [id]: mode } })
    persist()
  }
  scheduleLayoutRefresh()
}

/**
 * 切模式后的布局平滑复位:rAF 派发 resize(Monaco automaticLayout、SimPanel
 * ResizeObserver 均会联动)+ 终端 fit;再补一帧覆盖 overlay/float 首帧挂载
 */
export function scheduleLayoutRefresh(): void {
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'))
    fitAllTerms()
    requestAnimationFrame(() => fitAllTerms())
  })
}

// ---------------------------------------------------------------
// Float 矩形记忆
// ---------------------------------------------------------------

/** 读取浮动面板矩形(无记忆时给屏幕居中的默认尺寸) */
export function getFloatRect(id: ToolWindowId): FloatRect {
  const r = viewModeStore.get().floatRects[id]
  if (r) return r
  const w = Math.min(720, Math.max(360, Math.floor(window.innerWidth * 0.5)))
  const h = Math.min(440, Math.max(240, Math.floor(window.innerHeight * 0.45)))
  return {
    x: Math.floor((window.innerWidth - w) / 2),
    y: Math.floor((window.innerHeight - h) / 2),
    w,
    h
  }
}

export function setFloatRect(id: ToolWindowId, rect: FloatRect): void {
  const st = viewModeStore.get()
  viewModeStore.set({ floatRects: { ...st.floatRects, [id]: rect } })
  schedulePersist()
}

// ---------------------------------------------------------------
// 初始化(主窗一次):独立窗口关闭回 Dock Pinned + 重载对账
// ---------------------------------------------------------------

let initialized = false

export function initViewModes(): void {
  if (initialized) return
  initialized = true

  // 独立窗口被关闭(✕ / IPC / 主窗关闭级联)→ 该工具窗回 Dock Pinned
  window.api.onToolWindowClosed((ev) => {
    const st = viewModeStore.get()
    const id = ev.id as ToolWindowId
    if (st.modes[id] === 'window') {
      viewModeStore.set({ modes: { ...st.modes, [id]: 'dockPinned' } })
      persist()
      scheduleLayoutRefresh()
    }
  })

  // renderer 重载对账:main 侧仍开着的独立窗口恢复 window 态(不落盘)
  void window.api
    .toolwindowList()
    .then((ids) => {
      if (ids.length === 0) return
      const st = viewModeStore.get()
      const modes = { ...st.modes }
      for (const id of ids) {
        if ((ALL_IDS as readonly string[]).includes(id)) modes[id as ToolWindowId] = 'window'
      }
      viewModeStore.set({ modes })
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------
// 视图模式菜单构建(⋮ 下拉 + 头部右键,两种菜单组件共用)
// ---------------------------------------------------------------

const MODE_LABEL_KEY: Record<ToolWindowViewMode, string> = {
  dockPinned: 'toolwindow.modeDockPinned',
  dockUnpinned: 'toolwindow.modeDockUnpinned',
  undock: 'toolwindow.modeUndock',
  float: 'toolwindow.modeFloat',
  window: 'toolwindow.modeWindow'
}

export interface ViewModeMenus {
  /** 头部 ⋮ 菜单项(Dropdown MenuButton) */
  dropdown: DropdownItem[]
  /** 头部右键菜单项(ContextMenu) */
  context: MenuItem[]
}

/**
 * 构建「视图模式」菜单(当前模式打勾;「独立窗口」不支持时置灰 + tooltip)
 * @param toolId       工具窗 id(null = 不启用视图模式菜单,返回空)
 * @param windowToolId 「独立窗口」项作用的 id(底部日志窗 构建 tab → 'build';缺省同 toolId)
 * @param windowEnabled「独立窗口」可用性覆盖(日志窗仅 构建 tab 激活时可用)
 */
export function useViewModeMenus(
  toolId: ToolWindowId | null,
  opts?: { windowToolId?: ToolWindowId; windowEnabled?: boolean }
): ViewModeMenus {
  const { t } = useTranslation()
  const modes = useViewModes()
  if (!toolId) return { dropdown: [], context: [] }

  const winId = opts?.windowToolId ?? toolId
  const windowEnabled = opts?.windowEnabled ?? WINDOWABLE.has(winId)

  const entries = VIEW_MODES.map((mode) => {
    const isWindow = mode === 'window'
    const targetId = isWindow ? winId : toolId
    return {
      mode,
      targetId,
      label: t(MODE_LABEL_KEY[mode]),
      // 「独立窗口」项按 windowToolId 打勾(构建输出镜像窗开着时亦体现)
      checked: isWindow ? modes[winId] === 'window' : modes[toolId] === mode,
      disabled: isWindow && !windowEnabled,
      title: isWindow && !windowEnabled ? t('toolwindow.windowUnsupported') : undefined
    }
  })

  return {
    dropdown: entries.map((e) => ({
      key: `vm-${e.mode}`,
      label: e.label,
      group: t('toolwindow.viewMode'),
      checked: e.checked,
      disabled: e.disabled,
      title: e.title,
      onSelect: () => setViewMode(e.targetId, e.mode)
    })),
    context: entries.map((e) => ({
      label: e.label,
      group: t('toolwindow.viewMode'),
      checked: e.checked,
      disabled: e.disabled,
      title: e.title,
      onClick: () => setViewMode(e.targetId, e.mode)
    }))
  }
}
