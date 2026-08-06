/**
 * 外设域:px.input / px.sensors / px.gps / px.led / px.ble / px.camera / px.system / px.app
 *
 * 数据源是右侧虚拟外设面板:宿主把面板状态经 'periph' 事件推入沙箱镜像(PeriphMirror),
 * 各命名空间从镜像读取;反向(led 灯带内容、屏幕控制)经事件/RPC 推回面板。
 * ble 与真机默认 Kconfig 一致:available() === false,其余方法抛 Error("ENOTSUP")。
 */
import type { HostLink } from './rpc'
import { Emitter, NamedEmitter } from './events'
import { clamp } from './util'
import type {
  PeriphSnapshot,
  TouchEventPayload,
  ButtonEventPayload,
  CameraFramePayload,
  SimDeviceInit
} from '../../protocol'

// ---------------------------------------------------------------
// 外设状态镜像
// ---------------------------------------------------------------

export class PeriphMirror {
  snapshot: PeriphSnapshot
  readonly changed = new Emitter<PeriphSnapshot>()
  readonly shake = new Emitter<void>()
  readonly touch = new Emitter<TouchEventPayload>()
  readonly buttonRaw = new Emitter<ButtonEventPayload>()

  constructor(link: HostLink, initial: PeriphSnapshot) {
    this.snapshot = initial
    link.on<PeriphSnapshot>('periph', (s) => {
      this.snapshot = s
      this.changed.emit(s)
    })
    link.on('shake', () => this.shake.emit())
    link.on<TouchEventPayload>('touch', (t) => this.touch.emit(t))
    link.on<ButtonEventPayload>('button', (b) => this.buttonRaw.emit(b))
  }
}

// ---------------------------------------------------------------
// px.input(触摸 + 按键 + 手势)
// ---------------------------------------------------------------

const LONG_PRESS_MS = 600
const DOUBLE_CLICK_MS = 300
const GESTURE_MIN_DIST = 30

export function createInput(mirror: PeriphMirror): Record<string, unknown> {
  const touchEmitter = new Emitter<TouchEventPayload>()
  const buttonEmitter = new Emitter<{ id: 'boot' | number; type: string }>()
  const gestureEmitter = new Emitter<{ dir: 'left' | 'right' | 'up' | 'down'; distance: number }>()

  // ---- 触摸转发 + 手势合成 ----
  let downX = 0
  let downY = 0
  let tracking = false
  mirror.touch.on((ev) => {
    touchEmitter.emit(ev)
    if (ev.type === 'down') {
      tracking = true
      downX = ev.x
      downY = ev.y
    } else if (ev.type === 'up' && tracking) {
      tracking = false
      const dx = ev.x - downX
      const dy = ev.y - downY
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)
      if (Math.max(adx, ady) >= GESTURE_MIN_DIST) {
        if (adx >= ady) {
          gestureEmitter.emit({ dir: dx > 0 ? 'right' : 'left', distance: Math.round(adx) })
        } else {
          gestureEmitter.emit({ dir: dy > 0 ? 'down' : 'up', distance: Math.round(ady) })
        }
      }
    }
  })

  // ---- BOOT 键:down/up 原始事件 → click/doubleClick/longPress 合成 ----
  let pressedAt = 0
  let longPressTimer: number | null = null
  let longPressFired = false
  let lastClickAt = 0
  mirror.buttonRaw.on((ev) => {
    if (ev.type === 'down') {
      pressedAt = performance.now()
      longPressFired = false
      buttonEmitter.emit({ id: 'boot', type: 'down' })
      longPressTimer = window.setTimeout(() => {
        longPressFired = true
        buttonEmitter.emit({ id: 'boot', type: 'longPress' })
      }, LONG_PRESS_MS)
    } else {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
      buttonEmitter.emit({ id: 'boot', type: 'up' })
      const dur = performance.now() - pressedAt
      if (!longPressFired && dur < LONG_PRESS_MS) {
        buttonEmitter.emit({ id: 'boot', type: 'click' })
        const now = performance.now()
        if (now - lastClickAt <= DOUBLE_CLICK_MS) {
          buttonEmitter.emit({ id: 'boot', type: 'doubleClick' })
          lastClickAt = 0
        } else {
          lastClickAt = now
        }
      }
    }
  })

  return {
    onTouch(cb: (ev: TouchEventPayload) => void): () => void {
      return touchEmitter.on(cb)
    },
    onButton(cb: (ev: { id: 'boot' | number; type: string }) => void): () => void {
      return buttonEmitter.on(cb)
    },
    onGesture(cb: (ev: { dir: string; distance: number }) => void): () => void {
      return gestureEmitter.on(cb)
    }
  }
}

