/**
 * 网络域:全局 fetch / WebSocket 覆写 + px.net(tcp/udp/mdns)+ px.wifi(模拟)
 *
 * - fetch:RPC → 宿主 → main 进程 Node fetch(免 CORS,与真机 esp_http_client 行为对齐)
 * - WebSocket:沙箱内直连(包装原生类,契约事件形状 + binaryType 恒为 arraybuffer)
 * - tcp/udp:RPC → main 进程 net/dgram 桥;事件经 'net-event' 回流
 * - mdns:RPC → main 进程 bonjour-service
 * - wifi:模拟实现;status 反映宿主联网状态(navigator.onLine)
 */
import type { HostLink } from './rpc'
import { Emitter } from './events'
import { NamedEmitter } from './events'
import { toArrayBufferCopy } from './util'
import type { FetchRpcResult, NetEventPayload } from '../../protocol'

type BinaryLike = ArrayBuffer | Uint8Array

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// ---------------------------------------------------------------
// fetch(契约 PxRequestInit / PxResponse)
// ---------------------------------------------------------------

interface RequestInitLike {
  method?: string
  headers?: Record<string, string>
  body?: string | BinaryLike
  timeoutMs?: number
}

export function createFetch(link: HostLink): (url: string, init?: RequestInitLike) => Promise<unknown> {
  return async function pxFetch(url: string, init?: RequestInitLike): Promise<unknown> {
    if (typeof url !== 'string') throw new Error('fetch: url 必须是字符串')
    const params: Record<string, unknown> = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      timeoutMs: init?.timeoutMs ?? 15000
    }
    const transfer: Transferable[] = []
    if (typeof init?.body === 'string') {
      params.bodyText = init.body
    } else if (init?.body) {
      const buf = toArrayBufferCopy(init.body)
      params.body = buf
      transfer.push(buf)
    }
    const r = await link.call<FetchRpcResult>('fetch', params, transfer)
    const bodyBuf = r.body
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      statusText: r.statusText,
      headers: r.headers,
      url: r.url,
      text: () => Promise.resolve(DEC.decode(new Uint8Array(bodyBuf))),
      json: () => Promise.resolve(JSON.parse(DEC.decode(new Uint8Array(bodyBuf)))),
      arrayBuffer: () => Promise.resolve(bodyBuf.slice(0))
    }
  }
}

// ---------------------------------------------------------------
// WebSocket 包装(契约事件形状)
// ---------------------------------------------------------------

/** 构造契约形状的 WebSocket 类(内部使用原生实现直连) */
export function createWebSocketClass(nativeCtor: typeof WebSocket): unknown {
  class PxWebSocket {
    static readonly CONNECTING = 0 as const
    static readonly OPEN = 1 as const
    static readonly CLOSING = 2 as const
    static readonly CLOSED = 3 as const

    private inner: WebSocket
    binaryType: 'arraybuffer' = 'arraybuffer'
    onopen: ((ev: { type: 'open' }) => void) | null = null
    onmessage: ((ev: { type: 'message'; data: string | ArrayBuffer }) => void) | null = null
    onclose: ((ev: { type: 'close'; code: number; reason: string }) => void) | null = null
    onerror: ((ev: { type: 'error'; message: string }) => void) | null = null

    constructor(url: string, protocols?: string | string[]) {
      this.inner = new nativeCtor(url, protocols)
      this.inner.binaryType = 'arraybuffer'
      this.inner.onopen = () => this.onopen?.({ type: 'open' })
      this.inner.onmessage = (ev: MessageEvent) => {
        this.onmessage?.({ type: 'message', data: ev.data as string | ArrayBuffer })
      }
      this.inner.onclose = (ev: CloseEvent) =>
        this.onclose?.({ type: 'close', code: ev.code, reason: ev.reason })
      this.inner.onerror = () => this.onerror?.({ type: 'error', message: 'WebSocket 错误' })
    }

    get readyState(): 0 | 1 | 2 | 3 {
      return this.inner.readyState as 0 | 1 | 2 | 3
    }

    get url(): string {
      return this.inner.url
    }

    send(data: string | BinaryLike): void {
      if (typeof data === 'string') this.inner.send(data)
      else this.inner.send(toArrayBufferCopy(data))
    }

    close(code?: number, reason?: string): void {
      this.inner.close(code, reason)
    }
  }
  return PxWebSocket
}

