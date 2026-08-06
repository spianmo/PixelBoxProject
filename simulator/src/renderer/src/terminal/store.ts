/**
 * 集成终端状态(renderer)—— 会话表 + 二叉分栏树(split 自由拆分拼合)
 *
 * 树模型:叶子 = 会话组(独立 tab 条,组内多会话切换),内部节点 = 分栏
 * (dir: 'row' 左右 / 'column' 上下,ratio 为第一子占比,可任意嵌套)。
 * 组内最后一个 tab 关闭时该组从树中移除,父分栏由兄弟节点顶替(拼合)。
 *
 * xterm 实例常驻 xtermRegistry(React 卸载不销毁),工具窗隐藏再打开不丢会话;
 * shell 进程活在 main 进程 PtyService,renderer 重载后经 terminal:list 恢复。
 */
import { useSyncExternalStore } from 'react'
import { createStore, type Store } from '../device-sim/store'
import type { TerminalBackend, TerminalSessionInfo } from '../../../shared/ipc-types'
import { createTermInstance, disposeTermInstance, writeToTerm } from './xtermRegistry'

// ---------------------------------------------------------------
// 树模型
// ---------------------------------------------------------------

export interface TermGroup {
  kind: 'group'
  id: string
  /** 组内会话 tab(有序) */
  tabs: string[]
  /** 当前激活 tab(空组为 null) */
  active: string | null
}

export interface TermSplit {
  kind: 'split'
  id: string
  /** row = 左右并排(向右拆分),column = 上下(向下拆分) */
  dir: 'row' | 'column'
  /** 第一子占比 0.15–0.85 */
  ratio: number
  a: TermNode
  b: TermNode
}

export type TermNode = TermGroup | TermSplit

export interface TerminalState {
  root: TermNode
  sessions: Record<string, TerminalSessionInfo>
  /** 最近交互的组(header ⋮ 菜单/新建会话的目标) */
  focusedGroup: string
  /** PtyService 后端探测结果(pipe 时 UI 提示体验受限) */
  backend: TerminalBackend | null
  /** 打开搜索条的会话(⌘F;null = 关闭) */
  searchSession: string | null
}

let nodeSeq = 0
const nextNodeId = (): string => `tn-${++nodeSeq}`

function makeGroup(tabs: string[] = []): TermGroup {
  return { kind: 'group', id: nextNodeId(), tabs, active: tabs[tabs.length - 1] ?? null }
}

const initialGroup = makeGroup()

export const terminalStore: Store<TerminalState> = createStore<TerminalState>({
  root: initialGroup,
  sessions: {},
  focusedGroup: initialGroup.id,
  backend: null,
  searchSession: null
})

export function useTerminalStore(): TerminalState {
  return useSyncExternalStore(terminalStore.subscribe, terminalStore.get)
}

// ---------------------------------------------------------------
// 树工具(纯函数,immutable 变换)
// ---------------------------------------------------------------

export function findGroup(node: TermNode, id: string): TermGroup | null {
  if (node.kind === 'group') return node.id === id ? node : null
  return findGroup(node.a, id) ?? findGroup(node.b, id)
}

/** 树中首个组(焦点组失效时兜底) */
export function firstGroup(node: TermNode): TermGroup {
  if (node.kind === 'group') return node
  return firstGroup(node.a)
}

export function allGroups(node: TermNode): TermGroup[] {
  if (node.kind === 'group') return [node]
  return [...allGroups(node.a), ...allGroups(node.b)]
}

/** 定位会话所在组 */
export function groupOfSession(node: TermNode, sessionId: string): TermGroup | null {
  for (const g of allGroups(node)) if (g.tabs.includes(sessionId)) return g
  return null
}

