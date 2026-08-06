/**
 * IDE 外壳共享状态(标题栏 / 状态栏 / 底部日志工具窗 / 设备管理器联动)
 *
 * 设计:复用 device-sim 的轻量可订阅 store(useSyncExternalStore 友好),
 * 避免跨层 prop drilling;数据源(mDNS 发现 / 虚拟设备档案)由 App 写入。
 *
 * 阶段 2:
 * - deviceProfilesStore:虚拟设备档案(main 进程 devices.json 持久化)
 * - selectedKey 支持 'sim:<profileId>'(虚拟档案)或 'ip:port'(mDNS 真机),
 *   运行/推送按 key 分流;
 * - chip 与固件构建(idf.py set-target)联动为阶段 3 接入点。
 */
import { useSyncExternalStore } from 'react'
import { createStore, type Store } from '../device-sim/store'
import { isSimDeviceKey, simDeviceKey } from '../device-sim/sessions'
import type { DevdDevice, DeviceProfile } from '../../../shared/ipc-types'
import {
  BUILTIN_DEVICE_PROFILE,
  BUILTIN_PROFILE_ID,
  CHIP_IDS,
  type ChipId
} from '../../../shared/chipCapabilities'

export { isSimDeviceKey, simDeviceKey }
export { BUILTIN_PROFILE_ID }

/** 内置默认虚拟设备的 key(初始选中) */
export const DEFAULT_SIM_KEY = simDeviceKey(BUILTIN_PROFILE_ID)

/** 目标芯片(固件构建目标;与设备档案芯片相互独立) */
export const CHIP_TARGETS = CHIP_IDS
export type ChipTarget = ChipId

/** 芯片显示名 */
export function chipLabel(chip: string): string {
  return chip.replace(/^esp32(.+)$/, (_m, s: string) => `ESP32-${s.toUpperCase()}`).replace(/^esp32$/, 'ESP32')
}

export function deviceKey(d: DevdDevice): string {
  return `${d.ip}:${d.port}`
}

const CHIP_STORAGE_KEY = 'pixelbox-sim.chip'

export interface ShellDeviceState {
  /** mDNS 发现的真机 */
  devices: DevdDevice[]
  /** 当前目标设备:'sim:<profileId>' 或真机 ip:port */
  selectedKey: string
  scanning: boolean
  /** 目标芯片(标题栏下拉,阶段 3 接入 idf.py set-target) */
  chip: ChipTarget
}

function initialChip(): ChipTarget {
  const saved = localStorage.getItem(CHIP_STORAGE_KEY)
  return (CHIP_TARGETS as readonly string[]).includes(saved ?? '') ? (saved as ChipTarget) : 'esp32s3'
}

/** 设备/芯片选择(标题栏 ⇄ 底部日志设备下拉 ⇄ 状态栏联动) */
export const shellDeviceStore: Store<ShellDeviceState> = createStore<ShellDeviceState>({
  devices: [],
  selectedKey: DEFAULT_SIM_KEY,
  scanning: false,
  chip: initialChip()
})

export function setChip(chip: ChipTarget): void {
  shellDeviceStore.set({ chip })
  localStorage.setItem(CHIP_STORAGE_KEY, chip)
}

/**
 * 应用设置页的「默认目标芯片」:仅当本地尚无芯片选择记忆时生效
 * (用户在标题栏手动切过芯片后,以其选择为准)
 */
export function applyDefaultChip(chip: string): void {
  if (localStorage.getItem(CHIP_STORAGE_KEY)) return
  if ((CHIP_TARGETS as readonly string[]).includes(chip)) {
    shellDeviceStore.set({ chip: chip as ChipTarget })
  }
}

/** React hook:订阅外壳设备状态 */
export function useShellDevices(): ShellDeviceState {
  return useSyncExternalStore(shellDeviceStore.subscribe, shellDeviceStore.get)
}

// ---------------------------------------------------------------
// 虚拟设备档案(设备管理器数据源,main 进程持久化)
// ---------------------------------------------------------------

export interface DeviceProfilesState {
  profiles: DeviceProfile[]
  /** 首次加载完成(避免启动瞬间空列表闪烁) */
  loaded: boolean
}

/** 档案列表(内置档案恒在首位;初值先放内置档案,IPC 加载后覆写) */
export const deviceProfilesStore: Store<DeviceProfilesState> = createStore<DeviceProfilesState>({
  profiles: [BUILTIN_DEVICE_PROFILE],
  loaded: false
})

/** React hook:订阅档案列表 */
export function useDeviceProfiles(): DeviceProfilesState {
  return useSyncExternalStore(deviceProfilesStore.subscribe, deviceProfilesStore.get)
}

/** 启动/变更后刷新档案列表 */
export async function refreshDeviceProfiles(): Promise<void> {
  try {
    const profiles = await window.api.deviceProfilesList()
    deviceProfilesStore.set({ profiles, loaded: true })
    ensureSelectedKeyValid()
  } catch {
    // IPC 失败保留内置档案兜底
    deviceProfilesStore.set({ loaded: true })
  }
}

/** 新建/编辑档案;成功返回 null,失败返回错误码(profile:xxx) */
export async function saveDeviceProfile(p: DeviceProfile): Promise<string | null> {
  try {
    const profiles = await window.api.deviceProfilesSave(p)
    deviceProfilesStore.set({ profiles, loaded: true })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 删除档案(内置档案由 main 拒绝);成功返回 null */
export async function deleteDeviceProfile(id: string): Promise<string | null> {
  try {
    const profiles = await window.api.deviceProfilesDelete(id)
    deviceProfilesStore.set({ profiles, loaded: true })
    ensureSelectedKeyValid()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 按外壳 key 找档案('sim:<id>') */
export function profileByKey(key: string): DeviceProfile | null {
  if (!isSimDeviceKey(key)) return null
  const id = key.slice('sim:'.length)
  return deviceProfilesStore.get().profiles.find((p) => p.id === id) ?? null
}

/** 档案被删除后,选中 key 失效时回退内置档案 */
function ensureSelectedKeyValid(): void {
  const s = shellDeviceStore.get()
  if (isSimDeviceKey(s.selectedKey) && !profileByKey(s.selectedKey)) {
    shellDeviceStore.set({ selectedKey: DEFAULT_SIM_KEY })
  }
}

/** 当前选中设备的显示名(状态栏右侧) */
export function selectedDeviceName(s: ShellDeviceState, fallback: string): string {
  if (isSimDeviceKey(s.selectedKey)) return profileByKey(s.selectedKey)?.name ?? fallback
  const d = s.devices.find((x) => deviceKey(x) === s.selectedKey)
  return d ? d.name : fallback
}
