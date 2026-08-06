/**
 * 芯片能力表 —— 虚拟设备芯片差异的【单一数据源】
 *
 * 被三端共同引用:
 *   - main 进程(deviceProfiles.ts):档案 CRUD 的字段校验(PSRAM 档位 / 芯片合法性)
 *   - renderer 外壳(设备管理器向导 / 表格):驱动 PSRAM 下拉禁用、P4 提示等 UI 行为
 *   - 沙箱运行时(sandbox/runtime):驱动 px shim 的 system.info() capabilities、
 *     memory().psramFree、wifi ENOTSUP 行为(经 SandboxInitPayload.device 注入)
 *
 * 注意:本文件含运行时常量(非纯类型),不要并入 ipc-types.ts。
 */
import type { DeviceProfile } from './ipc-types'

/** 支持的芯片型号(与标题栏目标芯片下拉一致) */
export const CHIP_IDS = ['esp32s3', 'esp32c6', 'esp32p4', 'esp32', 'esp32c3'] as const
export type ChipId = (typeof CHIP_IDS)[number]

/**
 * d.ts 契约 PxDeviceInfo.capabilities 的全部字段名。
 * selfcheck 会静态比对本清单与 sdk/types/pixelbox.d.ts,保证两边不漂移。
 */
export const CAPABILITY_KEYS = [
  'camera',
  'gps',
  'ble',
  'led',
  'imu',
  'touch',
  'battery',
  'mic',
  'speaker'
] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

/** system.info().capabilities 的形状(与 d.ts PxDeviceInfo.capabilities 对齐) */
export type SimCapabilities = Record<CapabilityKey, boolean>

/** 单颗芯片的能力描述 */
export interface ChipCapability {
  chip: ChipId
  /** 显示名(向导/表格) */
  label: string
  /** 片上 WiFi(false 时模拟器 wifi.connect 抛 ENOTSUP) */
  wifi: boolean
  /** 片上 BLE(false 时 ble.available() 恒 false;true 时也按真机默认 Kconfig 关闭) */
  ble: boolean
  /** 是否支持外挂 PSRAM(false 时档案 psramMB 强制 0,向导禁用该下拉) */
  psram: boolean
  /** 双核(仅信息展示,模拟器不模拟核数) */
  dualCore: boolean
  /** 向导可选 PSRAM 档位(MB) */
  psramOptionsMB: readonly number[]
  /** UI 附加提示的 i18n key 后缀(如 P4 需配套 C6 hosted 模块) */
  hintKey?: string
}

/** PSRAM 档位:无 / 2MB / 8MB(不支持 PSRAM 的芯片只有 0) */
const PSRAM_FULL = [0, 2, 8] as const
const PSRAM_NONE = [0] as const

/** Flash 档位(MB),全芯片一致 */
export const FLASH_OPTIONS_MB = [4, 8, 16] as const

/** 能力表本体(按向导下拉顺序排列) */
export const CHIP_CAPABILITIES: readonly ChipCapability[] = [
  {
    chip: 'esp32s3',
    label: 'ESP32-S3',
    wifi: true,
    ble: true,
    psram: true, // PSRAM 可选(2/8MB)
    dualCore: true,
    psramOptionsMB: PSRAM_FULL
  },
  {
    chip: 'esp32c6',
    label: 'ESP32-C6',
    wifi: true,
    ble: true,
    psram: false, // 无 PSRAM → 档案 psramMB 强制 0,向导禁用
    dualCore: false,
    psramOptionsMB: PSRAM_NONE
  },
  {
    chip: 'esp32p4',
    label: 'ESP32-P4',
    wifi: false, // 无片上 WiFi:模拟中 wifi.connect 报 ENOTSUP
    ble: false, // 无片上 BLE:ble.available() === false
    psram: true, // 有 PSRAM
    dualCore: true,
    psramOptionsMB: PSRAM_FULL,
    hintKey: 'p4Hosted' // UI 提示:需配套 ESP32-C6 hosted 模块提供 WiFi/BLE
  },
  {
    chip: 'esp32',
    label: 'ESP32',
    wifi: true,
    ble: true,
    psram: true, // 经典 ESP32 支持外挂 PSRAM
    dualCore: true,
    psramOptionsMB: PSRAM_FULL
  },
  {
    chip: 'esp32c3',
    label: 'ESP32-C3',
    wifi: true,
    ble: true,
    psram: false, // C3 无 PSRAM 接口
    dualCore: false,
    psramOptionsMB: PSRAM_NONE
  }
] as const

/** 按芯片查能力(未知芯片回退 esp32s3,保证运行时永不缺表) */
export function chipCapability(chip: string): ChipCapability {
  return CHIP_CAPABILITIES.find((c) => c.chip === chip) ?? CHIP_CAPABILITIES[0]
}

/**
 * 生成 system.info().capabilities(d.ts 形状)。
 * - camera/gps/imu/touch/battery/mic/speaker:模拟器均可用(映射宿主外设/面板)
 * - ble:恒 false —— 有片上 BLE 的芯片按真机默认 Kconfig 关闭,无片上(P4)本就没有
 * - led:静态默认 false,运行期由外设面板开关覆写(mirror.snapshot.led.available)
 */
export function defaultCapabilities(chip: string): SimCapabilities {
  void chipCapability(chip) // 未知芯片也走统一回退语义
  return {
    camera: true,
    gps: true,
    ble: false,
    led: false,
    imu: true,
    touch: true,
    battery: true,
    mic: true,
    speaker: true
  }
}

/** 屏幕分辨率合法范围(向导校验) */
export const SCREEN_MIN = 64
export const SCREEN_MAX = 1024

/** 内置默认档案 ID(main 持久化层与 renderer 外壳共用) */
export const BUILTIN_PROFILE_ID = 'pixelbox-s3'

/**
 * 内置默认档案「PixelBox S3」:AMOLED 1.8″ 368×448 / PSRAM 8MB。
 * 恒在设备列表首位,不可编辑、不可删除(可复制);不落盘。
 */
export const BUILTIN_DEVICE_PROFILE: DeviceProfile = Object.freeze({
  id: BUILTIN_PROFILE_ID,
  name: 'PixelBox S3',
  chip: 'esp32s3',
  screenW: 368,
  screenH: 448,
  psramMB: 8,
  flashMB: 16,
  note: 'AMOLED 1.8″ 内置档案',
  createdAt: 0
})

/** 校验档案字段(main 与向导共用);返回错误码 key(i18n)或 null */
export function validateProfileFields(p: {
  name: string
  chip: string
  screenW: number
  screenH: number
  psramMB: number
  flashMB: number
}): string | null {
  if (p.name.trim().length === 0) return 'nameRequired'
  if (!(CHIP_IDS as readonly string[]).includes(p.chip)) return 'chipInvalid'
  const dims = [p.screenW, p.screenH]
  if (dims.some((v) => !Number.isInteger(v) || v < SCREEN_MIN || v > SCREEN_MAX)) {
    return 'screenRange'
  }
  const cap = chipCapability(p.chip)
  if (!cap.psramOptionsMB.includes(p.psramMB)) return 'psramInvalid'
  if (!(FLASH_OPTIONS_MB as readonly number[]).includes(p.flashMB)) return 'flashInvalid'
  return null
}
