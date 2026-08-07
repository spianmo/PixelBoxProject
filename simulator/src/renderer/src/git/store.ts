/**
 * Git 集成共享状态(renderer)—— GitPanel / 状态栏分支块 / FileTree 着色共用
 *
 * 设计:复用 device-sim 的轻量可订阅 store(useSyncExternalStore 友好,
 * 参照 shell/store.ts 用法);数据源为 preload 的 git:* IPC。
 * - refreshGitAll(root):info + status + log 全量刷新(打开面板 / git:changed)
 * - refreshGitStatus(root):仅 info + status(高频轻量刷新)
 * - initGitStore():订阅 git:changed(去抖后自动刷新)与 git:op-output(push/pull 日志)
 * - resetGitStore():工作区切换时清空(App 在 applyWorkspace 时调用 setGitRoot)
 */
import { useSyncExternalStore } from 'react'
import { createStore, type Store } from '../device-sim/store'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitInfo,
  GitRemoteInfo,
  GitStatusResult
} from '../../../shared/ipc-types'
import type { GitTreeMark } from './fileStatusColors'
import { initGitMenuBridge } from './menuBridge'

export interface GitState {
  /** 当前工作区根(null = 未打开工作区,面板不可用) */
  root: string | null
  /** 仓库概览(未查询到前为 null) */
  info: GitInfo | null
  status: GitStatusResult | null
  log: GitCommitInfo[]
  /** 本地分支列表(GitPanel 分支视图;refreshGitAll 拉取) */
  branches: GitBranchInfo[]
  /** Remote 列表(GitPanel 分支视图底部 Remotes 小节) */
  remotes: GitRemoteInfo[]
  /** 进行中的流式操作(push/pull;运行中禁用工具行按钮) */
  opRunning: 'push' | 'pull' | null
  /** push/pull 输出日志行(底部折叠日志区) */
  opLog: string[]
  /** 首次加载完成(避免打开面板瞬间空态闪烁) */
  loaded: boolean
}

const EMPTY: GitState = {
  root: null,
  info: null,
  status: null,
  log: [],
  branches: [],
  remotes: [],
  opRunning: null,
  opLog: [],
  loaded: false
}

export const gitStore: Store<GitState> = createStore<GitState>({ ...EMPTY })

/** React hook:订阅 git 状态 */
export function useGitState(): GitState {
  return useSyncExternalStore(gitStore.subscribe, gitStore.get)
}

/** 变更文件总数(左轨道 Git 图标徽标) */
export function gitChangeCount(s: GitState): number {
  const st = s.status
  if (!st) return 0
  // staged 与 unstaged 可能是同一文件(MM):按去重后的文件数计
  const set = new Set<string>()
  for (const group of [st.staged, st.unstaged, st.untracked, st.conflicted]) {
    for (const f of group) set.add(f.path)
  }
  return set.size
}

/** FileTree 着色映射(绝对路径 → 状态字母;ignored 优先级最低,冲突最高) */
export function gitFileStatusMap(s: GitState): ReadonlyMap<string, GitTreeMark> {
  const map = new Map<string, GitTreeMark>()
  const st = s.status
  if (!st) return map
  const put = (path: string, letter: GitTreeMark): void => {
    map.set(path, letter)
  }
  // ignored 最先放(优先级最低;目录条目由 FileTree 祖先链传播到子树)
  for (const f of st.ignored) put(f.path, 'I')
  for (const f of st.staged) put(f.path, f.status === 'R' ? 'M' : f.status === 'C' ? 'M' : f.status)
  for (const f of st.unstaged) put(f.path, f.status === 'R' ? 'M' : f.status === 'C' ? 'M' : f.status)
  for (const f of st.untracked) put(f.path, 'U')
  for (const f of st.conflicted) put(f.path, 'C')
  return map
}

/** 请求序号:快速切换工作区 / 连续刷新时丢弃过期结果 */
let refreshSeq = 0

/** 仅刷新 info + status(git:changed 高频路径) */
export async function refreshGitStatus(root: string): Promise<void> {
  const seq = ++refreshSeq
  try {
    const info = await window.api.gitInfo(root)
    if (seq !== refreshSeq || gitStore.get().root !== root) return
    if (!info.isRepo || !info.gitFound) {
      gitStore.set({ info, status: null, log: [], loaded: true })
      return
    }
    const status = await window.api.gitStatus(root)
    if (seq !== refreshSeq || gitStore.get().root !== root) return
    gitStore.set({ info, status, loaded: true })
  } catch {
    // IPC 失败(git 不可用等):保留旧状态,面板顶部由 info.gitFound 提示
    if (seq === refreshSeq) gitStore.set({ loaded: true })
  }
}

/** 全量刷新:info + status + log + 分支 + remotes(打开面板 / 提交后 / git:changed) */
export async function refreshGitAll(root: string): Promise<void> {
  await refreshGitStatus(root)
  if (gitStore.get().root !== root) return
  const info = gitStore.get().info
  if (!info?.isRepo || !info.gitFound) return
  // 三路并发、各自失败兜底(空仓库 log 已回空数组;真失败保留旧值)
  const [log, branches, remotes] = await Promise.all([
    window.api.gitLog(root).catch(() => null),
    window.api.gitBranches(root).catch(() => null),
    window.api.gitRemotes(root).catch(() => null)
  ])
  if (gitStore.get().root !== root) return
  gitStore.set({
    ...(log !== null ? { log } : {}),
    ...(branches !== null ? { branches } : {}),
    ...(remotes !== null ? { remotes } : {})
  })
}

/** 工作区切换:换根并重置状态(root=null 回欢迎页) */
export function setGitRoot(root: string | null): void {
  refreshSeq++
  gitStore.replace({ ...EMPTY, root })
  if (root) void refreshGitAll(root)
}

/** push/pull 日志追加(上限 500 行) */
function appendOpLog(line: string): void {
  const cur = gitStore.get().opLog
  const next = [...cur, line]
  gitStore.set({ opLog: next.length > 500 ? next.slice(next.length - 500) : next })
}

export function clearOpLog(): void {
  gitStore.set({ opLog: [] })
}

export function setOpRunning(op: 'push' | 'pull' | null): void {
  gitStore.set({ opRunning: op })
}

/** IPC 错误消息 → git:<code>(取最后一个匹配;GitPanel / menuBridge 共用) */
export function gitErrCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return [...msg.matchAll(/git:(\w+)/g)].pop()?.[1] ?? 'failed'
}

let initialized = false

/**
 * 全局订阅(App 挂载时一次;幂等):git:changed 自动刷新 + push/pull 输出入库
 * + 原生 Git 菜单桥(menu:git-action → IPC / CustomEvent,见 menuBridge.ts)
 */
export function initGitStore(): void {
  if (initialized) return
  initialized = true
  window.api.onGitChanged((ev) => {
    const root = gitStore.get().root
    if (root && ev.root === root) void refreshGitAll(root)
  })
  window.api.onGitOpOutput((ev) => {
    if (ev.kind === 'line') appendOpLog(ev.text)
  })
  initGitMenuBridge()
}
