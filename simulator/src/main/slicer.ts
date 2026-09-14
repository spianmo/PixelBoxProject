/** IDE 内调用本机 PrusaSlicer CLI。打印机/材料参数由用户选择的 INI 提供。 */
import { dialog, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { getWatchedRoot } from './workspace'

async function pick(title: string, extensions?: string[]): Promise<string | null> {
  const result = await dialog.showOpenDialog({ title, properties: ['openFile'],
    ...(extensions ? { filters: [{ name: title, extensions }] } : {}) })
  return result.canceled ? null : result.filePaths[0] ?? null
}

export function registerSlicerIpc(): void {
  ipcMain.handle('printer:slice', async (_event, opts: { root: string; part: 'base' | 'lid' }): Promise<string | null> => {
    if (!getWatchedRoot() || resolve(opts.root) !== resolve(getWatchedRoot()!)) throw new Error('切片工程不是当前工作区')
    if (!['base', 'lid'].includes(opts.part)) throw new Error('只能切片底盒或顶盖')
    const input = join(resolve(opts.root), 'export', 'print', `enclosure-${opts.part}.stl`)
    await fs.access(input)
    // 用户明确选择本机可执行文件；工程文件不能静默指定执行程序，不经过 shell。
    const executable = await pick('选择 PrusaSlicer 命令行程序（macOS：应用包内 Contents/MacOS/PrusaSlicer）')
    if (!executable) return null
    const profile = await pick('选择匹配打印机、喷嘴和材料的 PrusaSlicer INI 配置', ['ini'])
    if (!profile) return null
    const output = join(resolve(opts.root), 'export', 'print', `enclosure-${opts.part}-${Date.now()}.gcode`)
    await new Promise<void>((ok, fail) => {
      execFile(executable, ['--load', profile, '--export-gcode', '--output', output, input],
        { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          if (error) fail(new Error(`切片失败（最大 60 秒）：${(stderr || stdout || error.message).slice(-1200)}`))
          else ok()
        })
    })
    if ((await fs.stat(output)).size < 100) throw new Error('切片器未生成有效 G-code')
    return output
  })
}
