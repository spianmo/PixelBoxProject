/**
 * device-sim 特权桥(main 进程)
 *
 * 为沙箱内的 px shim 提供浏览器无法直接完成的能力:
 *   - sim:fetch           HTTP(S) 代理(Node 全局 fetch,免 CORS)
 *   - sim:read-tree       递归读取工作区 dist/ 二进制文件(/app 只读包预载)
 *   - sim:storage-*       kv + fs 落盘 userData/pixelbox-sim/<workspace名>/
 *   - sim:tcp-* sim:udp-* net/dgram 桥(事件经 sim:net-event 推回 renderer)
 *   - sim:mdns-*          bonjour-service 发现/广播桥
 *   - sim:hostname        本机主机名
 *
 * 本文件属 device-sim 领域,不改动 workspace/builder/devd 的既有导出。
 */
import { ipcMain, app, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { createConnection, createServer, type Socket, type Server } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createSocket, type Socket as DgramSocket } from 'node:dgram'
import { hostname } from 'node:os'
import { join, resolve, relative, sep, dirname } from 'node:path'
import { Bonjour, type Browser } from 'bonjour-service'
import { getWatchedRoot } from './workspace'

// ---------------------------------------------------------------
// 通用
// ---------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function netEvent(payload: unknown): void {
  broadcast('sim:net-event', payload)
}

/** 读树上限,防止误选巨型目录拖垮内存 */
const READ_TREE_LIMIT_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------
// fetch 代理
// ---------------------------------------------------------------

interface SimFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** 二进制请求体(与 bodyText 互斥) */
  body?: ArrayBuffer
  bodyText?: string
  timeoutMs: number
}

interface SimFetchResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  url: string
  body: ArrayBuffer
}

async function doFetch(req: SimFetchRequest): Promise<SimFetchResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, req.timeoutMs))
  try {
    let body: Buffer | string | undefined
    if (req.body instanceof ArrayBuffer) body = Buffer.from(req.body)
    else if (typeof req.bodyText === 'string') body = req.bodyText
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body,
      signal: ctrl.signal,
      redirect: 'follow'
    })
    const headers: Record<string, string> = {}
    resp.headers.forEach((v, k) => {
      headers[k] = v
    })
    const buf = await resp.arrayBuffer()
    return { status: resp.status, statusText: resp.statusText, headers, url: resp.url, body: buf }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------
// 工作区 dist/ 二进制读取(/app 预载)
// ---------------------------------------------------------------

/** 路径必须位于当前工作区内(watchedRoot 由 workspace.ts 维护) */
function assertInWorkspace(p: string): string {
  const abs = resolve(p)
  const root = getWatchedRoot()
  if (root) {
    const r = resolve(root)
    if (abs !== r && !abs.startsWith(r + sep)) {
      throw new Error(`sim 桥路径越界: ${p}`)
    }
  }
  return abs
}

async function readTree(dir: string): Promise<Array<{ path: string; data: ArrayBuffer }>> {
  const base = assertInWorkspace(dir)
  if (!existsSync(base)) return []
  const out: Array<{ path: string; data: ArrayBuffer }> = []
  let total = 0
  async function walk(d: string): Promise<void> {
    const items = await fsp.readdir(d, { withFileTypes: true })
    for (const it of items) {
      const p = join(d, it.name)
      if (it.isDirectory()) await walk(p)
      else if (it.isFile()) {
        const buf = await fsp.readFile(p)
        total += buf.length
        if (total > READ_TREE_LIMIT_BYTES) throw new Error('dist/ 目录过大(>64MB),中止预载')
        out.push({
          path: relative(base, p).split(sep).join('/'),
          data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        })
      }
    }
  }
  await walk(base)
  return out
}

// ---------------------------------------------------------------
// storage:kv + fs 落 userData/pixelbox-sim/<workspace名>/
// ---------------------------------------------------------------

