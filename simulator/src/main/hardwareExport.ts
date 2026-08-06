/**
 * 硬件导出服务(main 进程)—— STL / Gerber 文件落盘
 *
 * IPC:
 * - hardware:export  { root, kind: 'print'|'gerber', files: HardwareExportFile[] }
 *   → 写入 <root>/export/<kind>/(mkdir -p,同名覆盖),完成后
 *     shell.showItemInFolder 在系统文件管理器中定位导出目录,返回 { dir, files }
 *
 * 安全防护:
 * - root 必须位于当前 watch 的工作区内(getWatchedRoot;越界/未打开工作区
 *   throw hardware:noWorkspace)
 * - 文件名净化:拒绝路径分隔符与 ..(hardware:badFileName),阻止越权写出目录
 *
 * 内容经 renderer 以 base64 传入(STLExporter 的二进制 DataView / Gerber 文本
 * 统一走 dataB64,单通道无分支)
 */
import { ipcMain, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { HardwareExportFile, HardwareExportResult } from '../shared/ipc-types'
import { getWatchedRoot } from './workspace'

type ExportKind = 'print' | 'gerber'

interface ExportOptions {
  root: string
  kind: ExportKind
  files: HardwareExportFile[]
}

/** root 必须是当前工作区根或其子目录(未打开工作区 / 越界一律拒绝) */
function assertInsideWorkspace(root: string): string {
  const watched = getWatchedRoot()
  if (!watched) throw new Error('hardware:noWorkspace')
  const abs = resolve(root)
  const base = resolve(watched)
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error('hardware:noWorkspace')
  return abs
}

/** 文件名净化:非空、无路径分隔符、无 ..(拒绝而非改写,让调用方修 bug) */
function sanitizeFileName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('hardware:badFileName')
  const trimmed = name.trim()
  if (
    trimmed.length === 0 ||
    trimmed === '.' ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    throw new Error('hardware:badFileName')
  }
  return trimmed
}

async function exportFiles(opts: ExportOptions): Promise<HardwareExportResult> {
  if (opts.kind !== 'print' && opts.kind !== 'gerber') throw new Error('hardware:badKind')
  if (!Array.isArray(opts.files) || opts.files.length === 0) throw new Error('hardware:noFiles')

  const root = assertInsideWorkspace(opts.root)
  const dir = join(root, 'export', opts.kind)
  await fsp.mkdir(dir, { recursive: true })

  const written: string[] = []
  for (const file of opts.files) {
    const name = sanitizeFileName(file.name)
    if (typeof file.dataB64 !== 'string') throw new Error('hardware:badFileData')
    await fsp.writeFile(join(dir, name), Buffer.from(file.dataB64, 'base64'))
    written.push(name)
  }

  // 系统文件管理器中定位导出目录(用户下一步要拖给切片器/制板商)
  shell.showItemInFolder(dir)
  return { dir, files: written }
}

export function registerHardwareExportIpc(): void {
  ipcMain.handle(
    'hardware:export',
    async (_e, opts: ExportOptions): Promise<HardwareExportResult> => exportFiles(opts)
  )
}
