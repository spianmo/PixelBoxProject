/**
 * IDE 外壳系统集成服务(main 进程)
 * - 自绘标题栏的窗口控制(Windows/Linux 最小化/最大化/关闭;macOS 走原生红绿灯)
 * - 工作区 git 分支读取(纯文件解析 .git/HEAD,不依赖 git 可执行文件)
 * - 模拟器屏幕截图落盘(~/Downloads)
 */
import { app, ipcMain, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, resolve, isAbsolute, dirname } from 'node:path'

/**
 * 读取仓库当前分支名:
 * - `.git` 为目录:读 `.git/HEAD`
 * - `.git` 为文件(worktree/submodule):解析 `gitdir: <path>` 后再读 HEAD
 * - `ref: refs/heads/xxx` → 分支名;detached HEAD → 短 SHA;非 git 仓库 → null
 */
async function readGitBranch(root: string): Promise<string | null> {
  try {
    const gitPath = join(resolve(root), '.git')
    let gitDir = gitPath
    const st = await fsp.stat(gitPath)
    if (st.isFile()) {
      const content = await fsp.readFile(gitPath, 'utf8')
      const m = /^gitdir:\s*(.+)\s*$/m.exec(content)
      if (!m) return null
      gitDir = isAbsolute(m[1]) ? m[1] : resolve(dirname(gitPath), m[1])
    }
    const head = (await fsp.readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (ref) return ref[1]
    // detached HEAD:显示短提交号
    return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 7) : null
  } catch {
    return null // 非 git 仓库或不可读:标题栏隐藏分支组件
  }
}

/** 时间戳文件名片段:20260806-153001 */
function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function registerShellIpc(): void {
  // ---- 窗口控制(自绘标题栏按钮,仅 Windows/Linux 使用) ----
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize-toggle', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('win:is-maximized', (e): boolean => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })

  // ---- git 分支(标题栏 / 状态栏) ----
  ipcMain.handle('shell:git-branch', async (_e, root: string): Promise<string | null> => {
    return readGitBranch(root)
  })

  // ---- 截图落盘:PNG 字节 → ~/Downloads,返回完整路径 ----
  ipcMain.handle('shell:save-screenshot', async (_e, png: ArrayBuffer): Promise<string> => {
    const file = join(app.getPath('downloads'), `pixelbox-sim-${timestamp()}.png`)
    await fsp.writeFile(file, Buffer.from(png))
    return file
  })
}

/** 窗口最大化状态变化 → 推送 renderer(自绘「最大化/还原」按钮切换图标) */
export function wireShellWindowEvents(win: BrowserWindow): void {
  const send = (maximized: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send('win:maximized', maximized)
  }
  win.on('maximize', () => send(true))
  win.on('unmaximize', () => send(false))
}