// ---------------------------------------------------------------
// px.sensors(IMU)
// ---------------------------------------------------------------

type Orientation = 'up' | 'down' | 'left' | 'right' | 'flat' | 'faceDown'

function computeOrientation(ax: number, ay: number, az: number): Orientation {
  const aax = Math.abs(ax)
  const aay = Math.abs(ay)
  const aaz = Math.abs(az)
  if (aaz >= aax && aaz >= aay) return az >= 0 ? 'flat' : 'faceDown'
  if (aax >= aay) return ax >= 0 ? 'right' : 'left'
  return ay >= 0 ? 'up' : 'down'
}

export function createSensors(mirror: PeriphMirror): Record<string, unknown> {
  let imuTimer: number | null = null
  const orientationEmitter = new Emitter<Orientation>()
  let lastOrientation: Orientation | null = null

  // 姿态变化检测(由面板滑条驱动)
  mirror.changed.on((s) => {
    const o = computeOrientation(s.imu.ax, s.imu.ay, s.imu.az)
    if (o !== lastOrientation) {
      lastOrientation = o
      orientationEmitter.emit(o)
    }
  })

  return {
    imu: {
      available(): boolean {
        return true
      },
      start(opts: { rateHz?: number; onData: (d: unknown) => void }): void {
        if (!opts || typeof opts.onData !== 'function') throw new Error('imu.start 需要 onData 回调')
        if (imuTimer !== null) clearInterval(imuTimer)
        const rate = clamp(opts.rateHz ?? 50, 1, 200)
        imuTimer = window.setInterval(() => {
          const m = mirror.snapshot.imu
          // 叠加少量噪声,更接近真实传感器
          const n = (): number => (Math.random() - 0.5) * 0.01
          opts.onData({
            ax: m.ax + n(),
            ay: m.ay + n(),
            az: m.az + n(),
            gx: m.gx + n() * 10,
            gy: m.gy + n() * 10,
            gz: m.gz + n() * 10
          })
        }, 1000 / rate)
      },
      stop(): void {
        if (imuTimer !== null) {
          clearInterval(imuTimer)
          imuTimer = null
        }
      },
      onShake(cb: () => void): () => void {
        return mirror.shake.on(cb)
      },
      onOrientation(cb: (o: Orientation) => void): () => void {
        return orientationEmitter.on(cb)
      }
    }
  }
}

// ---------------------------------------------------------------
// px.gps
// ---------------------------------------------------------------

interface GpsFix {
  lat: number
  lng: number
  altitudeM: number
  speedMps: number
  course: number
  satellites: number
  hdop: number
  timestamp: number
}

