/**
 * 主窗布局持久化(会话恢复阶段 2)—— localStorage
 *
 * 覆盖 App.tsx 的布局 state:左右栏宽 / 底部区高 / 结构分栏高 / 左工具窗选择 /
 * 结构视图与右侧、底部开关 / 底部视图(日志⇄终端)与激活 tab / 终端打开过标记。
 * 其余持久化项各自独立,无需在此重复:
 * - 工具窗五态视图模式 + Float 矩形:shell/viewMode.ts
 * - 终端 split 树形状:terminal/store.ts(会话为新 shell,布局还原)
 * - 目标芯片选择:shell/store.ts;Markdown 查看模式:editor/mdViewMode.ts
 * - 编辑器标签/viewState(按工作区):main sessionState.ts(sessions/ 落盘)
 *
 * 读:App 挂载初值(main.tsx 已等设置镜像就绪,getAppSettings 为真实值);
 *     「启动时恢复上次会话」关闭时返回默认布局(欢迎页语义)。
 * 写:布局 state 变化经 500ms 去抖落盘(变化即写,退出无需额外处理)。
 */
import { getAppSettings } from '../settings/store'
import type { BottomTab } from './LogsToolWindow'

export interface MainLayoutState {
  leftWidth: number
  rightWidth: number
  bottomHeight: number
  structTopHeight: number
  leftTool: 'project' | 'devices' | null
  structureOpen: boolean
  rightOpen: boolean
  bottomOpen: boolean
  bottomView: 'logs' | 'terminal'
  bottomTab: BottomTab
  terminalOpened: boolean
}

/** 默认布局(与 v2.2 的 App.tsx 初值一致;「恢复上次会话」关闭时使用) */
export const DEFAULT_LAYOUT: MainLayoutState = {
  leftWidth: 260,
  rightWidth: 430, // 430 = 368px 屏幕 1x 整数缩放 + 白框与边距(device-sim 需要)
  bottomHeight: 220,
  structTopHeight: 300,
  leftTool: 'project',
  structureOpen: false,
  rightOpen: true,
  bottomOpen: true,
  bottomView: 'logs',
  bottomTab: 'logs',
  terminalOpened: false
}

const KEY = 'pixelbox-sim.main-layout'

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

function oneOf<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback
}

/**
 * 读取上次布局(App 挂载初值)。
 * 「恢复上次会话」关闭 → 默认布局;损坏字段逐项回退默认(区间与联合值校验)。
 */
export function loadMainLayout(): MainLayoutState {
  const d = DEFAULT_LAYOUT
  if (!getAppSettings().system.restoreSession) return { ...d }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, unknown> | null
    if (!raw) return { ...d }
    return {
      // 区间与 App 内 DragHandle 的 clamp 一致(左 180-520 / 右 280-680 / 底 120-480 / 结构 120-640)
      leftWidth: clamp(raw.leftWidth, 180, 520, d.leftWidth),
      rightWidth: clamp(raw.rightWidth, 280, 680, d.rightWidth),
      bottomHeight: clamp(raw.bottomHeight, 120, 480, d.bottomHeight),
      structTopHeight: clamp(raw.structTopHeight, 120, 640, d.structTopHeight),
      leftTool: oneOf(raw.leftTool, ['project', 'devices', null] as const, d.leftTool),
      structureOpen: typeof raw.structureOpen === 'boolean' ? raw.structureOpen : d.structureOpen,
      rightOpen: typeof raw.rightOpen === 'boolean' ? raw.rightOpen : d.rightOpen,
      bottomOpen: typeof raw.bottomOpen === 'boolean' ? raw.bottomOpen : d.bottomOpen,
      bottomView: oneOf(raw.bottomView, ['logs', 'terminal'] as const, d.bottomView),
      bottomTab: oneOf(raw.bottomTab, ['logs', 'build', 'problems'] as const, d.bottomTab),
      terminalOpened: typeof raw.terminalOpened === 'boolean' ? raw.terminalOpened : d.terminalOpened
    }
  } catch {
    return { ...d } // 损坏的存储:回默认布局
  }
}

let saveTimer: number | null = null

/** 布局变化 500ms 去抖落盘(记录不看开关,开关随后打开时立即可恢复) */
export function saveMainLayout(state: MainLayoutState): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // localStorage 不可用:静默(布局恢复属尽力而为)
    }
  }, 500)
}
