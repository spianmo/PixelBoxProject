/** 固件工程识别与模板定位。主进程依据磁盘清单选择后端，不采信 renderer 的单方声明。 */
import { app } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FirmwareBackend, NuttxProfile, PixelboxManifest } from '../shared/ipc-types'
import { isFirmwareBackend, isNuttxProfile, nuttxProfileChip } from '../shared/firmwareBackends'

export function firmwareTemplateRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'firmware-templates')
    : resolve(app.getAppPath(), '..')
}

export function firmwareTemplateDir(backend: FirmwareBackend): string {
  return join(firmwareTemplateRoot(), backend === 'nuttx' ? 'firmware-nuttx' : 'firmware')
}

export interface FirmwareProject {
  root: string
  backend: FirmwareBackend
  chip?: string
  nuttxBoard?: string
  nuttxProfile?: NuttxProfile
}

/** 裸 ESP-IDF 工程可无清单；NuttX 工程必须显式声明后端以避免误调用 idf.py。 */
export async function resolveFirmwareProject(root: string, requestedBackend?: FirmwareBackend): Promise<FirmwareProject> {
  const abs = resolve(root)
  let manifest: Partial<PixelboxManifest> = {}
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(join(abs, 'pixelbox.json'), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('toolchain:notFirmwareProject')
    manifest = raw as Partial<PixelboxManifest>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('toolchain:notFirmwareProject')
  }
  if (manifest.type !== undefined && manifest.type !== 'firmware') throw new Error('toolchain:notFirmwareProject')
  const backend = manifest.firmwareBackend ?? 'esp-idf'
  if (!isFirmwareBackend(backend)) throw new Error('toolchain:notFirmwareProject')
  if (requestedBackend !== undefined && requestedBackend !== backend) throw new Error('toolchain:backendMismatch')
  const required = backend === 'nuttx' ? ['scripts/nuttx.py', 'src/main.c'] : ['CMakeLists.txt']
  if (!required.every((file) => existsSync(join(abs, file)))) throw new Error('toolchain:notFirmwareProject')
  let nuttxProfile: NuttxProfile | undefined
  if (backend === 'nuttx') {
    const profile = manifest.nuttxProfile ?? 'esp32s3'
    if (!isNuttxProfile(profile)) throw new Error('toolchain:notFirmwareProject')
    const chip = typeof manifest.chip === 'string' ? manifest.chip : 'esp32s3'
    if (nuttxProfileChip(profile) !== chip) throw new Error('toolchain:unsupportedBackendTarget')
    nuttxProfile = profile
  }
  return {
    root: abs,
    backend,
    ...(typeof manifest.chip === 'string' ? { chip: manifest.chip } : {}),
    ...(typeof manifest.nuttxBoard === 'string' ? { nuttxBoard: manifest.nuttxBoard } : {}),
    ...(nuttxProfile ? { nuttxProfile } : {})
  }
}
