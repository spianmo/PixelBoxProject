/**
 * 沙箱运行时入口(经 esbuild 打成 IIFE,注入 iframe srcdoc)
 *
 * 启动序列:
 *   1. 建立 HostLink,向宿主发 'hello'
 *   2. 等待宿主 'init'(manifest + bundleCode + /app 与 /data 预载 + 外设快照)
 *   3. 加载像素字体 → 组装 px 全命名空间 + 覆写标准全局
 *   4. verifySurface() 红线自检(16 命名空间 + 标准全局,缺一不启动)
 *   5. Blob 动态 import 执行用户 bundle(失败回退 eval),上报 app-started / app-error
 *
 * 错误处理:
 *   - console.* 全量代理到宿主('console' 事件)
 *   - window.onerror / unhandledrejection(含堆栈)经 'uncaught' 事件上报
 */
import { HostLink } from './rpc'
import { installFonts } from './fonts'
import { Vfs, KvStore, normalizePath } from './storage'
import { ScreenImpl, createImageResolver } from './screen'
import { createAudio } from './audio'
import { VoiceImpl } from './voice'
import { createFetch, createWebSocketClass, createNet, createWifi, primeHostname } from './net'
import {
  PeriphMirror,
  createInput,
  createSensors,
  createGps,
  createLed,
  createBle,
  createCamera,
  createSystem,
  createApp
} from './periph'
import {
  b64encode,
  b64decode,
  hexEncode,
  hexDecode,
  crc32,
  sha256,
  randomBytes,
  uuid,
  rgb,
  hsv,
  lerpColor
} from './util'
import { verifySurface } from './surface'
import type { SandboxInitPayload } from '../../protocol'

// 原生引用(覆写前保留)
const NativeWebSocket = window.WebSocket
const nativeConsole = window.console

const link = new HostLink()

