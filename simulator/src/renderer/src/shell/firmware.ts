import type { FirmwareBackend, FirmwareStatus, FirmwareTaskKind } from '../../../shared/ipc-types'
import { CHIP_IDS, type ChipId } from '../../../shared/chipCapabilities'
import { NUTTX_TARGETS } from '../../../shared/firmwareBackends'

/** 运行任务固定使用启动时的后端与芯片，不随当前工作区、设备选择变化。 */
export interface ActiveFirmwareTask {
  readonly kind: FirmwareTaskKind
  readonly target: string | null
  readonly firmwareBackend: FirmwareBackend
}

/** renderer 重载时恢复主进程的真实任务上下文，旧状态默认属于 ESP-IDF。 */
export function firmwareTaskFromStatus(status: FirmwareStatus): ActiveFirmwareTask | null {
  if (!status.running) return null
  return {
    kind: status.running,
    target: status.target,
    firmwareBackend: status.firmwareBackend ?? 'esp-idf'
  }
}

export function firmwareBackendLabel(backend: FirmwareBackend): string {
  return backend === 'nuttx' ? 'NuttX' : 'ESP-IDF'
}

/** 创建向导和标题栏共用主进程声明的目标列表，避免 UI 允许尚无板级配置的芯片。 */
export function firmwareChipTargets(backend: FirmwareBackend): readonly ChipId[] {
  return backend === 'nuttx' ? NUTTX_TARGETS : CHIP_IDS
}

/** 读取清单芯片时同时校验后端支持范围，避免 NuttX 沿用 ESP-IDF 目标。 */
export function firmwareManifestChip(backend: FirmwareBackend, value: unknown): ChipId | null {
  if (typeof value !== 'string') return null
  return (firmwareChipTargets(backend) as readonly string[]).includes(value) ? (value as ChipId) : null
}
