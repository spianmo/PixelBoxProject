/**
 * devd 客户端(main 进程):mDNS 设备发现 + 真机推送
 * 协议见 docs/architecture.md §5:
 *   ws://<ip>:8765/devd,JSON 文本帧 {id, method, params} / {id, result|error}
 *   推送流程:hello → app.push_begin → app.push_chunk(≤32KB/块) → app.push_end
 */
import { ipcMain, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import WebSocket from 'ws'
import { Bonjour } from 'bonjour-service'
import type { DevdDevice, DevdLogEvent, PushProgress } from '../shared/ipc-types'
import { buildWorkspace } from './builder'

/** 单块 24KB(协议上限 32KB,留 base64 与 JSON 包装余量) */
const CHUNK_SIZE = 24 * 1024
const RPC_TIMEOUT_MS = 15000

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function progress(p: PushProgress): void {
  broadcast('devd:push-progress', p)
}

// ---------------- mDNS 发现 ----------------

let bonjour: Bonjour | null = null

/** 扫描 _pixelbox._tcp 服务,收集 timeoutMs 后返回 */
async function discover(timeoutMs: number): Promise<DevdDevice[]> {
  bonjour ??= new Bonjour()
  const found = new Map<string, DevdDevice>()
  const browser = bonjour.find({ type: 'pixelbox', protocol: 'tcp' })
  browser.on('up', (svc) => {
    const ip = (svc.addresses ?? []).find((a) => a.includes('.')) ?? svc.host
    const dev: DevdDevice = {
      name: svc.name,
      host: svc.host,
      ip,
      port: svc.port,
      txt: (svc.txt ?? {}) as Record<string, string>
    }
    found.set(`${dev.ip}:${dev.port}`, dev)
    // 实时增量推送,供下拉框即时刷新
    broadcast('devd:devices', Array.from(found.values()))
  })
  await new Promise<void>((res) => setTimeout(res, timeoutMs))
  browser.stop()
  return Array.from(found.values())
}

// ---------------- devd RPC 客户端 ----------------

class DevdClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /** 主动事件回调({event, data} 帧;日志订阅用) */
  onEvent: ((event: string, data: Record<string, unknown>) => void) | null = null
  /** 连接关闭回调(含异常断开;重连由订阅管理器负责) */
  onClose: (() => void) | null = null

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          id?: number
          result?: unknown
          error?: { code: number; message: string }
          event?: string
          data?: Record<string, unknown>
        }
        if (typeof msg.id !== 'number') {
          // 主动事件帧(log/app.state)
          if (typeof msg.event === 'string') this.onEvent?.(msg.event, msg.data ?? {})
          return
        }
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`devd 错误 ${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
      } catch {
        // 非 JSON 帧,忽略
      }
    })
    // open 之后的 error 事件必须有监听器,否则 EventEmitter 直接抛崩进程;
    // 出错后 ws 必然触发 close,统一在 close 里收尾
    ws.on('error', () => {})
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('devd 连接已关闭'))
      this.pending.clear()
      this.onClose?.()
    })
  }

  static connect(host: string, port: number): Promise<DevdClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/devd`, { handshakeTimeout: 8000 })
      ws.once('open', () => resolve(new DevdClient(ws)))
      ws.once('error', (err) => reject(new Error(`连接设备失败: ${err.message}`)))
    })
  }

  /**
   * 心跳保活:定期 ping,一个周期内未收到 pong 即判死链强制断开。
   * 设备硬重启/断电不发 TCP FIN,没有心跳的话连接会永远呈"已连接"假象。
   * (固件 httpd handle_ws_control_frames=false 自动应答 pong,真机已实测)
   */
  startKeepalive(intervalMs: number): void {
    let alive = true
    this.ws.on('pong', () => {
      alive = true
    })
    const timer = setInterval(() => {
      try {
        if (!alive) {
          this.ws.terminate() // 触发 close → 订阅管理器重连
          return
        }
        alive = false
        this.ws.ping()
      } catch {
        // CLOSING/CLOSED 态 ping 会抛;close 事件随后清理本定时器
      }
    }, intervalMs)
    this.ws.on('close', () => clearInterval(timer))
  }

  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`devd 请求超时: ${method}`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