// ---------------------------------------------------------------
// console 代理 + 全局错误上报
// ---------------------------------------------------------------

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
  if (a === undefined) return 'undefined'
  if (a === null) return 'null'
  if (typeof a === 'function') return `[function ${a.name || 'anonymous'}]`
  try {
    return JSON.stringify(a, (_k, v: unknown) => {
      if (v instanceof ArrayBuffer) return `[ArrayBuffer ${v.byteLength}B]`
      if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.byteLength}B]`
      return v
    })
  } catch {
    return String(a)
  }
}

function emitConsole(level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void {
  const text = args.map(formatArg).join(' ')
  link.emit('console', { level, text })
  // 同时保留在 devtools 里可见
  nativeConsole[level]?.(...args)
}

const consoleShim = {
  log: (...a: unknown[]) => emitConsole('log', a),
  info: (...a: unknown[]) => emitConsole('info', a),
  warn: (...a: unknown[]) => emitConsole('warn', a),
  error: (...a: unknown[]) => emitConsole('error', a),
  debug: (...a: unknown[]) => emitConsole('debug', a)
}

const logInfo = (msg: string): void => emitConsole('info', [msg])
const logWarn = (msg: string): void => emitConsole('warn', [msg])
const logError = (msg: string): void => emitConsole('error', [msg])

/** 模块求值阶段标记:此阶段的未捕获错误视为致命(crashed) */
let evaluatingBundle = false

window.addEventListener('error', (ev: ErrorEvent) => {
  const stack = ev.error instanceof Error ? ev.error.stack : undefined
  link.emit('uncaught', {
    message: ev.message || String(ev.error ?? '未知错误'),
    stack,
    fatal: evaluatingBundle
  })
})

window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  const reason: unknown = ev.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  link.emit('uncaught', { message: `未处理的 Promise 拒绝: ${message}`, stack, fatal: false })
})

// ---------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------

async function boot(init: SandboxInitPayload): Promise<void> {
  // 0) 设备档案(芯片/屏幕/PSRAM/能力,阶段 2 设备管理器注入;单一数据源 chipCapabilities)
  const device = init.device

  // 1) 字体(drawText 依赖)
  await installFonts(logWarn)

  // 2) 存储:/app 只读 + /data 写穿 + kv
  const vfs = new Vfs(link, logError)
  vfs.seed(init.appFiles, init.dataFiles)
  const kv = new KvStore(link, logError)
  kv.seed(init.kvJson)

  // 3) 外设镜像与屏幕(分辨率 = 档案 screenW×screenH,不再硬编码)
  const mirror = new PeriphMirror(link, init.periph)
  const resolver = createImageResolver(vfs)
  const screen = new ScreenImpl(link, resolver, init.brightness, {
    width: device.screenW,
    height: device.screenH
  })
  link.on('tick', () => screen.handleTick())

  // 4) 音频 / 语音
  const { audio, mic } = createAudio(link, vfs, logWarn)
  const voice = new VoiceImpl(link, mic, init.deviceId, logWarn, NativeWebSocket)

  // 5) 应用资产读取(readAsset 相对 assets/)
  const readAssetBytes = (path: string): ArrayBuffer => {
    const rel = path.startsWith('assets/') ? path : 'assets/' + path
    return vfs.readBytes(normalizePath('/app/' + rel))
  }
  const { app, runExitCallbacks } = createApp(link, init.manifest, readAssetBytes)

  // 6) px 根对象组装(system/wifi 按芯片能力表定制)
  const px: Record<string, unknown> = {
    system: createSystem(link, mirror, init.deviceId, screen, logInfo, device),
    app,
    storage: {
      kv: {
        get: (k: string) => kv.get(k),
        getJSON: (k: string) => kv.getJSON(k),
        set: (k: string, v: string | number | boolean | object) => kv.set(k, v),
        remove: (k: string) => kv.remove(k),
        keys: () => kv.keys(),
        clear: () => kv.clear()
      },
      fs: {
        readText: (p: string) => vfs.readText(p),
        readBytes: (p: string) => vfs.readBytes(p),
        writeText: (p: string, d: string) => vfs.writeText(p, d),
        writeBytes: (p: string, d: ArrayBuffer | Uint8Array) => vfs.writeBytes(p, d),
        append: (p: string, d: string | ArrayBuffer | Uint8Array) => vfs.append(p, d),
        exists: (p: string) => vfs.exists(p),
        remove: (p: string) => vfs.remove(p),
        mkdir: (p: string) => vfs.mkdir(p),
        readDir: (p: string) => vfs.readDir(p),
        stat: (p: string) => vfs.stat(p)
      }
    },
    screen,
    input: createInput(mirror),
    audio,
    voice,
    wifi: createWifi(logInfo, device.wifi),
    net: createNet(link, logWarn),
    ble: createBle(),
    camera: createCamera(link),
    gps: createGps(mirror),
    sensors: createSensors(mirror),
    led: createLed(link, mirror),
    util: {
      b64encode,
      b64decode,
      hexEncode,
      hexDecode,
      crc32,
      sha256,
      randomBytes,
      uuid
    },
    color: {
      rgb,
      hsv,
      lerp: lerpColor,
      BLACK: 0x000000,
      WHITE: 0xffffff,
      RED: 0xff0000,
      GREEN: 0x00ff00,
      BLUE: 0x0000ff,
      YELLOW: 0xffff00,
      CYAN: 0x00ffff,
      MAGENTA: 0xff00ff,
      ORANGE: 0xff8800,
      GRAY: 0x808080
    }
  }

  // 7) 全局注入:px / pixelbox + 标准全局覆写
  const g = globalThis as unknown as Record<string, unknown>
  Object.defineProperty(g, 'px', { value: px, writable: false, configurable: false })
  Object.defineProperty(g, 'pixelbox', { value: px, writable: false, configurable: false })
  g.console = consoleShim
  g.fetch = createFetch(link)
  g.WebSocket = createWebSocketClass(NativeWebSocket)
  primeHostname(link)
  // setTimeout/clearTimeout/setInterval/clearInterval/queueMicrotask/TextEncoder/
  // TextDecoder/atob/btoa/performance 使用 iframe 原生实现(与契约一致)

  // 8) 红线自检:16 个命名空间 + 标准全局缺一不可
  verifySurface(px)

  // 9) 宿主 'stop' → 执行 onExit 收尾并应答
  link.on('stop', () => {
    try {
      runExitCallbacks()
    } finally {
      link.emit('exit-done')
    }
  })

  // 10) 执行用户 bundle
  await runBundle(init.bundleCode)
}

/** Blob 动态 import 执行(支持 ESM);失败回退 (0,eval) */
async function runBundle(code: string): Promise<void> {
  evaluatingBundle = true
  try {
    const blob = new Blob([code], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await import(/* @vite-ignore */ url)
      return
    } catch (err) {
      // Blob import 在部分环境(CSP / opaque origin)不可用时回退 eval
      if (err instanceof Error && /Failed to fetch|import|CSP|blob/i.test(err.message)) {
        ;(0, eval)(code)
        return
      }
      throw err
    } finally {
      URL.revokeObjectURL(url)
    }
  } finally {
    evaluatingBundle = false
  }
}

// ---------------------------------------------------------------
// 启动握手
// ---------------------------------------------------------------

let booted = false
link.on<SandboxInitPayload>('init', (init) => {
  if (booted) return
  booted = true
  boot(init)
    .then(() => {
      link.emit('app-started')
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      link.emit('app-error', { message, stack })
    })
})

link.emit('hello')
