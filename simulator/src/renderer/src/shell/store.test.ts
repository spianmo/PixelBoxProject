import assert from 'node:assert/strict'
import test from 'node:test'

// store.ts 启动时读取 localStorage；宿主测试提供最小实现即可覆盖纯设备选择逻辑。
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined
  }
})

const storeModule = import('./deviceSelection')

const device = {
  name: 'PixelBox',
  host: 'pixelbox.local',
  ip: '192.168.1.42',
  port: 8765,
  txt: {}
}

test('默认虚拟设备首次发现真机时自动选择真机', async () => {
  const { autoSelectedDeviceKey, DEFAULT_SIM_KEY, deviceKey } = await storeModule
  assert.equal(
    autoSelectedDeviceKey({ devices: [], selectedKey: DEFAULT_SIM_KEY }, [device], false),
    deviceKey(device)
  )
})

test('模拟器运行中不抢占用户当前设备', async () => {
  const { autoSelectedDeviceKey, DEFAULT_SIM_KEY } = await storeModule
  assert.equal(
    autoSelectedDeviceKey({ devices: [], selectedKey: DEFAULT_SIM_KEY }, [device], true),
    null
  )
})

test('用户已选真机或已有设备列表时不重复切换', async () => {
  const { autoSelectedDeviceKey, DEFAULT_SIM_KEY, deviceKey } = await storeModule
  assert.equal(
    autoSelectedDeviceKey({ devices: [], selectedKey: deviceKey(device) }, [device], false),
    null
  )
  assert.equal(
    autoSelectedDeviceKey({ devices: [device], selectedKey: DEFAULT_SIM_KEY }, [device], false),
    null
  )
})

test('没有真机时保持默认虚拟设备', async () => {
  const { autoSelectedDeviceKey, DEFAULT_SIM_KEY } = await storeModule
  assert.equal(autoSelectedDeviceKey({ devices: [], selectedKey: DEFAULT_SIM_KEY }, [], false), null)
})
