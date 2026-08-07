/**
 * 原生 Git 菜单桥(renderer)—— 消费 main menu.ts 广播的 menu:git-action
 *
 * - 直接动作(不需要 UI):push / pull / stageAll / checkout(带分支名 arg)
 *   → 调既有 window.api.git* + store 刷新 + toast(错误码走 t('git.errors.<code>'))
 * - 需要 UI 的动作:commit / newBranch / remotes / show
 *   → window.dispatchEvent(new CustomEvent('pixelbox:git-ui', { detail: { action } }))
 *   App 监听该事件打开 Git 工具窗(App.tsx 由并行改动方手工接线,这里不 import App);
 *   GitPanel 已挂载时自行监听同一事件完成聚焦提交框 / 切分支视图 / 弹新建分支框
 * - 顺带订阅设置变更:appearance.language 变化 → menu:refresh(原生菜单文案跟随)
 * - 初始化入口:git/store.ts 的 initGitStore()(幂等)
 */
import i18n from '../i18n'
import { showToast } from '../components/toast'
import type { GitMenuActionEvent } from '../../../shared/ipc-types'
import {
  clearOpLog,
  gitErrCode,
  gitStore,
  refreshGitAll,
  refreshGitStatus,
  setOpRunning
} from './store'

/** i18n 便捷取值(非组件环境直接用 i18n 实例) */
function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options)
}

/** 错误 toast(与 GitPanel withErrToast 同口径) */
function errToast(err: unknown): void {
  const code = gitErrCode(err)
  showToast(t(`git.errors.${code}`, { defaultValue: t('git.errors.failed') }), 'error')
}

/** 需要 UI 的动作 → 自定义事件(App 打开工具窗,GitPanel 已挂载时消费 detail.action) */
function dispatchUi(action: string): void {
  window.dispatchEvent(new CustomEvent('pixelbox:git-ui', { detail: { action } }))
}

/** push / pull(与 GitPanel doOp 同一状态机:opRunning 互斥 + opLog 收集) */
async function runOp(root: string, op: 'push' | 'pull'): Promise<void> {
  if (gitStore.get().opRunning) return
  clearOpLog()
  setOpRunning(op)
  try {
    if (op === 'push') await window.api.gitPush(root)
    else await window.api.gitPull(root)
    showToast(t(op === 'push' ? 'git.pushDone' : 'git.pullDone'), 'success')
    await refreshGitAll(root)
  } catch (err) {
    errToast(err)
  } finally {
    setOpRunning(null)
  }
}

/** 全部暂存:git:stage 传 [root] → main 侧归一化为 '.'(git add -- .,含删除与未跟踪) */
async function stageAll(root: string): Promise<void> {
  try {
    await window.api.gitStage(root, [root])
    showToast(t('git.stageAllDone'), 'success')
    await refreshGitStatus(root)
  } catch (err) {
    errToast(err)
  }
}

/** 切分支(菜单动态子菜单点击,arg = 分支名) */
async function checkout(root: string, branch: string): Promise<void> {
  try {
    await window.api.gitCheckout(root, branch)
    showToast(t('git.checkedOut', { name: branch }), 'success')
    await refreshGitAll(root)
  } catch (err) {
    errToast(err)
  }
}

function handleAction(ev: GitMenuActionEvent): void {
  const root = gitStore.get().root
  switch (ev.action) {
    // ---- 直接动作(需要已打开的 git 工作区;菜单在非仓库时已置灰,这里再兜底) ----
    case 'push':
    case 'pull':
      if (root) void runOp(root, ev.action)
      break
    case 'stageAll':
      if (root) void stageAll(root)
      break
    case 'checkout':
      if (root && typeof ev.arg === 'string' && ev.arg.length > 0) void checkout(root, ev.arg)
      break
    // ---- 需要 UI 的动作 → CustomEvent(newBranch 需要输入框,同样交给 GitPanel) ----
    case 'commit':
    case 'newBranch':
    case 'remotes':
    case 'show':
      dispatchUi(ev.action)
      break
  }
}

let initialized = false

/** 初始化(幂等;由 initGitStore 调用):订阅菜单动作 + 语言变化重建原生菜单 */
export function initGitMenuBridge(): void {
  if (initialized) return
  initialized = true
  window.api.onGitMenuAction(handleAction)
  window.api.onSettingsChanged((ev) => {
    if (ev.changedKeys.includes('appearance.language')) void window.api.menuRefresh()
  })
}
