import type { FirmwareBackend, NuttxProfile } from './ipc-types'

/** 仅列出已有板级配置与运行时的目标，避免把 ESP-IDF 目标误当作 NuttX 支持。 */
export const NUTTX_TARGETS = ['esp32s3'] as const
export const NUTTX_PROFILES = ['esp32s3', 'esp32s3-multinet7', 'esp32s3-timed-sleep'] as const

export function isNuttxProfile(value: unknown): value is NuttxProfile {
  return (NUTTX_PROFILES as readonly string[]).includes(value as string)
}

/** profile 的基础芯片，用于校验清单不会把其它芯片误配到 ESP32-S3 runner。 */
export function nuttxProfileChip(profile: NuttxProfile): string {
  return profile.startsWith('esp32s3') ? 'esp32s3' : profile
}

export function isFirmwareBackend(value: unknown): value is FirmwareBackend {
  return value === 'esp-idf' || value === 'nuttx'
}

export function supportsFirmwareTarget(backend: FirmwareBackend, target: string): boolean {
  return backend === 'esp-idf' || (NUTTX_TARGETS as readonly string[]).includes(target)
}