// ---------------------------------------------------------------
// px.net(tcp / udp / mdns)
// ---------------------------------------------------------------

class TcpSocketImpl {
  private link: HostLink
  private id: number
  private connectedFlag = true
  readonly remoteHost: string
  readonly remotePort: number
  readonly dataEmitter = new Emitter<ArrayBuffer>()
  readonly closeEmitter = new Emitter<void>()
  readonly errorEmitter = new Emitter<string>()

  constructor(link: HostLink, id: number, remoteHost: string, remotePort: number) {
    this.link = link
    this.id = id
    this.remoteHost = remoteHost
    this.remotePort = remotePort
  }

  get sockId(): number {
    return this.id
  }

  get connected(): boolean {
    return this.connectedFlag
  }

  markClosed(): void {
    this.connectedFlag = false
    this.closeEmitter.emit()
  }

  send(data: string | BinaryLike): void {
    const buf = typeof data === 'string' ? toArrayBufferCopy(ENC.encode(data)) : toArrayBufferCopy(data)
    void this.link.call('tcp.send', { id: this.id, data: buf }, [buf]).catch((err) => {
      this.errorEmitter.emit(err instanceof Error ? err.message : String(err))
    })
  }

  close(): void {
    this.connectedFlag = false
    void this.link.call('tcp.close', { id: this.id }).catch(() => undefined)
  }

  onData(cb: (data: ArrayBuffer) => void): () => void {
    return this.dataEmitter.on(cb)
  }

  onClose(cb: () => void): () => void {
    return this.closeEmitter.on(cb)
  }

  onError(cb: (message: string) => void): () => void {
    return this.errorEmitter.on(cb)
  }
}

