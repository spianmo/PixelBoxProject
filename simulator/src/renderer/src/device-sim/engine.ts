/**
 * SimEngine —— 设备模拟引擎核心(宿主侧)
 *
 * 职责:
 *   - 沙箱 iframe 生命周期(load = 热重载:先停旧再起新;stop = 触发 onExit 后拆除)
 *   - srcdoc 注入沙箱运行时(virtual:pixelbox-sandbox-runtime,esbuild 固化字符串)
 *   - postMessage RPC 分发:fetch / player / mic / camera / storage / tcp / udp / mdns …
 *   - rAF 帧节拍(按 setFps 节流)驱动沙箱 onFrame;接收帧缓冲绘制到可见画布
 *   - 外设面板状态(battery/imu/gps/led)推送;触摸/按键/摇一摇事件注入
 *   - console 与运行时错误(含堆栈)经 CustomEvent 代理到外壳底部面板
 */
import runtimeCode from 'virtual:pixelbox-sandbox-runtime'
import type {
  PixelboxSimApi,
  SimManifest,
  SimLogDetail,
  SimStateDetail,
  SimRunState,
  SimDeviceTag
} from './types'
import type { DeviceProfile } from '../../../shared/ipc-types'
import { chipCapability, defaultCapabilities } from '../../../shared/chipCapabilities'
import { createStore, type Store } from './store'
import {
  isSimMessage,
  type SimMessage,
  type RpcCallMsg,
  type PeriphSnapshot,
  type SandboxInitPayload,
  type SimDeviceInit,
  type FramePayload,
  type ConsolePayload,
  type UncaughtPayload,
  type ScreenCtlPayload,
  type LedShowPayload,
  type SetFpsPayload,
  type VoiceStatePayload,
  type NetEventPayload
} from './protocol'
import { AudioPlayerHost } from './host/audioPlayerHost'
import { MicHost } from './host/micHost'
import { CameraHost } from './host/cameraHost'
import { NetRelay } from './host/netRelay'

/** 面板可见的引擎状态 */
export interface EngineUiState {
  running: boolean
  appName: string | null
  brightness: number
  power: boolean
  rotation: 0 | 90 | 180 | 270
  ledColors: number[]
  ledBrightness: number
  voiceState: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'
  micActive: boolean
  cameraActive: boolean
  cameraStream: MediaStream | null
  /** 宿主侧静音(设备面板音量开关) */
  muted: boolean
}

/** 外设面板输入的默认值 */
const DEFAULT_PERIPH: PeriphSnapshot = {
  battery: { level: 88, charging: false },
  imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 },
  gps: { lat: 31.2304, lng: 121.4737 }, // 上海
  led: { available: false, count: 8 }
}

const LOAD_TIMEOUT_MS = 15000
const EXIT_GRACE_MS = 400

/** 引擎构造参数(阶段 2:每个「运行的设备」tab 一个引擎实例) */
export interface EngineOptions {
  /** 虚拟设备档案(决定屏幕分辨率 / 芯片 / PSRAM / 能力表) */
  profile: DeviceProfile
  /** 外壳设备路由 key('sim:<profileId>',日志/状态事件按此路由) */
  deviceKey: string
}

/** 档案 → 沙箱 init 的设备负载(能力来自 chipCapabilities 单一数据源) */
function deviceInitOf(profile: DeviceProfile): SimDeviceInit {
  const cap = chipCapability(profile.chip)
  return {
    chip: profile.chip,
    name: profile.name,
    screenW: profile.screenW,
    screenH: profile.screenH,
    // 芯片不支持 PSRAM 时强制 0(与档案校验双保险)
    psramMB: cap.psram ? profile.psramMB : 0,
    flashMB: profile.flashMB,
    capabilities: defaultCapabilities(profile.chip),
    wifi: cap.wifi
  }
}

