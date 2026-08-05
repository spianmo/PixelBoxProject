/**
 * px.storage(kv + fs)与虚拟文件系统
 *
 * 设计:契约中 fs/kv 全部为同步 API,而宿主落盘只能异步。
 * 因此沙箱内维护内存镜像(load 时由宿主预载 /data 与 kv 全量),
 * 读操作命中内存,写操作先改内存、再异步写穿(write-through)到
 * userData/pixelbox-sim/<workspace名>/,与真机 LittleFS 行为在应用视角一致。
 *
 * 路径空间:
 *   /data  可写(落盘)
 *   /app   只读(工作区 dist/ 镜像:main.js、manifest.json、assets/**)
 */
import type { HostLink } from './rpc'
import type { SimFileEntry } from '../../protocol'
import { toU8 } from './util'

interface VfsFile {
  data: Uint8Array
  mtime: number
}

export interface PxFileStatLike {
  name: string
  size: number
  isDir: boolean
  mtime: number
}

/** 归一化为以 / 开头、无 . / .. / 重复斜杠的路径 */
export function normalizePath(p: string): string {
  const parts = p.split('/')
  const out: string[] = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return '/' + out.join('/')
}

const ENC = new TextEncoder()
const DEC = new TextDecoder()

export class Vfs {
  /** 绝对路径 → 文件 */
  private files = new Map<string, VfsFile>()
  /** 显式创建的目录集合(文件父目录隐式存在) */
  private dirs = new Set<string>()
  private link: HostLink
  private logError: (msg: string) => void

  constructor(link: HostLink, logError: (msg: string) => void) {
    this.link = link
    this.logError = logError
    this.dirs.add('/data')
    this.dirs.add('/app')
  }

  /** load 时预载宿主内容 */
  seed(appFiles: SimFileEntry[], dataFiles: SimFileEntry[]): void {
    const now = Date.now()
    for (const f of appFiles) {
      this.files.set(normalizePath('/app/' + f.path), { data: new Uint8Array(f.data), mtime: now })
    }
    for (const f of dataFiles) {
      this.files.set(normalizePath('/data/' + f.path), { data: new Uint8Array(f.data), mtime: now })
    }
  }

  private assertWritable(path: string): void {
    if (!path.startsWith('/data/') && path !== '/data') {
      throw new Error(`只有 /data 可写: ${path}`)
    }
  }

  /** /data 内相对路径(供落盘 RPC) */
  private relData(path: string): string {
    return path.slice('/data/'.length)
  }

  private persistWrite(path: string, data: Uint8Array): void {
    const copy = data.slice().buffer
    this.link
      .call('storage.write', { path: this.relData(path), data: copy }, [copy])
      .catch((err) => this.logError(`storage 落盘失败 ${path}: ${err.message}`))
  }

