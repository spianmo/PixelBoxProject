/**
 * 工作区文件系统服务(main 进程)
 * - fs.* IPC:目录读取 / 文件读写 / 新建 / 重命名 / 删除
 * - chokidar 监听工作区变更,推送 workspace:fs-event 到 renderer
 * - 最近工作区列表(userData 持久化,标题栏项目下拉使用)
 * - 工作区文件全量列举(Cmd+P 快速打开的模糊搜索数据源)
 */
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { existsSync, type Dirent } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { FsEntry, FsWatchEvent } from '../shared/ipc-types'

let watcher: FSWatcher | null = null
let watchedRoot: string | null = null

// ---------------------------------------------------------------
// 最近工作区(标题栏项目下拉)
// ---------------------------------------------------------------

const RECENTS_MAX = 10

function recentsFile(): string {
  return join(app.getPath('userData'), 'recent-workspaces.json')
}

async function loadRecents(): Promise<string[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(recentsFile(), 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

async function addRecent(root: string): Promise<void> {
  const abs = resolve(root)
  const list = [abs, ...(await loadRecents()).filter((p) => p !== abs)].slice(0, RECENTS_MAX)
  try {
    await fsp.writeFile(recentsFile(), JSON.stringify(list, null, 2), 'utf8')
  } catch {
    // 持久化失败不影响打开流程
  }
}

// ---------------------------------------------------------------
// 快速打开(Cmd+P)的文件列举
// ---------------------------------------------------------------

/** 列举时跳过的目录名(构建产物 / 依赖 / VCS) */
const LIST_SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.git'])
const LIST_MAX_FILES = 8000

/** 递归列举工作区内文件(相对路径,'/' 分隔),供 renderer 侧模糊匹配 */
async function listWorkspaceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= LIST_MAX_FILES) return
    let items: Dirent[]
    try {
      items = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // 无权限等,跳过该目录
    }
    for (const it of items) {
      if (out.length >= LIST_MAX_FILES) return
      if (it.name.startsWith('.')) continue // 隐藏文件与 .git 等
      const childRel = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) {
        if (!LIST_SKIP_DIRS.has(it.name)) await walk(join(dir, it.name), childRel)
      } else {
        out.push(childRel)
      }
    }
  }
  await walk(root, '')
  return out
}

/** 路径防护:确保操作路径位于当前工作区内,阻止越权访问 */
function assertInsideRoot(p: string): string {
  const abs = resolve(p)
  if (!watchedRoot) return abs // 尚未 watch(如刚打开工作区时的首次 readDir)
  const root = resolve(watchedRoot)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`路径越界: ${p}`)
  }
  return abs
}

async function readDirSorted(dir: string): Promise<FsEntry[]> {
  const items = await fsp.readdir(dir, { withFileTypes: true })
  const entries: FsEntry[] = items
    .filter((it) => it.name !== '.DS_Store')
    .map((it) => ({
      name: it.name,
      path: join(dir, it.name),
      isDir: it.isDirectory()
    }))
  // 目录在前,同类按名称排序
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return entries
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerWorkspaceIpc(): void {
  // 弹出系统对话框选择工作区文件夹
  ipcMain.handle('dialog:open-workspace', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const ret = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (ret.canceled || ret.filePaths.length === 0) return null
    await addRecent(ret.filePaths[0])
    return ret.filePaths[0]
  })

  // 直接按路径打开(最近工作区列表点击),目录不存在返回 null
  ipcMain.handle('workspace:open-path', async (_e, root: string): Promise<string | null> => {
    const abs = resolve(root)
    try {
      const st = await fsp.stat(abs)
      if (!st.isDirectory()) return null
    } catch {
      return null
    }
    await addRecent(abs)
    return abs
  })

  // 最近工作区(过滤掉已不存在的目录)
  ipcMain.handle('workspace:recents', async (): Promise<string[]> => {
    return (await loadRecents()).filter((p) => existsSync(p))
  })

  // 快速打开:工作区文件全量列举(未打开工作区时返回空)
  ipcMain.handle('workspace:list-files', async (): Promise<string[]> => {
    if (!watchedRoot) return []
    return listWorkspaceFiles(watchedRoot)
  })

  ipcMain.handle('fs:read-dir', async (_e, dir: string): Promise<FsEntry[]> => {
    return readDirSorted(assertInsideRoot(dir))
  })

  ipcMain.handle('fs:read-file', async (_e, p: string): Promise<string> => {
    return fsp.readFile(assertInsideRoot(p), 'utf8')
  })

  ipcMain.handle('fs:write-file', async (_e, p: string, content: string): Promise<void> => {
    const abs = assertInsideRoot(p)
    await fsp.mkdir(dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
  })

  ipcMain.handle('fs:mkdir', async (_e, p: string): Promise<void> => {
    await fsp.mkdir(assertInsideRoot(p), { recursive: true })
  })

  ipcMain.handle('fs:create-file', async (_e, p: string): Promise<void> => {
    const abs = assertInsideRoot(p)
    await fsp.mkdir(dirname(abs), { recursive: true })
    // wx: 已存在则报错,避免覆盖
    await fsp.writeFile(abs, '', { encoding: 'utf8', flag: 'wx' })
  })

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string): Promise<void> => {
    await fsp.rename(assertInsideRoot(oldPath), assertInsideRoot(newPath))
  })

  ipcMain.handle('fs:delete', async (_e, p: string): Promise<void> => {
    await fsp.rm(assertInsideRoot(p), { recursive: true, force: true })
  })

  // 开始监听工作区;重复调用会先关闭旧 watcher
  ipcMain.handle('workspace:watch', async (_e, root: string): Promise<void> => {
    await watcher?.close()
    watchedRoot = resolve(root)
    watcher = chokidar.watch(watchedRoot, {
      ignored: [/(^|[/\\])\../, /node_modules/, /(^|[/\\])dist([/\\]|$)/],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    const emit = (type: FsWatchEvent['type']) => (path: string) => {
      broadcast('workspace:fs-event', { type, path } satisfies FsWatchEvent)
    }
    watcher.on('add', emit('add'))
    watcher.on('addDir', emit('addDir'))
    watcher.on('change', emit('change'))
    watcher.on('unlink', emit('unlink'))
    watcher.on('unlinkDir', emit('unlinkDir'))
  })

  ipcMain.handle('workspace:unwatch', async (): Promise<void> => {
    await watcher?.close()
    watcher = null
    watchedRoot = null
  })
}

/** 退出前清理 watcher */
export async function disposeWorkspace(): Promise<void> {
  await watcher?.close()
  watcher = null
}

/** 当前工作区根目录(供 simbridge 做路径防护;未打开工作区时为 null) */
export function getWatchedRoot(): string | null {
  return watchedRoot
}