/** 工作区名清洗为安全目录名 */
function safeWsName(ws: string): string {
  const cleaned = ws.replace(/[^\w一-鿿.-]+/g, '_').slice(0, 64)
  return cleaned.length > 0 ? cleaned : 'default'
}

function storageRoot(ws: string): string {
  return join(app.getPath('userData'), 'pixelbox-sim', safeWsName(ws))
}

/** data 内相对路径防护(禁止 .. 越界) */
function dataPath(ws: string, rel: string): string {
  const base = join(storageRoot(ws), 'data')
  const abs = resolve(base, rel.replace(/^\/+/, ''))
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`storage 路径越界: ${rel}`)
  }
  return abs
}

async function storageLoad(
  ws: string
): Promise<{ kvJson: string; files: Array<{ path: string; data: ArrayBuffer }> }> {
  const root = storageRoot(ws)
  const dataDir = join(root, 'data')
  await fsp.mkdir(dataDir, { recursive: true })
  let kvJson = '{}'
  const kvFile = join(root, 'kv.json')
  if (existsSync(kvFile)) {
    try {
      kvJson = await fsp.readFile(kvFile, 'utf8')
      JSON.parse(kvJson) // 校验
    } catch {
      kvJson = '{}'
    }
  }
  const files: Array<{ path: string; data: ArrayBuffer }> = []
  async function walk(d: string): Promise<void> {
    const items = await fsp.readdir(d, { withFileTypes: true })
    for (const it of items) {
      const p = join(d, it.name)
      if (it.isDirectory()) await walk(p)
      else if (it.isFile()) {
        const buf = await fsp.readFile(p)
        files.push({
          path: relative(dataDir, p).split(sep).join('/'),
          data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        })
      }
    }
  }
  await walk(dataDir)
  return { kvJson, files }
}

// ---------------------------------------------------------------
// tcp / udp 桥
// ---------------------------------------------------------------

let nextNetId = 1
const tcpSockets = new Map<number, Socket>()
const tcpServers = new Map<number, Server>()
const udpSockets = new Map<number, DgramSocket>()

function wireTcpSocket(id: number, sock: Socket): void {
  tcpSockets.set(id, sock)
  sock.on('data', (chunk) => {
    netEvent({
      type: 'tcp-data',
      id,
      data: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
    })
  })
  sock.on('close', () => {
    tcpSockets.delete(id)
    netEvent({ type: 'tcp-close', id })
  })
  sock.on('error', (err) => {
    netEvent({ type: 'tcp-error', id, message: err.message })
  })
}

function tcpConnect(opts: {
  host: string
  port: number
  tls?: boolean
  timeoutMs?: number
}): Promise<{ id: number; remoteHost: string; remotePort: number }> {
  return new Promise((res, rej) => {
    const id = nextNetId++
    const timeoutMs = opts.timeoutMs ?? 10000
    let settled = false
    const onConnect = (sock: Socket): void => {
      settled = true
      sock.setTimeout(0)
      wireTcpSocket(id, sock)
      res({ id, remoteHost: opts.host, remotePort: opts.port })
    }
    const sock: Socket = opts.tls
      ? tlsConnect({ host: opts.host, port: opts.port, rejectUnauthorized: false }, () =>
          onConnect(sock)
        )
      : createConnection({ host: opts.host, port: opts.port }, () => onConnect(sock))
    sock.setTimeout(timeoutMs, () => {
      if (!settled) {
        sock.destroy()
        rej(new Error(`TCP 连接超时: ${opts.host}:${opts.port}`))
      }
    })
    sock.once('error', (err) => {
      if (!settled) rej(new Error(`TCP 连接失败: ${err.message}`))
    })
  })
}

// ---------------------------------------------------------------
// mdns 桥
// ---------------------------------------------------------------

let simBonjour: Bonjour | null = null
const mdnsAds = new Map<number, ReturnType<Bonjour['publish']>>()
const mdnsBrowsers = new Set<Browser>()

