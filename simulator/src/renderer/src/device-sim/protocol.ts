/**
 * device-sim 内部协议:宿主(renderer host)⇄ 沙箱 iframe 之间的 postMessage 消息定义
 *
 * 该文件被两端共同引用:
 *   - 宿主侧经 Vite 正常打包(engine.ts / host/*)
 *   - 沙箱侧经 esbuild 打进 runtime bundle(sandbox/runtime/*)
 *
 * 约定:
 *   - 所有消息带 __px: true 标记,避免与其他 postMessage 串扰
 *   - 需要应答的走 rpc(kind: 'rpc-call' / 'rpc-reply'),单向通知走 event(kind: 'event')
 *   - 二进制统一 ArrayBuffer,并通过 transfer 列表零拷贝传递
 */

// ---------------------------------------------------------------
// 信封
// ---------------------------------------------------------------

/** RPC 请求(沙箱 → 宿主) */
export interface RpcCallMsg {
  __px: true
  kind: 'rpc-call'
  id: number
  method: string
  params: unknown
}

/** RPC 应答(宿主 → 沙箱) */
export interface RpcReplyMsg {
  __px: true
  kind: 'rpc-reply'
  id: number
  ok: boolean
  /** ok=true 时为结果,否则为错误消息字符串 */
  data: unknown
}

/** 单向事件(双向均可发) */
export interface EventMsg {
  __px: true
  kind: 'event'
  name: string
  data: unknown
}

export type SimMessage = RpcCallMsg | RpcReplyMsg | EventMsg

export function isSimMessage(v: unknown): v is SimMessage {
  return typeof v === 'object' && v !== null && (v as { __px?: unknown }).__px === true
}

// ---------------------------------------------------------------
// 初始化负载(宿主 → 沙箱,事件名 'init')
// ---------------------------------------------------------------

/** 一个预加载文件(路径为 / 分隔的相对路径) */
export interface SimFileEntry {
  path: string
  data: ArrayBuffer
}

/** 外设面板 → 沙箱的状态快照(变化时也用事件 'periph' 推送) */
export interface PeriphSnapshot {
  battery: { level: number; charging: boolean }
  imu: { ax: number; ay: number; az: number; gx: number; gy: number; gz: number }
  gps: { lat: number; lng: number }
  led: { available: boolean; count: number }
}

export interface SandboxInitPayload {
  manifest: { id: string; name: string; version: string; entry: string }
  /** esbuild 产物 dist/main.js 全文 */
  bundleCode: string
  /** /app 只读包内容(dist/ 全部文件,含 main.js 与 assets/**) */
  appFiles: SimFileEntry[]
  /** /data 可写目录当前内容(userData 落盘的镜像) */
  dataFiles: SimFileEntry[]
  /** kv 存储 JSON 文本(对象字符串) */
  kvJson: string
  /** 外设初始状态 */
  periph: PeriphSnapshot
  /** 设备 ID(按工作区名派生,稳定) */
  deviceId: string
  /** 屏幕初始亮度 0-100 */
  brightness: number
}

// ---------------------------------------------------------------
// 宿主 → 沙箱事件
// ---------------------------------------------------------------

/** 'tick' —— 宿主 rAF 驱动的帧节拍(已按 setFps 节流) */
export interface TickEvent {
  now: number
}

/** 'touch' —— 屏幕触摸(鼠标映射,坐标已换算为屏幕像素) */
export interface TouchEventPayload {
  type: 'down' | 'move' | 'up'
  x: number
  y: number
}

/** 'button' —— BOOT 键原始按下/抬起(click/longPress 由沙箱合成) */
export interface ButtonEventPayload {
  type: 'down' | 'up'
}

/** 'mic-frame' —— 一帧 PCM16LE 麦克风数据 */
export interface MicFramePayload {
  consumerId: number
  pcm: ArrayBuffer
}

/** 'mic-error' —— 麦克风启动/运行错误 */
export interface MicErrorPayload {
  consumerId: number
  message: string
}