export function createGps(mirror: PeriphMirror): Record<string, unknown> {
  let timer: number | null = null
  let lastFix: GpsFix | null = null

  function makeFix(): GpsFix {
    const g = mirror.snapshot.gps
    return {
      lat: g.lat,
      lng: g.lng,
      altitudeM: 42.0,
      speedMps: 0,
      course: 0,
      satellites: 9,
      hdop: 0.9,
      timestamp: Date.now()
    }
  }

  return {
    available(): boolean {
      return true
    },
    start(opts: {
      intervalMs?: number
      onFix: (fix: GpsFix) => void
      onStatus?: (s: 'searching' | 'fixed' | 'lost') => void
    }): void {
      if (!opts || typeof opts.onFix !== 'function') throw new Error('gps.start 需要 onFix 回调')
      if (timer !== null) clearInterval(timer)
      opts.onStatus?.('searching')
      // 模拟 500ms 搜星后定位
      setTimeout(() => opts.onStatus?.('fixed'), 500)
      timer = window.setInterval(() => {
        lastFix = makeFix()
        opts.onFix(lastFix)
      }, Math.max(200, opts.intervalMs ?? 1000))
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    last(): GpsFix | null {
      return lastFix
    }
  }
}

// ---------------------------------------------------------------
// px.led
// ---------------------------------------------------------------

export function createLed(link: HostLink, mirror: PeriphMirror): Record<string, unknown> {
  let colors: number[] = []
  let brightness = 100

  function assertAvailable(): void {
    if (!mirror.snapshot.led.available) throw new Error('ENOTSUP')
  }

  function ensureSize(): void {
    const n = mirror.snapshot.led.count
    if (colors.length !== n) colors = new Array<number>(n).fill(0)
  }

  return {
    available(): boolean {
      return mirror.snapshot.led.available
    },
    get count(): number {
      return mirror.snapshot.led.available ? mirror.snapshot.led.count : 0
    },
    setBrightness(percent: number): void {
      assertAvailable()
      brightness = clamp(percent, 0, 100)
    },
    set(index: number, color: number): void {
      assertAvailable()
      ensureSize()
      if (index >= 0 && index < colors.length) colors[index] = color & 0xffffff
    },
    fill(color: number): void {
      assertAvailable()
      ensureSize()
      colors.fill(color & 0xffffff)
    },
    clear(): void {
      assertAvailable()
      ensureSize()
      colors.fill(0)
    },
    show(): void {
      assertAvailable()
      ensureSize()
      link.emit('led-show', { colors: colors.slice(), brightness })
    }
  }
}

// ---------------------------------------------------------------
// px.ble(默认关闭,与真机 Kconfig 一致)
// ---------------------------------------------------------------

export function createBle(): Record<string, unknown> {
  const notSup = (): never => {
    throw new Error('ENOTSUP')
  }
  return {
    available(): boolean {
      return false
    },
    peripheral: {
      start: notSup,
      notify: notSup,
      stop: notSup,
      onConnect: notSup,
      onDisconnect: notSup
    },
    central: {
      scan: notSup,
      stopScan: notSup,
      connect: notSup
    }
  }
}

// ---------------------------------------------------------------
// px.camera(映射电脑摄像头)
// ---------------------------------------------------------------

const RESOLUTIONS: Record<string, { w: number; h: number }> = {
  QQVGA: { w: 160, h: 120 },
  QVGA: { w: 320, h: 240 },
  VGA: { w: 640, h: 480 },
  SVGA: { w: 800, h: 600 },
  XGA: { w: 1024, h: 768 },
  '720P': { w: 1280, h: 720 }
}

export function createCamera(link: HostLink): Record<string, unknown> {
  let streamCb: ((frame: ArrayBuffer) => void) | null = null
  link.on<CameraFramePayload>('camera-frame', (ev) => {
    streamCb?.(ev.frame)
  })

  return {
    available(): boolean {
      return true
    },
    async init(opts?: { resolution?: string; quality?: number; format?: string }): Promise<void> {
      const res = RESOLUTIONS[opts?.resolution ?? 'QVGA'] ?? RESOLUTIONS.QVGA
      await link.call('camera.init', {
        width: res.w,
        height: res.h,
        quality: opts?.quality ?? 12,
        format: opts?.format ?? 'jpeg'
      })
    },
    capture(): Promise<ArrayBuffer> {
      return link.call<ArrayBuffer>('camera.capture', {})
    },
    startStream(opts: { fps?: number; onFrame: (frame: ArrayBuffer) => void }): void {
      if (!opts || typeof opts.onFrame !== 'function') throw new Error('startStream 需要 onFrame 回调')
      streamCb = opts.onFrame
      void link.call('camera.stream.start', { fps: clamp(opts.fps ?? 5, 1, 30) }).catch(() => undefined)
    },
    stopStream(): void {
      streamCb = null
      void link.call('camera.stream.stop', {}).catch(() => undefined)
    },
    deinit(): void {
      streamCb = null
      void link.call('camera.deinit', {}).catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------
// px.system
// ---------------------------------------------------------------

export function createSystem(
  link: HostLink,
  mirror: PeriphMirror,
  deviceId: string,
  screenCtl: { setPower(on: boolean): void },
  logInfo: (msg: string) => void,
  device: SimDeviceInit
): Record<string, unknown> {
  const sysEvents = new NamedEmitter()
  let lastLevel = mirror.snapshot.battery.level
  let lastCharging = mirror.snapshot.battery.charging

  mirror.changed.on((s) => {
    const info = {
      level: s.battery.level,
      charging: s.battery.charging,
      voltageMv: 3600 + Math.round((s.battery.level / 100) * 600)
    }
    if (s.battery.charging !== lastCharging) {
      lastCharging = s.battery.charging
      sysEvents.emit('chargingChange', info)
    }
    if (s.battery.level < 15 && lastLevel >= 15) {
      sysEvents.emit('lowBattery', info)
    }
    lastLevel = s.battery.level
  })

  return {
    info(): Record<string, unknown> {
      return {
        model: 'pixelbox-sim',
        firmwareVersion: '0.1.0',
        // 芯片型号 = 设备档案(d.ts chip 为 string,可承载新芯片)
        chip: device.chip,
        deviceId,
        // 屏幕分辨率 = 设备档案(不再硬编码 368×448)
        screen: { width: device.screenW, height: device.screenH },
        // 能力开关来自 chipCapabilities 单一数据源;led 运行期由外设面板覆写
        capabilities: {
          ...device.capabilities,
          led: mirror.snapshot.led.available
        }
      }
    },
    memory(): Record<string, number> {
      // Chromium 专有 performance.memory,存在则映射 JS 堆
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      // psramFree 按档案容量模拟:无 PSRAM(psramMB=0,如 C6/C3)时恒为 0,
      // 与真机语义一致 —— 大分配(帧缓冲/解码缓冲)回落内部堆,heapFree 相应吃紧
      const psramTotal = device.psramMB * 1024 * 1024
      return {
        heapFree: 220 * 1024,
        psramFree: psramTotal > 0 ? Math.floor(psramTotal * 0.75) : 0,
        jsHeapUsed: mem?.usedJSHeapSize ?? 2 * 1024 * 1024
      }
    },
    battery(): Record<string, unknown> {
      const b = mirror.snapshot.battery
      return {
        level: b.level,
        charging: b.charging,
        voltageMv: 3600 + Math.round((b.level / 100) * 600)
      }
    },
    restart(): void {
      logInfo('system.restart: 模拟器重启应用')
      void link.call('sys.restart', {}).catch(() => undefined)
    },
    deepSleep(ms?: number): void {
      logInfo(`system.deepSleep(${ms ?? '∞'}): 模拟熄屏休眠`)
      screenCtl.setPower(false)
      if (typeof ms === 'number' && ms > 0) {
        setTimeout(() => {
          void link.call('sys.restart', {}).catch(() => undefined)
        }, ms)
      }
    },
    now(): number {
      return Date.now()
    },
    ntpSync(_server?: string): Promise<void> {
      // 宿主时钟本就准确
      return Promise.resolve()
    },
    setTimezone(tz: string): void {
      logInfo(`system.setTimezone("${tz}"): 模拟器沿用宿主时区,仅记录`)
    },
    temperature(): number {
      return 36 + Math.random() * 4
    },
    otaCheck(_manifestUrl: string): Promise<null> {
      // 模拟器无固件 OTA,视为无更新
      return Promise.resolve(null)
    },
    otaApply(_firmwareUrl: string): Promise<void> {
      return Promise.reject(new Error('ENOTSUP: 模拟器不支持固件 OTA'))
    },
    on(event: 'lowBattery' | 'chargingChange', cb: (info: unknown) => void): () => void {
      return sysEvents.on(event, cb)
    }
  }
}

// ---------------------------------------------------------------
// px.app
// ---------------------------------------------------------------

export function createApp(
  link: HostLink,
  manifest: { id: string; name: string; version: string },
  readAssetBytes: (path: string) => ArrayBuffer
): { app: Record<string, unknown>; runExitCallbacks: () => void } {
  const exitEmitter = new Emitter<void>()
  const DECODER = new TextDecoder()

  const app = {
    get name(): string {
      return manifest.name
    },
    get id(): string {
      return manifest.id
    },
    get version(): string {
      return manifest.version
    },
    readAsset(path: string): ArrayBuffer {
      return readAssetBytes(path)
    },
    readAssetText(path: string): string {
      return DECODER.decode(new Uint8Array(readAssetBytes(path)))
    },
    onExit(cb: () => void): () => void {
      return exitEmitter.on(cb)
    },
    exit(): void {
      void link.call('app.exit', {}).catch(() => undefined)
    }
  }

  return {
    app,
    runExitCallbacks: () => exitEmitter.emit()
  }
}