/** "_pixelbox._tcp" → { type: 'pixelbox', protocol: 'tcp' } */
function parseServiceType(service: string): { type: string; protocol: 'tcp' | 'udp' } {
  const m = /^_?([^.]+?)\._?(tcp|udp)$/.exec(service.replace(/\.$/, ''))
  if (!m) return { type: service.replace(/^_/, ''), protocol: 'tcp' }
  return { type: m[1], protocol: m[2] as 'tcp' | 'udp' }
}

async function mdnsDiscover(
  service: string,
  timeoutMs: number
): Promise<Array<{ name: string; host: string; ip: string; port: number; txt: Record<string, string> }>> {
  simBonjour ??= new Bonjour()
  const { type, protocol } = parseServiceType(service)
  const found = new Map<
    string,
    { name: string; host: string; ip: string; port: number; txt: Record<string, string> }
  >()
  const browser = simBonjour.find({ type, protocol })
  mdnsBrowsers.add(browser)
  browser.on('up', (svc) => {
    const ip = (svc.addresses ?? []).find((a) => a.includes('.')) ?? svc.host
    found.set(`${ip}:${svc.port}`, {
      name: svc.name,
      host: svc.host,
      ip,
      port: svc.port,
      txt: (svc.txt ?? {}) as Record<string, string>
    })
  })
  await new Promise<void>((res) => setTimeout(res, timeoutMs))
  browser.stop()
  mdnsBrowsers.delete(browser)
  return Array.from(found.values())
}

// ---------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------

