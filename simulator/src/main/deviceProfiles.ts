/**
 * 虚拟设备档案服务(main 进程)—— 类 AVD Manager 的数据层
 *
 * - 档案模型:shared/ipc-types.ts 的 DeviceProfile
 * - 持久化:userData/pixelbox-sim/devices.json(仅存用户档案)
 * - 内置默认档案「PixelBox S3」(368×448 / PSRAM 8MB)恒在列表首位,
 *   不落盘、不可编辑、不可删除(可复制)
 * - 字段校验与 PSRAM 档位约束来自 shared/chipCapabilities.ts(单一数据源)
 */
import { app, ipcMain } from 'electron'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DeviceProfile } from '../shared/ipc-types'
import {
  BUILTIN_DEVICE_PROFILE,
  BUILTIN_PROFILE_ID,
  chipCapability,
  validateProfileFields
} from '../shared/chipCapabilities'

function devicesFile(): string {
  return join(app.getPath('userData'), 'pixelbox-sim', 'devices.json')
}

/** 读取用户档案(损坏/缺失时回退空列表,不影响启动) */
async function loadUserProfiles(): Promise<DeviceProfile[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(devicesFile(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(isProfileShape).filter((p) => p.id !== BUILTIN_PROFILE_ID)
  } catch {
    return []
  }
}

/** 结构校验(容忍旧版本多余字段) */
function isProfileShape(v: unknown): v is DeviceProfile {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.chip === 'string' &&
    typeof p.screenW === 'number' &&
    typeof p.screenH === 'number' &&
    typeof p.psramMB === 'number' &&
    typeof p.flashMB === 'number'
  )
}

async function saveUserProfiles(list: DeviceProfile[]): Promise<void> {
  const file = devicesFile()
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(list, null, 2), 'utf8')
}

/** 完整列表 = 内置档案 + 用户档案(按创建时间排序) */
async function listProfiles(): Promise<DeviceProfile[]> {
  const user = await loadUserProfiles()
  user.sort((a, b) => a.createdAt - b.createdAt)
  return [BUILTIN_DEVICE_PROFILE, ...user]
}

/** 规范化 + 校验一份待保存档案;抛错时消息为 i18n 错误码 */
function normalizeProfile(input: DeviceProfile): DeviceProfile {
  const cap = chipCapability(input.chip)
  const p: DeviceProfile = {
    id: input.id,
    name: String(input.name ?? '').trim().slice(0, 48),
    chip: cap.chip,
    screenW: Math.round(Number(input.screenW)),
    screenH: Math.round(Number(input.screenH)),
    // 不支持 PSRAM 的芯片强制 0(与向导禁用行为双保险)
    psramMB: cap.psram ? Number(input.psramMB) : 0,
    flashMB: Number(input.flashMB),
    note: String(input.note ?? '').slice(0, 200),
    createdAt: typeof input.createdAt === 'number' && input.createdAt > 0 ? input.createdAt : Date.now()
  }
  const err = validateProfileFields(p)
  if (err) throw new Error(`profile:${err}`)
  return p
}

export function registerDeviceProfilesIpc(): void {
  // ---- 列表 ----
  ipcMain.handle('devices:list', async (): Promise<DeviceProfile[]> => listProfiles())

  // ---- 新建/编辑(upsert,按 id 匹配);返回更新后的完整列表 ----
  ipcMain.handle('devices:save', async (_e, input: DeviceProfile): Promise<DeviceProfile[]> => {
    if (input.id === BUILTIN_PROFILE_ID) {
      throw new Error('profile:builtinReadonly') // 内置档案不可编辑
    }
    const p = normalizeProfile({
      ...input,
      id: input.id && input.id.length > 0 ? input.id : `dev-${randomBytes(5).toString('hex')}`
    })
    const user = await loadUserProfiles()
    const idx = user.findIndex((x) => x.id === p.id)
    if (idx >= 0) user[idx] = { ...p, createdAt: user[idx].createdAt }
    else user.push(p)
    await saveUserProfiles(user)
    return listProfiles()
  })

  // ---- 删除(内置档案拒绝);返回更新后的完整列表 ----
  ipcMain.handle('devices:delete', async (_e, id: string): Promise<DeviceProfile[]> => {
    if (id === BUILTIN_PROFILE_ID) {
      throw new Error('profile:builtinUndeletable') // 内置默认档案不可删
    }
    const user = (await loadUserProfiles()).filter((p) => p.id !== id)
    await saveUserProfiles(user)
    return listProfiles()
  })
}

/** 首次启动时确保存储目录存在(非必需,失败静默) */
export async function ensureDeviceProfilesDir(): Promise<void> {
  try {
    const file = devicesFile()
    if (!existsSync(dirname(file))) await fsp.mkdir(dirname(file), { recursive: true })
  } catch {
    // 忽略:落盘时会再次尝试创建
  }
}
