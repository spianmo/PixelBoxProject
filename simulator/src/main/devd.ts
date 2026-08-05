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
import type { DevdDevice, PushProgress } from '../shared/ipc-types'
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

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          id?: number
          result?: unknown
          error?: { code: number; message: string }
        }
        if (typeof msg.id !== 'number') return // 忽略主动事件(log/app.state)
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`devd 错误 ${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
      } catch {
        // 非 JSON 帧,忽略
      }
    })
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('devd 连接已关闭'))
      this.pending.clear()
    })
  }

  static connect(host: string, port: number): Promise<DevdClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/devd`, { handshakeTimeout: 8000 })
      ws.once('open', () => resolve(new DevdClient(ws)))
      ws.once('error', (err) => reject(new Error(`连接设备失败: ${err.message}`)))
    })
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
}

export function disposeDevd(): void {
  bonjour?.destroy()
  bonjour = null
}