  exists(path: string): boolean {
    const p = normalizePath(path)
    if (this.files.has(p) || this.dirs.has(p)) return true
    // 隐式目录:任何文件位于其下
    const prefix = p + '/'
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  private isDir(path: string): boolean {
    const p = normalizePath(path)
    if (this.files.has(p)) return false
    return this.exists(p)
  }

  readBytes(path: string): ArrayBuffer {
    const p = normalizePath(path)
    const f = this.files.get(p)
    if (!f) throw new Error(`文件不存在: ${p}`)
    return f.data.slice().buffer
  }

  readText(path: string): string {
    const p = normalizePath(path)
    const f = this.files.get(p)
    if (!f) throw new Error(`文件不存在: ${p}`)
    return DEC.decode(f.data)
  }

  writeBytes(path: string, data: ArrayBuffer | Uint8Array): void {
    const p = normalizePath(path)
    this.assertWritable(p)
    const u8 = toU8(data).slice()
    this.files.set(p, { data: u8, mtime: Date.now() })
    this.persistWrite(p, u8)
  }

  writeText(path: string, text: string): void {
    this.writeBytes(path, ENC.encode(text))
  }

  append(path: string, data: string | ArrayBuffer | Uint8Array): void {
    const p = normalizePath(path)
    this.assertWritable(p)
    const add = typeof data === 'string' ? ENC.encode(data) : toU8(data)
    const old = this.files.get(p)
    const merged = new Uint8Array((old?.data.length ?? 0) + add.length)
    if (old) merged.set(old.data)
    merged.set(add, old?.data.length ?? 0)
    this.files.set(p, { data: merged, mtime: Date.now() })
    this.persistWrite(p, merged)
  }

  remove(path: string): void {
    const p = normalizePath(path)
    this.assertWritable(p)
    let removedAny = false
    if (this.files.delete(p)) removedAny = true
    // 目录:级联删除
    const prefix = p + '/'
    for (const key of Array.from(this.files.keys())) {
      if (key.startsWith(prefix)) {
        this.files.delete(key)
        removedAny = true
      }
    }
    for (const d of Array.from(this.dirs)) {
      if (d === p || d.startsWith(prefix)) {
        this.dirs.delete(d)
        removedAny = true
      }
    }
    if (removedAny) {
      this.link
        .call('storage.remove', { path: this.relData(p) })
        .catch((err) => this.logError(`storage 删除失败 ${p}: ${err.message}`))
    }
  }

  mkdir(path: string): void {
    const p = normalizePath(path)
    this.assertWritable(p)
    this.dirs.add(p)
    this.link
      .call('storage.mkdir', { path: this.relData(p) })
      .catch((err) => this.logError(`storage 建目录失败 ${p}: ${err.message}`))
  }

  readDir(path: string): PxFileStatLike[] {
    const p = normalizePath(path)
    if (!this.isDir(p)) throw new Error(`目录不存在: ${p}`)
    const prefix = p === '/' ? '/' : p + '/'
    const out = new Map<string, PxFileStatLike>()
    for (const [key, f] of this.files) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        out.set(rest, { name: rest, size: f.data.length, isDir: false, mtime: f.mtime })
      } else {
        const dirName = rest.slice(0, slash)
        if (!out.has(dirName)) out.set(dirName, { name: dirName, size: 0, isDir: true, mtime: 0 })
      }
    }
    for (const d of this.dirs) {
      if (!d.startsWith(prefix) || d === p) continue
      const rest = d.slice(prefix.length)
      if (!rest.includes('/') && !out.has(rest)) {
        out.set(rest, { name: rest, size: 0, isDir: true, mtime: 0 })
      }
    }
    return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  stat(path: string): PxFileStatLike | null {
    const p = normalizePath(path)
    const f = this.files.get(p)
    if (f) {
      const name = p.slice(p.lastIndexOf('/') + 1)
      return { name, size: f.data.length, isDir: false, mtime: f.mtime }
    }
    if (this.isDir(p)) {
      const name = p.slice(p.lastIndexOf('/') + 1)
      return { name, size: 0, isDir: true, mtime: 0 }
    }
    return null
  }
}

// ---------------------------------------------------------------
// kv(NVS 模拟):内存 Map + 整体 JSON 异步写穿
// ---------------------------------------------------------------

export class KvStore {
  private map = new Map<string, string>()
  private link: HostLink
  private logError: (msg: string) => void
  private saveTimer: number | null = null

  constructor(link: HostLink, logError: (msg: string) => void) {
    this.link = link
    this.logError = logError
  }

  seed(kvJson: string): void {
    try {
      const obj = JSON.parse(kvJson) as Record<string, string>
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') this.map.set(k, v)
      }
    } catch {
      // 损坏则从空开始
    }
  }

  /** 防抖落盘(50ms 内合并) */
  private schedulePersist(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      const obj: Record<string, string> = {}
      for (const [k, v] of this.map) obj[k] = v
      this.link
        .call('storage.kv', { kvJson: JSON.stringify(obj) })
        .catch((err) => this.logError(`kv 落盘失败: ${err.message}`))
    }, 50)
  }

  get(key: string): string | null {
    return this.map.get(key) ?? null
  }

  getJSON<T>(key: string): T | null {
    const raw = this.map.get(key)
    if (raw === undefined) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  set(key: string, value: string | number | boolean | object): void {
    this.map.set(key, typeof value === 'string' ? value : JSON.stringify(value))
    this.schedulePersist()
  }

  remove(key: string): void {
    this.map.delete(key)
    this.schedulePersist()
  }

  keys(): string[] {
    return Array.from(this.map.keys())
  }

  clear(): void {
    this.map.clear()
    this.schedulePersist()
  }
}