/** 简单字符串散列(deviceId 派生) */
function hashStr(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export class SimEngine {
  /** 面板输入(电池/IMU/GPS/灯带开关)*/
  readonly periphStore: Store<PeriphSnapshot>
  /** 面板展示(运行态/屏幕控制/灯带内容/语音状态)*/
  readonly uiStore: Store<EngineUiState>
  /** 外壳工具栏使用的运行 API(激活 tab 的引擎经 facade 挂 window.__pixelboxSim) */
  readonly api: PixelboxSimApi
  /** 本实例绑定的虚拟设备档案(阶段 2 多实例) */
  readonly profile: DeviceProfile
  /** 外壳设备路由 key('sim:<profileId>') */
  readonly deviceKey: string
  /**
   * 可选帧回调:每帧绘制完成(putImageData 之后)调用。
   * 3D 视图用它做 CanvasTexture 脏标记(additive,不改动 device-sim/types.ts 契约)。
   */
  onFrame?: (() => void) | null

  private iframe: HTMLIFrameElement | null = null
  private screenCanvas: HTMLCanvasElement | null = null
  private latestFrame: ImageData | null = null

  private playerHost: AudioPlayerHost
  private micHost: MicHost
  private cameraHost: CameraHost
  private netRelay: NetRelay | null = null

  private wsName = 'default'
  private lastBundle: string | null = null
  private lastManifest: SimManifest | null = null

  private fps = 30
  private rafHandle: number | null = null
  private lastTickAt = 0

  private loadWaiter: { resolve: () => void; reject: (e: Error) => void; timer: number } | null = null
  private exitWaiter: (() => void) | null = null
  private stopping: Promise<void> | null = null
  /** window message 监听句柄(dispose 时移除,避免多实例泄漏) */
  private readonly onWindowMessage: (ev: MessageEvent) => void

  constructor(opts: EngineOptions) {
    this.profile = opts.profile
    this.deviceKey = opts.deviceKey
    this.periphStore = createStore<PeriphSnapshot>(DEFAULT_PERIPH)
    this.uiStore = createStore<EngineUiState>({
      running: false,
      appName: null,
      brightness: 80,
      power: true,
      rotation: 0,
      ledColors: [],
      ledBrightness: 100,
      voiceState: 'idle',
      micActive: false,
      cameraActive: false,
      cameraStream: null,
      muted: false
    })

    this.playerHost = new AudioPlayerHost(
      (id) => this.postEvent('player-ended', { id }),
      (playingCount) => this.postEvent('player-state', { playingCount })
    )
    this.micHost = new MicHost(
      (consumerId, pcm) => this.postEvent('mic-frame', { consumerId, pcm }, [pcm]),
      (consumerId, message) => this.postEvent('mic-error', { consumerId, message }),
      (active) => this.uiStore.set({ micActive: active })
    )
    this.cameraHost = new CameraHost((active, stream) =>
      this.uiStore.set({ cameraActive: active, cameraStream: stream })
    )

    // 外设面板变化 → 推送沙箱
    this.periphStore.subscribe(() => {
      this.postEvent('periph', this.periphStore.get())
    })

    // 全局消息路由(按 source 过滤;多实例并存时各自只处理自己 iframe 的消息)
    this.onWindowMessage = (ev: MessageEvent): void => {
      if (!this.iframe || ev.source !== this.iframe.contentWindow) return
      const msg: unknown = ev.data
      if (!isSimMessage(msg)) return
      this.route(msg)
    }
    window.addEventListener('message', this.onWindowMessage)

    const engine = this
    this.api = {
      load: (bundleCode: string, manifest: SimManifest) => engine.load(bundleCode, manifest),
      stop: () => {
        void engine.stopAsync(true)
      },
      get running(): boolean {
        return engine.uiStore.get().running
      }
    }
  }

  // ---------------------------------------------------------------
  // 对外:屏幕画布与输入注入(面板调用)
  // ---------------------------------------------------------------

  attachScreen(canvas: HTMLCanvasElement | null): void {
    this.screenCanvas = canvas
    if (canvas && this.latestFrame) {
      canvas.getContext('2d')?.putImageData(this.latestFrame, 0, 0)
    }
  }

  sendTouch(type: 'down' | 'move' | 'up', x: number, y: number): void {
    this.postEvent('touch', { type, x: Math.round(x), y: Math.round(y) })
  }

  sendButton(type: 'down' | 'up'): void {
    this.postEvent('button', { type })
  }

  sendShake(): void {
    this.postEvent('shake', {})
  }

  // ---------------------------------------------------------------
  // 外壳「运行的设备」面板工具条动作(重载 / 静音 / 旋转 / 截图)
  // ---------------------------------------------------------------

  /** 重载最近一次成功加载的应用(无历史包时为空操作) */
  async reload(): Promise<void> {
    if (this.lastBundle && this.lastManifest) {
      await this.load(this.lastBundle, this.lastManifest)
    }
  }

  /** 宿主侧静音开关(不改变应用设置的音量) */
  setMuted(muted: boolean): void {
    this.playerHost.setMuted(muted)
    this.uiStore.set({ muted })
  }

  /** 顺时针旋转屏幕显示 90°(仅显示旋转,与应用 setRotation 行为一致) */
  rotateScreen(): void {
    const order: Array<EngineUiState['rotation']> = [0, 90, 180, 270]
    const cur = this.uiStore.get().rotation
    this.uiStore.set({ rotation: order[(order.indexOf(cur) + 1) % order.length] })
  }

  /** 当前屏幕帧编码为 PNG 字节(无帧时返回 null,面板截图按钮用) */
  async captureScreenshotPng(): Promise<ArrayBuffer | null> {
    const frame = this.latestFrame
    if (!frame) return null
    const canvas = document.createElement('canvas')
    canvas.width = frame.width
    canvas.height = frame.height
    canvas.getContext('2d')?.putImageData(frame, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return blob ? blob.arrayBuffer() : null
  }

  // ---------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------

  private async load(bundleCode: string, manifest: SimManifest): Promise<void> {
    // 热重载:先优雅停止旧应用
    await this.stopAsync(false)

    const ctx = window.__pixelboxSimContext
    if (!ctx) {
      const msg = '缺少运行上下文(window.__pixelboxSimContext),请通过工具栏「运行」启动'
      this.log('error', msg)
      throw new Error(msg)
    }
    this.wsName = baseName(ctx.workspaceRoot)
    this.lastBundle = bundleCode
    this.lastManifest = manifest

    // 预载 /app(dist/ 全量)与 /data + kv
    const [appFiles, storage] = await Promise.all([
      window.api.sim.readTree(ctx.outDir),
      window.api.sim.storageLoad(this.wsName)
    ])

    // 网络中转就位
    this.netRelay = new NetRelay()
    this.netRelay.attach((ev: NetEventPayload, transfer) => this.postEvent('net-event', ev, transfer))

    // 起沙箱(device = 本实例档案派生的芯片能力/屏幕负载)
    await this.spawnSandbox({
      manifest: { id: manifest.id, name: manifest.name, version: manifest.version, entry: manifest.entry },
      bundleCode,
      appFiles,
      dataFiles: storage.files,
      kvJson: storage.kvJson,
      periph: this.periphStore.get(),
      deviceId: `sim-${hashStr(`${this.wsName}:${this.profile.id}`)}`,
      brightness: this.uiStore.get().brightness,
      device: deviceInitOf(this.profile)
    })

    this.uiStore.set({ running: true, appName: manifest.name, voiceState: 'idle' })
    this.dispatchState('running')
    this.startTicks()
  }

  private spawnSandbox(init: SandboxInitPayload): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const iframe = document.createElement('iframe')
      iframe.setAttribute('sandbox', 'allow-scripts')
      iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
      iframe.title = 'pixelbox-sandbox'
      // </script 逃逸,避免 bundle 文本提前闭合标签
      const safeRuntime = runtimeCode.replace(/<\/script/gi, '<\\/script')
      iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${safeRuntime}</script></body></html>`

      const timer = window.setTimeout(() => {
        this.loadWaiter = null
        this.teardownSandbox()
        reject(new Error('沙箱启动超时'))
      }, LOAD_TIMEOUT_MS)
      this.loadWaiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
        timer
      }
      this.pendingInit = init
      this.iframe = iframe
      document.body.appendChild(iframe)
    })
  }

  private pendingInit: SandboxInitPayload | null = null

  /** stop:通知沙箱执行 onExit,宽限后拆除 */
  private stopAsync(notifyShell: boolean): Promise<void> {
    if (this.stopping) return this.stopping
    if (!this.iframe) {
      if (notifyShell && this.uiStore.get().running) {
        this.uiStore.set({ running: false })
        this.dispatchState('stopped')
      }
      return Promise.resolve()
    }
    this.stopping = new Promise<void>((resolve) => {
      const finish = (): void => {
        this.exitWaiter = null
        this.teardownSandbox()
        this.uiStore.set({ running: false, appName: null, voiceState: 'idle', micActive: false })
        if (notifyShell) this.dispatchState('stopped')
        this.stopping = null
        resolve()
      }
      const grace = window.setTimeout(finish, EXIT_GRACE_MS)
      this.exitWaiter = () => {
        clearTimeout(grace)
        finish()
      }
      this.postEvent('stop', {})
    })
    return this.stopping
  }

  /** 拆除 iframe 与宿主资源 */
  private teardownSandbox(): void {
    this.stopTicks()
    this.iframe?.remove()
    this.iframe = null
    this.pendingInit = null
    this.playerHost.stopAll()
    this.micHost.dispose()
    this.cameraHost.dispose()
    this.netRelay?.dispose()
    this.netRelay = null
  }

  private crash(message: string): void {
    this.teardownSandbox()
    this.uiStore.set({ running: false, appName: null })
    this.dispatchState('crashed', message)
  }

  // ---------------------------------------------------------------
  // 帧节拍
  // ---------------------------------------------------------------

  private startTicks(): void {
    this.stopTicks()
    this.lastTickAt = 0
    const loop = (now: number): void => {
      this.rafHandle = requestAnimationFrame(loop)
      const interval = 1000 / this.fps
      if (now - this.lastTickAt >= interval - 1) {
        this.lastTickAt = now
        this.postEvent('tick', { now })
      }
    }
    this.rafHandle = requestAnimationFrame(loop)
  }

  private stopTicks(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
  }

  // ---------------------------------------------------------------
  // 消息路由
  // ---------------------------------------------------------------

  private postEvent(name: string, data: unknown, transfer?: Transferable[]): void {
    this.iframe?.contentWindow?.postMessage(
      { __px: true, kind: 'event', name, data },
      '*',
      transfer ?? []
    )
  }

  private replyRpc(id: number, ok: boolean, data: unknown, transfer?: Transferable[]): void {
    this.iframe?.contentWindow?.postMessage(
      { __px: true, kind: 'rpc-reply', id, ok, data },
      '*',
      transfer ?? []
    )
  }

  private route(msg: SimMessage): void {
    if (msg.kind === 'rpc-call') {
      void this.handleRpc(msg)
      return
    }
    if (msg.kind !== 'event') return
    switch (msg.name) {
      case 'hello':
        if (this.pendingInit) {
          const init = this.pendingInit
          this.pendingInit = null
          const transfer = [
            ...init.appFiles.map((f) => f.data),
            ...init.dataFiles.map((f) => f.data)
          ]
          this.postEvent('init', init, transfer)
        }
        break
      case 'app-started':
        this.loadWaiter?.resolve()
        this.loadWaiter = null
        break
      case 'app-error': {
        const d = msg.data as { message: string; stack?: string }
        this.log('error', d.stack ?? d.message)
        const waiter = this.loadWaiter
        this.loadWaiter = null
        this.crash(d.message)
        waiter?.reject(new Error(d.message))
        break
      }
      case 'console': {
        const d = msg.data as ConsolePayload
        this.log(d.level, d.text)
        break
      }
      case 'uncaught': {
        const d = msg.data as UncaughtPayload
        this.log('error', d.stack ? `${d.message}\n${d.stack}` : d.message)
        if (d.fatal) this.crash(d.message)
        break
      }
      case 'frame': {
        const d = msg.data as FramePayload
        this.paintFrame(d)
        break
      }
      case 'screen-ctl': {
        const d = msg.data as ScreenCtlPayload
        const patch: Partial<EngineUiState> = {}
        if (typeof d.brightness === 'number') patch.brightness = d.brightness
        if (typeof d.power === 'boolean') patch.power = d.power
        if (d.rotation !== undefined) patch.rotation = d.rotation
        this.uiStore.set(patch)
        break
      }
      case 'led-show': {
        const d = msg.data as LedShowPayload
        this.uiStore.set({ ledColors: d.colors, ledBrightness: d.brightness })
        break
      }
      case 'set-fps': {
        const d = msg.data as SetFpsPayload
        this.fps = Math.min(60, Math.max(1, d.fps))
        break
      }
      case 'voice-state': {
        const d = msg.data as VoiceStatePayload
        this.uiStore.set({ voiceState: d.state })
        break
      }
      case 'exit-done':
        this.exitWaiter?.()
        break
      default:
        break
    }
  }

  private paintFrame(d: FramePayload): void {
    const data = new Uint8ClampedArray(d.buf)
    if (data.length !== d.width * d.height * 4) return
    this.latestFrame = new ImageData(data, d.width, d.height)
    if (this.screenCanvas) {
      this.screenCanvas.getContext('2d')?.putImageData(this.latestFrame, 0, 0)
    }
    this.onFrame?.()
  }

  // ---------------------------------------------------------------
  // RPC 分发(特权操作)
  // ---------------------------------------------------------------

  private async handleRpc(msg: RpcCallMsg): Promise<void> {
    try {
      const { data, transfer } = await this.dispatchRpc(msg.method, msg.params as Record<string, unknown>)
      this.replyRpc(msg.id, true, data, transfer)
    } catch (err) {
      this.replyRpc(msg.id, false, err instanceof Error ? err.message : String(err))
    }
  }

  private async dispatchRpc(
    method: string,
    p: Record<string, unknown>
  ): Promise<{ data: unknown; transfer?: Transferable[] }> {
    switch (method) {
      // ---- fetch 代理 ----
      case 'fetch': {
        const r = await window.api.sim.fetch({
          url: p.url as string,
          method: p.method as string,
          headers: p.headers as Record<string, string>,
          body: p.body as ArrayBuffer | undefined,
          bodyText: p.bodyText as string | undefined,
          timeoutMs: p.timeoutMs as number
        })
        return { data: r, transfer: [r.body] }
      }

      // ---- 播放器 ----
      case 'player.play': {
        let bytes = p.bytes as ArrayBuffer | undefined
        if (!bytes && typeof p.url === 'string') {
          const resp = await window.api.sim.fetch({
            url: p.url,
            method: 'GET',
            headers: {},
            timeoutMs: 20000
          })
          if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`下载音频失败: HTTP ${resp.status}`)
          }
          bytes = resp.body
        }
        if (!bytes) throw new Error('player.play 缺少音频数据')
        return { data: await this.playerHost.playBytes(bytes) }
      }
      case 'player.playPcm':
        return {
          data: this.playerHost.playPcm(
            p.pcm as ArrayBuffer,
            (p.sampleRate as number) ?? 16000,
            (p.channels as number) ?? 1
          )
        }
      case 'player.stream.open':
        return {
          data: this.playerHost.streamOpen(
            (p.sampleRate as number) ?? 16000,
            (p.channels as number) ?? 1
          )
        }
      case 'player.stream.feed':
        return { data: this.playerHost.streamFeed(p.id as number, p.pcm as ArrayBuffer) }
      case 'player.stream.end':
        this.playerHost.streamEnd(p.id as number)
        return { data: null }
      case 'player.ctl':
        this.playerHost.ctl(p.id as number, p.op as 'stop' | 'pause' | 'resume')
        return { data: null }
      case 'player.tone':
        this.playerHost.tone(p.freq as number, p.ms as number, (p.volume as number) ?? 80)
        return { data: null }
      case 'player.stopAll':
        this.playerHost.stopAll()
        return { data: null }
      case 'player.setVolume':
        this.playerHost.setVolume(p.volume as number)
        return { data: null }

      // ---- 麦克风 ----
      case 'mic.start':
        await this.micHost.start(
          p.consumerId as number,
          (p.sampleRate as number) ?? 16000,
          (p.frameMs as number) ?? 32
        )
        return { data: null }
      case 'mic.stop':
        this.micHost.stop(p.consumerId as number)
        return { data: null }

      // ---- 摄像头 ----
      case 'camera.init':
        await this.cameraHost.init({
          width: (p.width as number) ?? 320,
          height: (p.height as number) ?? 240,
          quality: (p.quality as number) ?? 12
        })
        return { data: null }
      case 'camera.capture': {
        const frame = await this.cameraHost.capture()
        return { data: frame, transfer: [frame] }
      }
      case 'camera.stream.start':
        this.cameraHost.startStream((p.fps as number) ?? 5, (frame) =>
          this.postEvent('camera-frame', { frame }, [frame])
        )
        return { data: null }
      case 'camera.stream.stop':
        this.cameraHost.stopStream()
        return { data: null }
      case 'camera.deinit':
        this.cameraHost.deinit()
        return { data: null }

      // ---- storage 写穿 ----
      case 'storage.write':
        await window.api.sim.storageWrite(this.wsName, p.path as string, p.data as ArrayBuffer)
        return { data: null }
      case 'storage.remove':
        await window.api.sim.storageRemove(this.wsName, p.path as string)
        return { data: null }
      case 'storage.mkdir':
        await window.api.sim.storageMkdir(this.wsName, p.path as string)
        return { data: null }
      case 'storage.kv':
        await window.api.sim.storageSaveKv(this.wsName, p.kvJson as string)
        return { data: null }

      // ---- tcp / udp / mdns ----
      case 'tcp.connect': {
        if (!this.netRelay) throw new Error('网络桥未就绪')
        return {
          data: await this.netRelay.tcpConnect(
            p as { host: string; port: number; tls?: boolean; timeoutMs?: number }
          )
        }
      }
      case 'tcp.send':
        await this.netRelay?.tcpSend(p.id as number, p.data as ArrayBuffer)
        return { data: null }
      case 'tcp.close':
        await this.netRelay?.tcpClose(p.id as number)
        return { data: null }
      case 'tcp.listen': {
        if (!this.netRelay) throw new Error('网络桥未就绪')
        return { data: await this.netRelay.tcpListen(p.port as number) }
      }
      case 'tcp.serverClose':
        await this.netRelay?.tcpServerClose(p.id as number)
        return { data: null }
      case 'udp.create': {
        if (!this.netRelay) throw new Error('网络桥未就绪')
        return { data: await this.netRelay.udpCreate(p.bindPort as number | undefined) }
      }
      case 'udp.send':
        await this.netRelay?.udpSend(
          p.id as number,
          p.data as ArrayBuffer,
          p.host as string,
          p.port as number
        )
        return { data: null }
      case 'udp.close':
        await this.netRelay?.udpClose(p.id as number)
        return { data: null }
      case 'mdns.discover': {
        if (!this.netRelay) throw new Error('网络桥未就绪')
        return {
          data: await this.netRelay.mdnsDiscover(p.service as string, (p.timeoutMs as number) ?? 3000)
        }
      }
      case 'mdns.advertise': {
        if (!this.netRelay) throw new Error('网络桥未就绪')
        return {
          data: await this.netRelay.mdnsAdvertise(
            p as { name: string; service: string; port: number; txt?: Record<string, string> }
          )
        }
      }
      case 'mdns.stop':
        await this.netRelay?.mdnsStop(p.id as number)
        return { data: null }

      // ---- 杂项 ----
      case 'hostname':
        return { data: await window.api.sim.hostname() }
      case 'sys.restart': {
        const bundle = this.lastBundle
        const manifest = this.lastManifest
        setTimeout(() => {
          if (bundle && manifest) void this.load(bundle, manifest).catch(() => undefined)
        }, 50)
        return { data: null }
      }
      case 'app.exit':
        setTimeout(() => void this.stopAsync(true), 0)
        return { data: null }

      default:
        throw new Error(`未知 RPC 方法: ${method}`)
    }
  }

  // ---------------------------------------------------------------
  // 外壳事件
  // ---------------------------------------------------------------

  private log(level: SimLogDetail['level'], text: string): void {
    // detail 追加 deviceKey/deviceName(SimDeviceTag 可选字段):
    // 外壳底部日志按设备下拉路由;旧监听方忽略额外字段,契约兼容
    const detail: SimLogDetail & SimDeviceTag = {
      level,
      text,
      ts: Date.now(),
      deviceKey: this.deviceKey,
      deviceName: this.profile.name
    }
    window.dispatchEvent(new CustomEvent<SimLogDetail>('pixelbox-sim:log', { detail }))
  }

  private dispatchState(state: SimRunState, error?: string): void {
    const detail: SimStateDetail & SimDeviceTag = {
      state,
      error,
      deviceKey: this.deviceKey,
      deviceName: this.profile.name
    }
    window.dispatchEvent(new CustomEvent<SimStateDetail>('pixelbox-sim:state', { detail }))
  }

  // ---------------------------------------------------------------
  // 实例销毁(关闭「运行的设备」tab 时调用)
  // ---------------------------------------------------------------

  /** 停止应用并释放本实例的全局监听(多实例场景防泄漏);实例销毁后不可复用 */
  async dispose(): Promise<void> {
    await this.stopAsync(true)
    window.removeEventListener('message', this.onWindowMessage)
  }
}
