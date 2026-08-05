/**
 * 工作区文件系统服务(main 进程)
 * - fs.* IPC:目录读取 / 文件读写 / 新建 / 重命名 / 删除
 * - chokidar 监听工作区变更,推送 workspace:fs-event 到 renderer
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { FsEntry, FsWatchEvent } from '../shared/ipc-types'

let watcher: FSWatcher | null = null
let watchedRoot: string | null = null

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
    return ret.filePaths[0]
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