/** 'player-ended' —— 某播放句柄自然播完 */
export interface PlayerEndedPayload {
  id: number
}

/** 'player-state' —— 播放器整体状态镜像 */
export interface PlayerStatePayload {
  playingCount: number
}

/** 'camera-frame' —— 摄像头流帧(jpeg) */
export interface CameraFramePayload {
  frame: ArrayBuffer
}

/** 'net-event' —— tcp/udp 桥接事件 */
export type NetEventPayload =
  | { type: 'tcp-data'; id: number; data: ArrayBuffer }
  | { type: 'tcp-close'; id: number }
  | { type: 'tcp-error'; id: number; message: string }
  | { type: 'tcp-conn'; serverId: number; sockId: number; remoteHost: string; remotePort: number }
  | { type: 'udp-msg'; id: number; data: ArrayBuffer; host: string; port: number }

// ---------------------------------------------------------------
// 沙箱 → 宿主事件
// ---------------------------------------------------------------

/** 'console' —— 应用 console.* 输出 */
export interface ConsolePayload {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
}

/** 'uncaught' —— 未捕获异常 / 未处理 Promise 拒绝(含堆栈) */
export interface UncaughtPayload {
  message: string
  stack?: string
  /** 是否发生在应用模块求值阶段(true 视为 crashed) */
  fatal: boolean
}

/** 'frame' —— 一帧 368x448 RGBA 帧缓冲提交 */
export interface FramePayload {
  buf: ArrayBuffer
  width: number
  height: number
}

/** 'screen-ctl' —— 亮度/电源/旋转控制 */
export interface ScreenCtlPayload {
  brightness?: number
  power?: boolean
  rotation?: 0 | 90 | 180 | 270
}

/** 'led-show' —— 灯带内容提交(面板可视化) */
export interface LedShowPayload {
  colors: number[]
  brightness: number
}

/** 'set-fps' —— 沙箱调整帧节拍目标帧率 */
export interface SetFpsPayload {
  fps: number
}

/** 'voice-state' —— 语音状态机(供面板指示) */
export interface VoiceStatePayload {
  state: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'
}

// ---------------------------------------------------------------
// RPC 方法参数 / 返回值(沙箱 → 宿主)
// ---------------------------------------------------------------

export interface FetchRpcParams {
  url: string
  method: string
  headers: Record<string, string>
  /** 二进制请求体(可选,与 bodyText 互斥) */
  body?: ArrayBuffer
  bodyText?: string
  timeoutMs: number
}
export interface FetchRpcResult {
  status: number
  statusText: string
  headers: Record<string, string>
  url: string
  body: ArrayBuffer
}

export interface PlayerOpenResult {
  id: number
}

export interface TcpConnectResult {
  id: number
  remoteHost: string
  remotePort: number
}

export interface MdnsServiceResult {
  name: string
  host: string
  ip: string
  port: number
  txt: Record<string, string>
}

/** 供自检脚本与两端引用的 RPC 方法名清单(仅文档用途,不强制) */
export const RPC_METHODS = [
  'fetch',
  'player.play',
  'player.playPcm',
  'player.stream.open',
  'player.stream.feed',
  'player.stream.end',
  'player.ctl',
  'player.tone',
  'player.stopAll',
  'player.setVolume',
  'mic.start',
  'mic.stop',
  'camera.init',
  'camera.capture',
  'camera.stream.start',
  'camera.stream.stop',
  'camera.deinit',
  'storage.write',
  'storage.remove',
  'storage.mkdir',
  'storage.kv',
  'tcp.connect',
  'tcp.send',
  'tcp.close',
  'tcp.listen',
  'tcp.serverClose',
  'udp.create',
  'udp.send',
  'udp.close',
  'mdns.discover',
  'mdns.advertise',
  'mdns.stop',
  'hostname',
  'sys.restart',
  'app.exit'
] as const

export type RpcMethod = (typeof RPC_METHODS)[number]