// ---------------- 真机日志订阅(logs.subscribe) ----------------

const LOG_RECONNECT_MS = 3000
/** 心跳间隔(设备硬重启不发 FIN,靠 ping/pong 判死链) */
const LOG_KEEPALIVE_MS = 15000
/** 日志批量广播节流窗口(回放阶段一帧一条,合并降低 IPC 频率) */
const LOG_FLUSH_MS = 30

interface LogSubscription {
  /** 渲染端设备 key(ip:port,见 shell/store deviceKey) */
  key: string
  host: string
  port: number
  client: DevdClient | null
  retryTimer: NodeJS.Timeout | null
  connecting: boolean
  stopped: boolean
  /** 已收到的最大日志 seq(新固件断线增量续传;老固件事件无 seq,恒 0) */
  lastSeq: number
  /** 设备开机标识(订阅响应 boot 字段;变化 ⇒ 设备已重启) */
  bootId: number | undefined
  /**
   * 全量重放窗口静默:重放决策到 logs.subscribe{since:0} 响应之间到达的实时帧丢弃
   * (这些行都在环形缓冲里,即将随回放到达;不丢会在清屏后重复出现)
   */
  muted: boolean
  /** 已提示过断线,重试期间不再刷屏 */
  announcedDown: boolean
}

const logSubs = new Map<string, LogSubscription>()

let pendingLogs: DevdLogEvent[] = []
let logFlushTimer: NodeJS.Timeout | null = null

function emitLog(ev: DevdLogEvent): void {
  pendingLogs.push(ev)
  logFlushTimer ??= setTimeout(() => {
    logFlushTimer = null
    const batch = pendingLogs
    pendingLogs = []
    broadcast('devd:log', batch)
  }, LOG_FLUSH_MS)
}

/** 连接状态提示行(tag=devd,随设备 key 路由到对应下拉项) */
function emitLogStatus(sub: LogSubscription, level: 'info' | 'warn', msg: string): void {
  emitLog({ deviceKey: sub.key, level, tag: 'devd', msg, ts: Date.now() })
}

/**
 * 通知渲染端清掉该设备旧行(随后必有全量回放补齐)。
 * 批量队列中该设备未发出的行一并丢弃——否则 30ms 后 flush 会把"清屏前的行"
 * 送到清屏之后,与回放重复。
 */
function resetDeviceLog(key: string): void {
  pendingLogs = pendingLogs.filter((l) => l.deviceKey !== key)
  broadcast('devd:log-reset', { key })
}

/**
 * 就地全量重放:清屏 + 同连接以 since=0 重新订阅(设备重放整个环形缓冲)。
 * 用于设备重启(seq 归零)与渲染端重载后的重复订阅(合同:订阅 ⇒ 回放)。
 */
async function replayFromScratch(sub: LogSubscription): Promise<void> {
  const client = sub.client
  if (!client || sub.stopped) return
  sub.muted = true
  try {
    sub.lastSeq = 0
    resetDeviceLog(sub.key)
    await client.call('logs.subscribe', { since: 0 })
  } catch {
    client.close() // 重订阅失败按断线处理,close 触发重连
  } finally {
    sub.muted = false
  }
}

function scheduleLogReconnect(sub: LogSubscription): void {
  if (sub.stopped || sub.retryTimer) return
  sub.retryTimer = setTimeout(() => {
    sub.retryTimer = null
    void connectLogSub(sub)
  }, LOG_RECONNECT_MS)
}