export function registerSimBridgeIpc(): void {
  // ---- fetch ----
  ipcMain.handle('sim:fetch', async (_e, req: SimFetchRequest): Promise<SimFetchResponse> => {
    return doFetch(req)
  })

  // ---- /app 预载 ----
  ipcMain.handle('sim:read-tree', async (_e, dir: string) => readTree(dir))

  // ---- storage ----
  ipcMain.handle('sim:storage-load', async (_e, ws: string) => storageLoad(ws))
  ipcMain.handle(
    'sim:storage-write',
    async (_e, ws: string, rel: string, data: ArrayBuffer): Promise<void> => {
      const abs = dataPath(ws, rel)
      await fsp.mkdir(dirname(abs), { recursive: true })
      await fsp.writeFile(abs, Buffer.from(data))
    }
  )
  ipcMain.handle('sim:storage-remove', async (_e, ws: string, rel: string): Promise<void> => {
    await fsp.rm(dataPath(ws, rel), { recursive: true, force: true })
  })
  ipcMain.handle('sim:storage-mkdir', async (_e, ws: string, rel: string): Promise<void> => {
    await fsp.mkdir(dataPath(ws, rel), { recursive: true })
  })
  ipcMain.handle('sim:storage-save-kv', async (_e, ws: string, kvJson: string): Promise<void> => {
    const root = storageRoot(ws)
    await fsp.mkdir(root, { recursive: true })
    JSON.parse(kvJson) // 校验后再写
    await fsp.writeFile(join(root, 'kv.json'), kvJson, 'utf8')
  })

  // ---- tcp ----
  ipcMain.handle(
    'sim:tcp-connect',
    async (_e, opts: { host: string; port: number; tls?: boolean; timeoutMs?: number }) =>
      tcpConnect(opts)
  )
  ipcMain.handle('sim:tcp-send', async (_e, id: number, data: ArrayBuffer): Promise<void> => {
    const sock = tcpSockets.get(id)
    if (!sock) throw new Error('TCP 连接不存在或已关闭')
    sock.write(Buffer.from(data))
  })
  ipcMain.handle('sim:tcp-close', async (_e, id: number): Promise<void> => {
    tcpSockets.get(id)?.destroy()
    tcpSockets.delete(id)
  })
  ipcMain.handle('sim:tcp-listen', async (_e, port: number): Promise<{ id: number; port: number }> => {
    return new Promise((res, rej) => {
      const serverId = nextNetId++
      const server = createServer((conn) => {
        const sockId = nextNetId++
        wireTcpSocket(sockId, conn)
        netEvent({
          type: 'tcp-conn',
          serverId,
          sockId,
          remoteHost: conn.remoteAddress ?? '',
          remotePort: conn.remotePort ?? 0
        })
      })
      server.once('error', (err) => rej(new Error(`TCP 监听失败: ${err.message}`)))
      server.listen(port, () => {
        tcpServers.set(serverId, server)
        const addr = server.address()
        res({ id: serverId, port: typeof addr === 'object' && addr ? addr.port : port })
      })
    })
  })
  ipcMain.handle('sim:tcp-server-close', async (_e, id: number): Promise<void> => {
    tcpServers.get(id)?.close()
    tcpServers.delete(id)
  })

  // ---- udp ----
  ipcMain.handle('sim:udp-create', async (_e, bindPort?: number): Promise<{ id: number }> => {
    return new Promise((res, rej) => {
      const id = nextNetId++
      const sock = createSocket('udp4')
      sock.on('message', (msg, rinfo) => {
        netEvent({
          type: 'udp-msg',
          id,
          data: msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength),
          host: rinfo.address,
          port: rinfo.port
        })
      })
      sock.on('error', (err) => {
        netEvent({ type: 'tcp-error', id, message: err.message })
      })
      sock.bind(bindPort ?? 0, () => {
        udpSockets.set(id, sock)
        res({ id })
      })
      sock.once('error', (err) => rej(new Error(`UDP 绑定失败: ${err.message}`)))
    })
  })
  ipcMain.handle(
    'sim:udp-send',
    async (_e, id: number, data: ArrayBuffer, host: string, port: number): Promise<void> => {
      const sock = udpSockets.get(id)
      if (!sock) throw new Error('UDP socket 不存在或已关闭')
      sock.send(Buffer.from(data), port, host)
    }
  )
  ipcMain.handle('sim:udp-close', async (_e, id: number): Promise<void> => {
    udpSockets.get(id)?.close()
    udpSockets.delete(id)
  })

  // ---- mdns ----
  ipcMain.handle('sim:mdns-discover', async (_e, service: string, timeoutMs?: number) =>
    mdnsDiscover(service, typeof timeoutMs === 'number' ? timeoutMs : 3000)
  )
  ipcMain.handle(
    'sim:mdns-advertise',
    async (
      _e,
      opts: { name: string; service: string; port: number; txt?: Record<string, string> }
    ): Promise<{ id: number }> => {
      simBonjour ??= new Bonjour()
      const { type, protocol } = parseServiceType(opts.service)
      const id = nextNetId++
      const ad = simBonjour.publish({
        name: opts.name,
        type,
        protocol,
        port: opts.port,
        txt: opts.txt ?? {}
      })
      mdnsAds.set(id, ad)
      return { id }
    }
  )
  ipcMain.handle('sim:mdns-stop', async (_e, id: number): Promise<void> => {
    mdnsAds.get(id)?.stop?.()
    mdnsAds.delete(id)
  })

  // ---- misc ----
  ipcMain.handle('sim:hostname', async (): Promise<string> => hostname())
}

/** 退出/停止时清理全部网络资源 */
export function disposeSimBridge(): void {
  for (const s of tcpSockets.values()) s.destroy()
  tcpSockets.clear()
  for (const s of tcpServers.values()) s.close()
  tcpServers.clear()
  for (const s of udpSockets.values()) s.close()
  udpSockets.clear()
  for (const ad of mdnsAds.values()) ad.stop?.()
  mdnsAds.clear()
  for (const b of mdnsBrowsers) b.stop()
  mdnsBrowsers.clear()
  simBonjour?.destroy()
  simBonjour = null
}