export function createNet(link: HostLink, logWarn: (msg: string) => void): Record<string, unknown> {
  const sockets = new Map<number, TcpSocketImpl>()
  /** serverId → onConnection */
  const servers = new Map<number, (sock: TcpSocketImpl) => void>()
  const udpEmitters = new Map<number, NamedEmitter>()

  link.on<NetEventPayload>('net-event', (ev) => {
    switch (ev.type) {
      case 'tcp-data':
        sockets.get(ev.id)?.dataEmitter.emit(ev.data)
        break
      case 'tcp-close': {
        const s = sockets.get(ev.id)
        if (s) {
          s.markClosed()
          sockets.delete(ev.id)
        }
        break
      }
      case 'tcp-error':
        sockets.get(ev.id)?.errorEmitter.emit(ev.message)
        break
      case 'tcp-conn': {
        const cb = servers.get(ev.serverId)
        if (cb) {
          const sock = new TcpSocketImpl(link, ev.sockId, ev.remoteHost, ev.remotePort)
          sockets.set(ev.sockId, sock)
          cb(sock)
        }
        break
      }
      case 'udp-msg':
        udpEmitters.get(ev.id)?.emit('message', { data: ev.data, host: ev.host, port: ev.port })
        break
    }
  })

  return {
    async connectTcp(opts: {
      host: string
      port: number
      tls?: boolean
      timeoutMs?: number
    }): Promise<TcpSocketImpl> {
      const r = await link.call<{ id: number; remoteHost: string; remotePort: number }>(
        'tcp.connect',
        opts
      )
      const sock = new TcpSocketImpl(link, r.id, r.remoteHost, r.remotePort)
      sockets.set(r.id, sock)
      return sock
    },

    listenTcp(opts: { port: number; onConnection: (sock: TcpSocketImpl) => void }): {
      port: number
      close: () => void
    } {
      if (!opts || typeof opts.onConnection !== 'function') {
        throw new Error('listenTcp 需要 onConnection 回调')
      }
      // 契约为同步返回:先返回句柄,监听建立失败经 console 告警
      let serverId: number | null = null
      let actualPort = opts.port
      let closed = false
      void link
        .call<{ id: number; port: number }>('tcp.listen', { port: opts.port })
        .then((r) => {
          serverId = r.id
          actualPort = r.port
          if (closed) {
            void link.call('tcp.serverClose', { id: r.id }).catch(() => undefined)
          } else {
            servers.set(r.id, opts.onConnection)
          }
        })
        .catch((err) => {
          logWarn(`listenTcp 失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      return {
        get port(): number {
          return actualPort
        },
        close(): void {
          closed = true
          if (serverId !== null) {
            servers.delete(serverId)
            void link.call('tcp.serverClose', { id: serverId }).catch(() => undefined)
          }
        }
      }
    },

    createUdp(opts?: { bindPort?: number }): Record<string, unknown> {
      // 契约为同步返回:内部异步建 socket,发送在就绪前排队
      const emitter = new NamedEmitter()
      let udpId: number | null = null
      let closed = false
      const sendQueue: Array<{ data: ArrayBuffer; host: string; port: number }> = []
      void link
        .call<{ id: number }>('udp.create', { bindPort: opts?.bindPort })
        .then((r) => {
          if (closed) {
            void link.call('udp.close', { id: r.id }).catch(() => undefined)
            return
          }
          udpId = r.id
          udpEmitters.set(r.id, emitter)
          for (const q of sendQueue) {
            void link.call('udp.send', { id: r.id, data: q.data, host: q.host, port: q.port }, [q.data]).catch(() => undefined)
          }
          sendQueue.length = 0
        })
        .catch(() => undefined)
      return {
        send(data: string | BinaryLike, host: string, port: number): void {
          const buf =
            typeof data === 'string' ? toArrayBufferCopy(ENC.encode(data)) : toArrayBufferCopy(data)
          if (udpId === null) {
            sendQueue.push({ data: buf, host, port })
          } else {
            void link.call('udp.send', { id: udpId, data: buf, host, port }, [buf]).catch(() => undefined)
          }
        },
        onMessage(cb: (msg: { data: ArrayBuffer; host: string; port: number }) => void): () => void {
          return emitter.on('message', (d) => cb(d as { data: ArrayBuffer; host: string; port: number }))
        },
        close(): void {
          closed = true
          if (udpId !== null) {
            udpEmitters.delete(udpId)
            void link.call('udp.close', { id: udpId }).catch(() => undefined)
            udpId = null
          }
        }
      }
    },

    mdns: {
      async discover(
        service: string,
        opts?: { timeoutMs?: number }
      ): Promise<Array<{ name: string; host: string; ip: string; port: number; txt: Record<string, string> }>> {
        return link.call('mdns.discover', { service, timeoutMs: opts?.timeoutMs ?? 3000 })
      },
      advertise(opts: {
        name: string
        service: string
        port: number
        txt?: Record<string, string>
      }): () => void {
        let adId: number | null = null
        let stopped = false
        void link
          .call<{ id: number }>('mdns.advertise', opts)
          .then((r) => {
            adId = r.id
            if (stopped) void link.call('mdns.stop', { id: r.id }).catch(() => undefined)
          })
          .catch(() => undefined)
        return () => {
          stopped = true
          if (adId !== null) void link.call('mdns.stop', { id: adId }).catch(() => undefined)
        }
      }
    },

    hostname(): string {
      return cachedHostname
    }
  }
}

/** 主机名镜像(init 时由宿主异步回填) */
let cachedHostname = 'pixelbox-sim'

export function primeHostname(link: HostLink): void {
  void link
    .call<string>('hostname', {})
    .then((name) => {
      if (typeof name === 'string' && name.length > 0) cachedHostname = name
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------
// px.wifi(模拟)
// ---------------------------------------------------------------

const FAKE_APS = [
  { ssid: 'PixelBox-Home', rssi: -42, secure: true, channel: 6 },
  { ssid: 'Coffee-Free-WiFi', rssi: -61, secure: false, channel: 1 },
  { ssid: 'Office-5G', rssi: -55, secure: true, channel: 44 },
  { ssid: 'TP-LINK_8F2C', rssi: -73, secure: true, channel: 11 },
  { ssid: 'Neighbor-2.4G', rssi: -84, secure: true, channel: 3 }
]

/**
 * @param hasWifi 芯片是否有片上 WiFi(chipCapabilities 单一数据源;
 *                false 时(如 ESP32-P4)connect/scan/startAP 报 ENOTSUP,
 *                status() 恒离线 —— 与真机无 hosted 模块时的行为一致,
 *                真机需配套 ESP32-C6 hosted 模块提供 WiFi)
 */
export function createWifi(logInfo: (msg: string) => void, hasWifi = true): Record<string, unknown> {
  if (!hasWifi) return createWifiUnsupported()
  const events = new NamedEmitter()
  let connectedSsid: string | null = navigator.onLine ? 'PixelBox-Home' : null
  const mac = 'AA:BB:CC:12:34:56'

  function status(): {
    connected: boolean
    ssid: string | null
    ip: string | null
    rssi: number
    mac: string
  } {
    const online = navigator.onLine && connectedSsid !== null
    return {
      connected: online,
      ssid: online ? connectedSsid : null,
      ip: online ? '192.168.1.66' : null,
      rssi: online ? -45 : 0,
      mac
    }
  }

  // 宿主联网状态变化 → wifi 事件
  window.addEventListener('online', () => {
    events.emit('connected', status())
    events.emit('gotIp', status())
  })
  window.addEventListener('offline', () => {
    events.emit('disconnected', status())
  })

  return {
    scan(): Promise<Array<{ ssid: string; rssi: number; secure: boolean; channel: number }>> {
      return new Promise((res) => {
        setTimeout(() => {
          // rssi 加一点抖动更真实
          res(FAKE_APS.map((ap) => ({ ...ap, rssi: ap.rssi + Math.round(Math.random() * 6 - 3) })))
        }, 600)
      })
    },

    connect(
      ssid: string,
      _password?: string,
      opts?: { timeoutMs?: number; save?: boolean }
    ): Promise<unknown> {
      void opts
      return new Promise((res) => {
        setTimeout(() => {
          connectedSsid = ssid
          const st = status()
          events.emit('connected', st)
          events.emit('gotIp', st)
          res(st)
        }, 800) // 模拟连接耗时
      })
    },

    disconnect(): void {
      connectedSsid = null
      events.emit('disconnected', status())
    },

    status,

    on(event: 'connected' | 'disconnected' | 'gotIp', cb: (st: unknown) => void): () => void {
      return events.on(event, cb)
    },

    startAP(ssid: string, _password?: string): void {
      logInfo(`wifi.startAP: 模拟开启 SoftAP "${ssid}"(模拟器无真实热点)`)
    },

    stopAP(): void {
      logInfo('wifi.stopAP: 模拟关闭 SoftAP')
    }
  }
}

/** 无片上 WiFi 芯片(ESP32-P4)的 wifi 命名空间:契约表面完整,行为 ENOTSUP */
function createWifiUnsupported(): Record<string, unknown> {
  const ENOTSUP_MSG = 'ENOTSUP: 当前芯片无片上 WiFi(ESP32-P4 需配套 ESP32-C6 hosted 模块)'
  const offline = (): {
    connected: boolean
    ssid: string | null
    ip: string | null
    rssi: number
    mac: string
  } => ({ connected: false, ssid: null, ip: null, rssi: 0, mac: '00:00:00:00:00:00' })
  return {
    scan(): Promise<never> {
      return Promise.reject(new Error(ENOTSUP_MSG))
    },
    connect(): Promise<never> {
      return Promise.reject(new Error(ENOTSUP_MSG))
    },
    disconnect(): void {
      // 本就未连接,空操作
    },
    status: offline,
    on(): () => void {
      return () => undefined // 永不触发,返回可调用的退订函数
    },
    startAP(): void {
      throw new Error(ENOTSUP_MSG)
    },
    stopAP(): void {
      // 空操作
    }
  }
}
