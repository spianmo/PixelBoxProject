import assert from 'node:assert/strict'
import test from 'node:test'
import { CHIP_IDS } from '../../../shared/chipCapabilities'
import type { FirmwareStatus } from '../../../shared/ipc-types'
import {
  firmwareBackendLabel,
  firmwareChipTargets,
  firmwareManifestChip,
  firmwareTaskFromStatus
} from './firmware'

test('NuttX 创建向导和标题栏只开放已有配置的 ESP32-S3', () => {
  assert.deepEqual(firmwareChipTargets('nuttx'), ['esp32s3'])
  assert.equal(firmwareChipTargets('nuttx').includes('esp32p4'), false)
  assert.equal(firmwareBackendLabel('nuttx'), 'NuttX')
})

test('ESP-IDF 保留完整芯片列表和独立后端标识', () => {
  assert.deepEqual(firmwareChipTargets('esp-idf'), CHIP_IDS)
  assert.equal(firmwareChipTargets('esp-idf').includes('esp32p4'), true)
  assert.equal(firmwareBackendLabel('esp-idf'), 'ESP-IDF')
})

test('清单芯片必须属于当前固件后端支持范围', () => {
  assert.equal(firmwareManifestChip('nuttx', 'esp32s3'), 'esp32s3')
  assert.equal(firmwareManifestChip('nuttx', 'esp32c6'), null)
  assert.equal(firmwareManifestChip('esp-idf', 'esp32c6'), 'esp32c6')
  assert.equal(firmwareManifestChip('nuttx', 42), null)
})

test('renderer 恢复 NuttX 任务时保留主进程的后端和目标芯片', () => {
  assert.deepEqual(
    firmwareTaskFromStatus({ running: 'flash', target: 'esp32s3', firmwareBackend: 'nuttx' }),
    { kind: 'flash', target: 'esp32s3', firmwareBackend: 'nuttx' }
  )
})

test('旧版任务状态缺少后端时保持 ESP-IDF 语义', () => {
  assert.deepEqual(firmwareTaskFromStatus({ running: 'merge', target: 'esp32p4' }), {
    kind: 'merge',
    target: 'esp32p4',
    firmwareBackend: 'esp-idf'
  })
})

test('空闲状态不借用残留的后端和目标生成任务', () => {
  assert.equal(firmwareTaskFromStatus({ running: null, target: null }), null)
  assert.equal(firmwareTaskFromStatus({ running: null, target: 'esp32s3', firmwareBackend: 'nuttx' }), null)
})

test('运行状态缺少目标时仍保留忙碌状态和取消入口', () => {
  assert.deepEqual(
    firmwareTaskFromStatus({ running: 'build', target: null, firmwareBackend: 'nuttx' }),
    { kind: 'build', target: null, firmwareBackend: 'nuttx' }
  )
})

test('已恢复的运行任务不受后续状态与工作区目标变更影响', () => {
  const status: FirmwareStatus = { running: 'build', target: 'esp32s3', firmwareBackend: 'nuttx' }
  const task = firmwareTaskFromStatus(status)
  status.target = 'esp32p4'
  status.firmwareBackend = 'esp-idf'
  assert.deepEqual(task, { kind: 'build', target: 'esp32s3', firmwareBackend: 'nuttx' })
})
