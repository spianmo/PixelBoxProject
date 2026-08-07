/**
 * 系统原生应用菜单(照 IntelliJ 的 Git 顶级菜单)
 *
 * - macOS 默认 App/Edit/View/Window/Help 用 role 默认项保留,中间插入「Git」
 *   顶级菜单;Windows/Linux 主窗 autoHideMenuBar,Alt 呼出
 * - Git 菜单点击 → 所有窗口 webContents.send('menu:git-action', { action, arg? }),
 *   renderer 侧由 git/menuBridge.ts 统一消费(直接动作调 IPC,需 UI 的动作转
 *   CustomEvent 'pixelbox:git-ui' 交给 App/GitPanel)
 * - 动态「切换分支」子菜单:git.ts 的 onGitActivity 回调(git:changed 广播 /
 *   工作区切换)触发去抖 500ms 重建;无工作区或非 git 仓库时 Git 菜单项整体置灰
 * - 菜单文案与 renderer i18n 同源:直接 import 两份 locale JSON,按
 *   settings.appearance.language 取值;语言切换时 renderer(menuBridge)调
 *   menu:refresh 立即重建
 * - 循环依赖纪律:menu.ts 单向 import git.ts 的查询函数(queryBranches/
 *   resolveGit)与回调注册(onGitActivity);git.ts 绝不 import menu.ts
 */
import { app, BrowserWindow, Menu, ipcMain, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingsSync } from './settings'
import { getWatchedRoot } from './workspace'
import { onGitActivity, queryBranches, resolveGit } from './git'
import type { GitBranchInfo, GitMenuAction, GitMenuActionEvent } from '../shared/ipc-types'
import zhCN from '../renderer/src/i18n/locales/zh-CN.json'
import en from '../renderer/src/i18n/locales/en.json'

/** 重建去抖(git:changed 一次提交会连发多个事件) */
const REBUILD_DEBOUNCE_MS = 500

/** 当前语言的 Git 菜单文案(与 renderer i18n 同一 JSON 数据源) */
function menuLabels(): typeof zhCN.menu.git {
  return (getSettingsSync().appearance.language === 'en' ? en : zhCN).menu.git
}

/** Git 菜单动作 → 广播给所有窗口(renderer menuBridge 消费) */
function sendGitAction(action: GitMenuAction, arg?: string): void {
  const payload: GitMenuActionEvent = { action, ...(arg !== undefined ? { arg } : {}) }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('menu:git-action', payload)
  }
}

/** Git 顶级菜单(enabled=false 时全部置灰;branches 为动态子菜单数据) */
function gitMenuTemplate(enabled: boolean, branches: GitBranchInfo[]): MenuItemConstructorOptions {
  const L = menuLabels()
  return {
    label: L.title,
    submenu: [
      { label: L.commit, enabled, click: () => sendGitAction('commit') },
      { label: L.push, enabled, click: () => sendGitAction('push') },
      { label: L.pull, enabled, click: () => sendGitAction('pull') },
      { label: L.stageAll, enabled, click: () => sendGitAction('stageAll') },
      { type: 'separator' },
      { label: L.newBranch, enabled, click: () => sendGitAction('newBranch') },
      {
        label: L.switchBranch,
        enabled: enabled && branches.length > 0,
        submenu: branches.map(
          (b): MenuItemConstructorOptions => ({
            label: b.name,
            type: 'checkbox',
            checked: b.current,
            enabled: !b.current,
            click: () => sendGitAction('checkout', b.name)
          })
        )
      },
      { type: 'separator' },
      { label: L.remotes, enabled, click: () => sendGitAction('remotes') },
      { label: L.showPanel, enabled, click: () => sendGitAction('show') }
    ]
  }
}

/**
 * 构建并安装应用菜单。默认角色菜单(App/Edit/View/Window/Help)交给 Electron
 * role 默认项(编辑快捷键 ⌘C/⌘V、视图 reload/devtools、窗口管理全保留),
 * Git 菜单插在 View 与 Window 之间(IntelliJ 布局习惯)。
 */
export async function buildAppMenu(): Promise<void> {
  const root = getWatchedRoot()
  const gitFound = resolveGit() !== null
  const isRepo = root !== null && gitFound && existsSync(join(root, '.git'))
  let branches: GitBranchInfo[] = []
  if (isRepo && root) {
    try {
      branches = await queryBranches(root)
    } catch {
      branches = [] // 空仓库(无提交)等场景:切换分支子菜单置灰即可
    }
  }
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } satisfies MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    gitMenuTemplate(isRepo, branches),
    { role: 'windowMenu' },
    { role: 'help', submenu: [] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

let rebuildTimer: NodeJS.Timeout | null = null

/** 去抖重建(git:changed 广播 / 工作区切换 / 语言切换共用入口) */
export function scheduleMenuRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    void buildAppMenu()
  }, REBUILD_DEBOUNCE_MS)
}

let initialized = false

/**
 * 初始化应用菜单(main/index.ts 窗口就绪后调用一次;幂等):
 * 立即构建 + 订阅 git 活动(去抖重建)+ 注册 menu:refresh(语言切换等
 * renderer 主动请求重建;settings 模块无 main 内回调钩子,经 IPC 绕行)。
 */
export function initAppMenu(): void {
  if (initialized) return
  initialized = true
  onGitActivity(scheduleMenuRebuild)
  ipcMain.handle('menu:refresh', (): void => scheduleMenuRebuild())
  void buildAppMenu()
}

/** 退出前收尾:清重建定时器(防退出竞态触发菜单重建) */
export function disposeMenu(): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer)
    rebuildTimer = null
  }
}

// app 退出时兜底清理(main/index.ts 只加一行初始化,收尾自理)
app.on('before-quit', disposeMenu)
