/** NuttX 环境检测与参数构造：不加载 ESP-IDF，也不套用其分区合并逻辑。 */
import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FirmwareTaskKind, ToolchainInfo } from '../shared/ipc-types'

export async function detectNuttxToolchain(firmwareDir: string, overridePath: string): Promise<ToolchainInfo> {
  const base: ToolchainInfo = { ok: false, backend: 'nuttx', idfPath: '', nuttxPath: '', version: null, firmwareDir }
  // 当前 runner 使用 NuttX 原生 POSIX 构建；不把 Windows ESP-IDF 环境误报为可用。
  if (!['darwin', 'linux'].includes(process.platform)) return { ...base, error: 'unsupportedPlatform' }
  // 显式设置路径必须准确命中，不能用环境变量回退掩盖设置页的错误输入。
  const explicitPath = overridePath.trim()
  const candidates = (explicitPath ? [explicitPath] : [process.env.NUTTX_PATH ?? '', join(homedir(), 'nuttxspace', 'nuttx'), join(homedir(), 'nuttx', 'nuttx')])
    .filter((path) => path.length > 0)
  const nuttxPath = candidates.find((path) => ['tools/configure.sh', 'Makefile', 'boards'].every((file) => existsSync(join(path, file))))
  if (!nuttxPath) {
    const existing = candidates.find((path) => existsSync(path))
    return { ...base, nuttxPath: existing ?? candidates[0] ?? '', error: existing ? 'nuttxInvalid' : 'nuttxNotFound' }
  }
  let version: string | null = null
  try {
    const versionFile = await fsp.readFile(join(nuttxPath, '.version'), 'utf8')
    const match = /^CONFIG_VERSION_STRING\s*=\s*["']?([^"'\r\n]+)/m.exec(versionFile)
    version = match?.[1] ?? null
  } catch { /* 未生成版本文件的源码树仍可构建。 */ }
  if (!existsSync(join(firmwareDir, 'scripts', 'nuttx.py')) || !existsSync(join(firmwareDir, 'src', 'main.c'))) {
    return { ...base, nuttxPath, version, error: 'firmwareMissing' }
  }
  return { ...base, ok: true, nuttxPath, version }
}

/** 使用 argv 传参，项目路径与串口不进入 shell 拼接。 */
export function nuttxTaskArgs(kind: FirmwareTaskKind, nuttxPath: string, target: string, port?: string, baud?: number): string[] {
  const args = ['scripts/nuttx.py', kind, '--nuttx-path', nuttxPath, '--target', target]
  if (kind === 'flash') args.push('--port', port ?? '', '--baud', String(baud))
  return args
}
