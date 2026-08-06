/**
 * selfcheck「运行时初始化断言」入口(由 scripts/selfcheck.mjs 用 esbuild 打包后
 * 在 Node vm 中执行,vm 沙箱预置最小 DOM 桩:document.createElement('canvas') 等)
 *
 * 断言内容(真实实例化沙箱运行时的核心类,非静态正则):
 *   1. 368×448(内置档案 esp32s3):ScreenImpl 帧缓冲 flush 出 368×448×4 字节帧;
 *      system.info() 的 chip/screen/capabilities 与能力表一致;psramFree > 0
 *   2. 240×240(esp32c6 档案):flush 出 240×240×4 字节帧;info().screen=240×240;
 *      psramFree === 0(C6 无 PSRAM,能力表强制)
 *   3. 能力表行为:esp32p4 wifi=false(connect ENOTSUP 语义入口)、esp32c6 psram=false
 *   4. capabilities 字段集合与 CAPABILITY_KEYS 完全一致(d.ts 对齐由 selfcheck 主脚本比对)
 *
 * 全部通过后输出 "RUNTIME_INIT_OK";任一断言失败抛错(selfcheck 判失败)。
 */
import { ScreenImpl, type ImageResolver } from '../../src/renderer/src/device-sim/sandbox/runtime/screen'
import { PeriphMirror, createSystem } from '../../src/renderer/src/device-sim/sandbox/runtime/periph'
import { createWifi } from '../../src/renderer/src/device-sim/sandbox/runtime/net'
import type { HostLink } from '../../src/renderer/src/device-sim/sandbox/runtime/rpc'
import type { PeriphSnapshot, SimDeviceInit } from '../../src/renderer/src/device-sim/protocol'
import {
  CAPABILITY_KEYS,
  chipCapability,
  defaultCapabilities
} from '../../src/shared/chipCapabilities'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`运行时初始化断言失败: ${msg}`)
}

// ---------------------------------------------------------------
// 桩:HostLink(捕获 emit 的帧)/ ImageResolver / 外设快照
// ---------------------------------------------------------------

interface CapturedFrame {
  buf: ArrayBuffer
  width: number
  height: number
}

function makeLink(captured: CapturedFrame[]): HostLink {
  return {
    call: () => Promise.resolve(null),
    emit: (name: string, data?: unknown) => {
      if (name === 'frame') captured.push(data as CapturedFrame)
    },
    on: () => () => undefined
  } as unknown as HostLink
}

const resolverStub = {
  resolve() {
    throw new Error('selfcheck 不触达图片解码')
  },
  decode() {
    throw new Error('selfcheck 不触达图片解码')
  },
  readBytes() {
    throw new Error('selfcheck 不触达文件读取')
  }
} as unknown as ImageResolver

const PERIPH: PeriphSnapshot = {
  battery: { level: 88, charging: false },
  imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 },
  gps: { lat: 31.2304, lng: 121.4737 },
  led: { available: false, count: 8 }
}

function deviceOf(chip: string, w: number, h: number, psramMB: number): SimDeviceInit {
  const cap = chipCapability(chip)
  return {
    chip,
    name: `check-${chip}`,
    screenW: w,
    screenH: h,
    psramMB: cap.psram ? psramMB : 0,
    flashMB: 16,
    capabilities: defaultCapabilities(chip),
    wifi: cap.wifi
  }
}

// ---------------------------------------------------------------
// 单档案断言:屏幕帧尺寸 + system.info()/memory()
// ---------------------------------------------------------------

function checkProfile(chip: string, w: number, h: number, psramMB: number, expectPsramFree0: boolean): void {
  const frames: CapturedFrame[] = []
  const link = makeLink(frames)
  const device = deviceOf(chip, w, h, psramMB)

  // 屏幕:构造 + flush,帧尺寸必须等于档案分辨率(动态,无 368×448 硬编码)
  const screen = new ScreenImpl(link, resolverStub, 80, { width: w, height: h })
  assert(screen.width === w && screen.height === h, `ScreenImpl 尺寸应为 ${w}×${h}`)
  screen.flush()
  assert(frames.length === 1, 'flush 应上报一帧')
  assert(frames[0].width === w && frames[0].height === h, `帧尺寸应为 ${w}×${h}`)
  assert(frames[0].buf.byteLength === w * h * 4, `帧缓冲应为 ${w * h * 4} 字节 RGBA`)

  // system:info()/memory() 与档案、能力表一致
  const mirror = new PeriphMirror(link, PERIPH)
  const system = createSystem(link, mirror, 'sim-check', screen, () => undefined, device) as {
    info(): {
      chip: string
      screen: { width: number; height: number }
      capabilities: Record<string, boolean>
    }
    memory(): { heapFree: number; psramFree: number; jsHeapUsed: number }
  }
  const info = system.info()
  assert(info.chip === chip, `info().chip 应为 ${chip},实际 ${info.chip}`)
  assert(
    info.screen.width === w && info.screen.height === h,
    `info().screen 应为 ${w}×${h},实际 ${info.screen.width}×${info.screen.height}`
  )
  const keys = Object.keys(info.capabilities).sort()
  const expected = [...CAPABILITY_KEYS].sort()
  assert(
    keys.length === expected.length && keys.every((k, i) => k === expected[i]),
    `info().capabilities 字段应为 [${expected.join(',')}],实际 [${keys.join(',')}]`
  )
  const mem = system.memory()
  if (expectPsramFree0) {
    assert(mem.psramFree === 0, `${chip} 无 PSRAM,psramFree 应为 0,实际 ${mem.psramFree}`)
  } else {
    assert(mem.psramFree > 0, `${chip} PSRAM ${psramMB}MB,psramFree 应 > 0`)
  }
}

// 1) 内置档案 368×448(esp32s3 / PSRAM 8MB)
checkProfile('esp32s3', 368, 448, 8, false)
// 2) 240×240 档案(esp32c6,无 PSRAM → psramFree 恒 0)
checkProfile('esp32c6', 240, 240, 8 /* 会被能力表强制为 0 */, true)

// 3) 能力表驱动的 wifi ENOTSUP(esp32p4 无片上 WiFi)
{
  const p4 = chipCapability('esp32p4')
  assert(!p4.wifi && !p4.ble && p4.psram, 'esp32p4 能力应为 无WiFi/无BLE/有PSRAM')
  const wifi = createWifi(() => undefined, p4.wifi) as {
    status(): { connected: boolean }
    connect(ssid: string): Promise<unknown>
  }
  assert(wifi.status().connected === false, 'P4 wifi.status() 应为离线')
  // connect 必须以 ENOTSUP 拒绝(异步断言,失败时以退出码体现)
  void wifi.connect('AP').then(
    () => {
      throw new Error('运行时初始化断言失败: P4 wifi.connect 不应成功')
    },
    (err: Error) => {
      if (!/ENOTSUP/.test(err.message)) {
        throw new Error(`运行时初始化断言失败: P4 wifi.connect 错误应含 ENOTSUP,实际 ${err.message}`)
      }
    }
  )
  const c6 = chipCapability('esp32c6')
  assert(!c6.psram && c6.psramOptionsMB.length === 1 && c6.psramOptionsMB[0] === 0, 'esp32c6 应无 PSRAM 档位')
}

console.log('RUNTIME_INIT_OK')