async function connectLogSub(sub: LogSubscription): Promise<void> {
  if (sub.stopped || sub.connecting || sub.client) return
  sub.connecting = true
  try {
    const client = await DevdClient.connect(sub.host, sub.port)
    if (sub.stopped) {
      client.close()
      return
    }
    sub.client = client
    client.startKeepalive(LOG_KEEPALIVE_MS)
    client.onEvent = (event, data) => {
      if (event !== 'log' || sub.stopped || sub.muted) return
      if (typeof data.seq === 'number' && data.seq > 0) {
        // 按 seq 去重:回放与广播路径可能交叠送同一行(固件刻意不合并两路水位)
        if (data.seq <= sub.lastSeq) return
        sub.lastSeq = data.seq
      }
      emitLog({
        deviceKey: sub.key,
        level:
          data.level === 'debug' || data.level === 'warn' || data.level === 'error'
            ? data.level
            : 'info',
        tag: typeof data.tag === 'string' ? data.tag : 'sys',
        msg: typeof data.msg === 'string' ? data.msg : '',
        ts: typeof data.ts === 'number' ? data.ts : Date.now()
      })
    }
    client.onClose = () => {
      sub.client = null
      if (sub.stopped) return
      if (!sub.announcedDown) {
        sub.announcedDown = true
        emitLogStatus(sub, 'warn', `日志通道断开,${LOG_RECONNECT_MS / 1000} 秒后自动重连…`)
      }
      scheduleLogReconnect(sub)
    }

    // 订阅并回放:since 之后的历史由设备环形缓冲补齐
    const res = await client.call<{ ok: boolean; last_seq?: number; boot?: number }>(
      'logs.subscribe',
      { since: sub.lastSeq }
    )
    const rebooted = typeof res?.boot === 'number' && sub.bootId !== undefined && res.boot !== sub.bootId
    if (typeof res?.boot === 'number') sub.bootId = res.boot
    if (typeof res?.last_seq !== 'number') {
      // 老固件:忽略 since、总是全量回放 → 让渲染端先清掉该设备旧行,避免重复
      sub.lastSeq = 0
      resetDeviceLog(sub.key)
    } else if (rebooted || res.last_seq < sub.lastSeq) {
      // 设备已重启(boot 变化;last_seq 比较兜底):旧行作废,回退全量订阅
      await replayFromScratch(sub)
    }
    sub.announcedDown = false
    emitLogStatus(sub, 'info', '日志通道已连接')
  } catch (err) {
    if (!sub.stopped) {
      if (!sub.announcedDown) {
        sub.announcedDown = true
        const msg = err instanceof Error ? err.message : String(err)
        emitLogStatus(sub, 'warn', `日志通道连接失败(${msg}),自动重试中…`)
      }
      if (sub.client) {
        sub.client.close() // 订阅 RPC 失败:close 触发 onClose 走重连
      } else {
        scheduleLogReconnect(sub)
      }
    }
  } finally {
    sub.connecting = false
  }
}

function startLogSubscription(key: string, host: string, port: number): void {
  const existing = logSubs.get(key)
  if (existing) {
    // 重复订阅(渲染端 reload 后重选设备等):渲染端刚清了行,必须重新回放,
    // 否则面板空白且历史再也补不回来
    if (existing.client) {
      void replayFromScratch(existing)
    } else {
      // 断线中:重置续传水位,重连成功即全量回放而非增量
      existing.lastSeq = 0
      existing.bootId = undefined
      resetDeviceLog(existing.key)
    }
    return
  }
  const sub: LogSubscription = {
    key,
    host,
    port,
    client: null,
    retryTimer: null,
    connecting: false,
    stopped: false,
    lastSeq: 0,
    bootId: undefined,
    muted: false,
    announcedDown: false
  }
  logSubs.set(key, sub)
  void connectLogSub(sub)
}

function stopLogSubscription(key: string): void {
  const sub = logSubs.get(key)
  if (!sub) return
  logSubs.delete(key)
  sub.stopped = true
  if (sub.retryTimer) {
    clearTimeout(sub.retryTimer)
    sub.retryTimer = null
  }
  // 设备端在 socket 断开时自动移除订阅 fd,无需 logs.unsubscribe
  sub.client?.close()
  sub.client = null
}

