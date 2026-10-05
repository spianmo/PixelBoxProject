import type { DevdDevice } from '../../../shared/ipc-types'
import { BUILTIN_PROFILE_ID } from '../../../shared/chipCapabilities'

/** 内置默认虚拟设备的 key，与 shell/store 的设备选择协议一致。 */
export const DEFAULT_SIM_KEY = `sim:${BUILTIN_PROFILE_ID}`

export function deviceKey(d: DevdDevice): string {
  return `${d.ip}:${d.port}`
}

/**
 * 首次发现真机时是否应把日志/操作目标切到真机。
 *
 * 启动默认选中虚拟设备，但日志订阅必须先有真实设备 key；只在发现列表
 * 从空变为非空、用户仍保持默认虚拟设备且没有运行模拟器时自动切换，避免
 * 后续 mDNS 增量事件抢走用户已经做出的设备选择。
 */
export function autoSelectedDeviceKey(
  previous: { devices: DevdDevice[]; selectedKey: string },
  nextDevices: DevdDevice[],
  simulatorRunning: boolean
): string | null {
  if (
    simulatorRunning ||
    previous.devices.length !== 0 ||
    previous.selectedKey !== DEFAULT_SIM_KEY ||
    nextDevices.length === 0
  ) {
    return null
  }
  return deviceKey(nextDevices[0])
}