/** 替换指定组(fn 返回新组) */
function updateGroup(node: TermNode, id: string, fn: (g: TermGroup) => TermNode): TermNode {
  if (node.kind === 'group') return node.id === id ? fn(node) : node
  const a = updateGroup(node.a, id, fn)
  const b = updateGroup(node.b, id, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** 从树中移除空组:父分栏由兄弟顶替(拼合);根组不可移除 */
function removeGroup(node: TermNode, id: string): TermNode {
  if (node.kind === 'group') return node // 根即目标组时保留(空的根组合法)
  if (node.a.kind === 'group' && node.a.id === id) return node.b
  if (node.b.kind === 'group' && node.b.id === id) return node.a
  const a = removeGroup(node.a, id)
  const b = removeGroup(node.b, id)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function updateSplit(node: TermNode, id: string, fn: (s: TermSplit) => TermSplit): TermNode {
  if (node.kind === 'group') return node
  if (node.id === id) return fn(node)
  const a = updateSplit(node.a, id, fn)
  const b = updateSplit(node.b, id, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function clampRatio(r: number): number {
  return Math.min(0.85, Math.max(0.15, r))
}

// ---------------------------------------------------------------
// 初始化(幂等):事件订阅 + 后端探测 + 重载恢复
// ---------------------------------------------------------------

let initialized = false
/** 工作区根(App 同步;新会话 cwd) */
let terminalCwd: string | null = null
/** 重载/独立窗口恢复中(ensureSession 等其完成再判空,避免误建多余会话) */
let restorePromise: Promise<void> | null = null

export function setTerminalCwd(root: string | null): void {
  terminalCwd = root
}

export function initTerminals(): void {
  if (initialized) return
  initialized = true

  // 输出流(16ms 批量)→ 对应 xterm
  window.api.onTerminalData((chunks) => {
    for (const c of chunks) writeToTerm(c.id, c.data)
  })

  // 会话退出(✕ 关闭 / 用户键入 exit / 进程崩溃)→ 移除 tab 并拼合树
  window.api.onTerminalExit((ev) => removeSessionLocal(ev.id))

  // 后端探测(pipe 模式 UI 横幅提示)
  void window.api
    .terminalBackend()
    .then((r) => terminalStore.set({ backend: r.backend }))
    .catch(() => undefined)

  // renderer 重载 / 独立终端窗口打开:main 进程仍存活的会话回收进根组
  // (xterm 滚回缓冲不保留;跨窗口共享同一批 PTY 会话,输入输出经 main 广播互通)
  restorePromise = window.api
    .terminalList()
    .then((list) => {
      if (list.length === 0) return
      const st = terminalStore.get()
      const root = firstGroup(st.root)
      const sessions = { ...st.sessions }
      const tabs = [...root.tabs]
      for (const info of list) {
        if (sessions[info.id]) continue
        sessions[info.id] = info
        createTermInstance(info)
        tabs.push(info.id)
      }
      terminalStore.set({
        sessions,
        root: updateGroup(st.root, root.id, (g) => ({
          ...g,
          tabs,
          active: g.active ?? tabs[tabs.length - 1] ?? null
        }))
      })
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------
// 会话动作
// ---------------------------------------------------------------

/** 目标组解析:显式 > 焦点组 > 树中首组 */
function resolveGroup(groupId?: string): TermGroup {
  const st = terminalStore.get()
  if (groupId) {
    const g = findGroup(st.root, groupId)
    if (g) return g
  }
  return findGroup(st.root, st.focusedGroup) ?? firstGroup(st.root)
}

/** 新建会话到指定组(缺省焦点组);返回会话 id,失败 null */
export async function newSession(groupId?: string): Promise<string | null> {
  const target = resolveGroup(groupId)
  let info: TerminalSessionInfo
  try {
    info = await window.api.terminalCreate({ cwd: terminalCwd ?? undefined })
  } catch {
    return null
  }
  createTermInstance(info)
  const st = terminalStore.get()
  terminalStore.set({
    sessions: { ...st.sessions, [info.id]: info },
    root: updateGroup(st.root, target.id, (g) => ({
      ...g,
      tabs: [...g.tabs, info.id],
      active: info.id
    })),
    focusedGroup: target.id,
    backend: info.backend
  })
  return info.id
}

let ensureInFlight: Promise<void> | null = null

/** 工具窗打开时保证至少一个会话(StrictMode 双调用/连点防抖;先等恢复完成再判空) */
export function ensureSession(): void {
  if (ensureInFlight) return
  if (Object.keys(terminalStore.get().sessions).length > 0) return
  ensureInFlight = (restorePromise ?? Promise.resolve())
    .then(() => {
      // 恢复完成后再判空:独立终端窗口打开时主窗已有会话,不再误建
      if (Object.keys(terminalStore.get().sessions).length > 0) return undefined
      return newSession().then(() => undefined)
    })
    .finally(() => {
      ensureInFlight = null
    })
}

/** 本地移除会话(退出事件/✕):销毁 xterm、摘 tab、空组拼合 */
function removeSessionLocal(id: string): void {
  const st = terminalStore.get()
  if (!st.sessions[id]) return
  disposeTermInstance(id)
  const sessions = { ...st.sessions }
  delete sessions[id]

  const owner = groupOfSession(st.root, id)
  let root = st.root
  if (owner) {
    root = updateGroup(root, owner.id, (g) => {
      const tabs = g.tabs.filter((tid) => tid !== id)
      const idx = g.tabs.indexOf(id)
      const active =
        g.active === id ? (tabs[Math.min(Math.max(idx, 0), tabs.length - 1)] ?? null) : g.active
      return { ...g, tabs, active }
    })
    const after = findGroup(root, owner.id)
    if (after && after.tabs.length === 0) {
      root = removeGroup(root, owner.id) // 最后一个 tab 关闭 → 组从树中移除并与兄弟合并
    }
  }
  const focusedOk = findGroup(root, st.focusedGroup)
  terminalStore.set({
    sessions,
    root,
    focusedGroup: focusedOk ? st.focusedGroup : firstGroup(root).id,
    searchSession: st.searchSession === id ? null : st.searchSession
  })
}

/** 关闭会话(UI 即时移除;main 进程杀 shell,退出事件对已移除会话幂等) */
export function closeSession(id: string): void {
  void window.api.terminalClose(id).catch(() => undefined)
  removeSessionLocal(id)
}

/** 重命名(同步 main,重载恢复后名字不丢) */
export function renameSession(id: string, name: string): void {
  const st = terminalStore.get()
  const info = st.sessions[id]
  if (!info) return
  const trimmed = name.trim().slice(0, 64)
  if (trimmed.length === 0) return
  terminalStore.set({ sessions: { ...st.sessions, [id]: { ...info, name: trimmed } } })
  void window.api.terminalRename(id, trimmed).catch(() => undefined)
}

// ---------------------------------------------------------------
// 分栏 / tab 操作
// ---------------------------------------------------------------

/** 拆分:目标组变为分栏节点(原组 + 带新会话的新组);dir row=向右 column=向下 */
export async function splitGroup(groupId: string, dir: 'row' | 'column'): Promise<void> {
  const st0 = terminalStore.get()
  const target = findGroup(st0.root, groupId) ?? firstGroup(st0.root)
  let info: TerminalSessionInfo
  try {
    info = await window.api.terminalCreate({ cwd: terminalCwd ?? undefined })
  } catch {
    return
  }
  createTermInstance(info)
  const st = terminalStore.get()
  const fresh: TermGroup = { kind: 'group', id: nextNodeId(), tabs: [info.id], active: info.id }
  const root = updateGroup(st.root, target.id, (g) => ({
    kind: 'split',
    id: nextNodeId(),
    dir,
    ratio: 0.5,
    a: g,
    b: fresh
  }))
  terminalStore.set({
    sessions: { ...st.sessions, [info.id]: info },
    root,
    focusedGroup: fresh.id,
    backend: info.backend
  })
}

/** 会话 tab 拖拽换组:beforeId 为目标组内插入位置(缺省追加尾部) */
export function moveTab(sessionId: string, targetGroupId: string, beforeId?: string): void {
  const st = terminalStore.get()
  const from = groupOfSession(st.root, sessionId)
  const to = findGroup(st.root, targetGroupId)
  if (!from || !to) return
  if (from.id === to.id && !beforeId) return

  // 1) 从源组摘除
  let root = updateGroup(st.root, from.id, (g) => {
    const tabs = g.tabs.filter((tid) => tid !== sessionId)
    const idx = g.tabs.indexOf(sessionId)
    const active =
      g.active === sessionId ? (tabs[Math.min(Math.max(idx, 0), tabs.length - 1)] ?? null) : g.active
    return { ...g, tabs, active }
  })
  // 2) 插入目标组(beforeId 之前;不存在则尾部)
  root = updateGroup(root, to.id, (g) => {
    const tabs = g.tabs.filter((tid) => tid !== sessionId)
    const at = beforeId ? tabs.indexOf(beforeId) : -1
    if (at >= 0) tabs.splice(at, 0, sessionId)
    else tabs.push(sessionId)
    return { ...g, tabs, active: sessionId }
  })
  // 3) 源组空则拼合
  const fromAfter = findGroup(root, from.id)
  if (fromAfter && fromAfter.tabs.length === 0) root = removeGroup(root, from.id)

  const focusedOk = findGroup(root, to.id)
  terminalStore.set({ root, focusedGroup: focusedOk ? to.id : firstGroup(root).id })
}

export function setActiveTab(groupId: string, sessionId: string): void {
  const st = terminalStore.get()
  terminalStore.set({
    root: updateGroup(st.root, groupId, (g) =>
      g.tabs.includes(sessionId) ? { ...g, active: sessionId } : g
    ),
    focusedGroup: groupId
  })
}

export function setFocusedGroup(groupId: string): void {
  if (terminalStore.get().focusedGroup !== groupId) terminalStore.set({ focusedGroup: groupId })
}

/** 分隔条拖拽:按增量比例调整(读最新 ratio,避免拖拽闭包持旧值) */
export function adjustSplitRatio(splitId: string, deltaFrac: number): void {
  const st = terminalStore.get()
  terminalStore.set({
    root: updateSplit(st.root, splitId, (s) => ({ ...s, ratio: clampRatio(s.ratio + deltaFrac) }))
  })
}

/** ⌘F 搜索条开关(null 关闭) */
export function setSearchSession(id: string | null): void {
  terminalStore.set({ searchSession: id })
}