// ---------------- 推送流程 ----------------

/** 递归收集 dist 下的所有文件(相对路径统一为 / 分隔) */
async function collectFiles(dir: string, base: string): Promise<string[]> {
  const out: string[] = []
  const items = await fsp.readdir(dir, { withFileTypes: true })
  for (const it of items) {
    const p = join(dir, it.name)
    if (it.isDirectory()) out.push(...(await collectFiles(p, base)))
    else out.push(relative(base, p).split(sep).join('/'))
  }
  return out
}

async function pushToDevice(root: string, host: string, port: number): Promise<void> {
  // 1) 构建
  progress({ phase: 'connect', percent: 0, message: '构建中…' })
  const build = await buildWorkspace(root)
  if (!build.success || !build.outDir || !build.manifest) {
    throw new Error(`构建失败: ${build.errors.join('; ')}`)
  }

  // 2) 连接 + hello
  progress({ phase: 'connect', percent: 5 })
  const client = await DevdClient.connect(host, port)
  try {
    progress({ phase: 'hello', percent: 8 })
    await client.call('hello', {})

    // 3) push_begin:manifest + 文件清单(size/sha256)
    const relFiles = await collectFiles(build.outDir, build.outDir)
    const metas: Array<{ path: string; size: number; sha256: string }> = []
    const contents = new Map<string, Buffer>()
    for (const rel of relFiles) {
      const buf = await fsp.readFile(join(build.outDir, rel))
      contents.set(rel, buf)
      metas.push({ path: rel, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
    }
    const { session } = await client.call<{ session: string }>('app.push_begin', {
      manifest: build.manifest,
      files: metas
    })

    // 4) 分块上传
    const totalBytes = metas.reduce((s, m) => s + m.size, 0) || 1
    let sentBytes = 0
    for (const rel of relFiles) {
      const buf = contents.get(rel)!
      for (let offset = 0; offset < buf.length || (buf.length === 0 && offset === 0); offset += CHUNK_SIZE) {
        const chunk = buf.subarray(offset, offset + CHUNK_SIZE)
        await client.call('app.push_chunk', {
          session,
          path: rel,
          offset,
          dataB64: chunk.toString('base64')
        })
        sentBytes += chunk.length
        progress({
          phase: 'upload',
          percent: 10 + Math.round((sentBytes / totalBytes) * 80),
          file: rel
        })
        if (buf.length === 0) break
      }
    }

    // 5) push_end:设备校验 + 原子切换 + 热重启 VM
    progress({ phase: 'finalize', percent: 95 })
    await client.call('app.push_end', { session })
    progress({ phase: 'done', percent: 100 })
  } finally {
    client.close()
  }
}

export function registerDevdIpc(): void {
  ipcMain.handle('devd:discover', async (_e, timeoutMs?: number): Promise<DevdDevice[]> => {
    return discover(typeof timeoutMs === 'number' ? timeoutMs : 3000)
  })

  ipcMain.handle(
    'devd:push',
    async (_e, opts: { root: string; host: string; port: number }): Promise<void> => {
      try {
        await pushToDevice(opts.root, opts.host, opts.port)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        progress({ phase: 'error', percent: 0, message: msg })
        throw new Error(msg)
      }
    }
  )

  ipcMain.handle(
    'devd:logs-subscribe',
    (_e, opts: { key: string; host: string; port: number }): void => {
      startLogSubscription(opts.key, opts.host, opts.port)
    }
  )

  ipcMain.handle('devd:logs-unsubscribe', (_e, opts: { key: string }): void => {
    stopLogSubscription(opts.key)
  })
}

export function disposeDevd(): void {
  for (const key of Array.from(logSubs.keys())) stopLogSubscription(key)
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
  pendingLogs = []
  bonjour?.destroy()
  bonjour = null
}
