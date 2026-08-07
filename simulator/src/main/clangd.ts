/**
 * clangd LSP 会话(main 进程)—— 固件工程 C/C++ 补全 / 悬停 / 诊断
 *
 * 设计为「通用且薄」的 stdio LSP 桥:
 * - resolveClangd():设置 toolchain.clangdPath(非空且存在)→ PATH 中的 clangd → /usr/bin/clangd
 * - ClangdSession:按工作区根惰性拉起一个 clangd 进程,自带最小 JSON-RPC 层
 *   (Content-Length 分帧、请求 id 跟踪 + 20s 超时、通知收发);崩溃自动重启,
 *   连续 3 次失败置为 failed
 * - IPC:clangd:start/stop/request(invoke)+ clangd:notify(send);
 *   服务器通知白名单转发(clangd:event,仅 publishDiagnostics),
 *   异步状态变化广播 clangd:status(重启成功 / 崩溃到达上限 / 停止)
 * - --query-driver 指向 ~/.espressif/tools 下的交叉编译器,clangd 据此提取
 *   xtensa/riscv 工具链的系统头文件路径(ESP-IDF 头文件解析的关键)
 */
import { ipcMain, BrowserWindow } from 'electron'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { getSettingsSync } from './settings'
import { getWatchedRoot } from './workspace'
import type { ClangdStatus, ClangdServerNotification } from '../shared/ipc-types'

/** 请求超时(clangd 首次解析 ESP-IDF 头文件可达数秒,给足余量) */
const REQUEST_TIMEOUT_MS = 20_000
/** 连续崩溃重启上限,超过置 failed */
const MAX_RESTARTS = 3

/** renderer → clangd 的请求方法白名单 */
const REQUEST_WHITELIST = new Set([
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/signatureHelp',
  'textDocument/definition'
])

/** renderer → clangd 的通知方法白名单(文档同步) */
const NOTIFY_WHITELIST = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
  'textDocument/didSave'
])

/** clangd → renderer 的服务器通知白名单(诊断) */
const SERVER_NOTIFY_WHITELIST = new Set(['textDocument/publishDiagnostics'])

/**
 * 解析 clangd 可执行文件:设置覆盖(非空且存在)→ PATH → /usr/bin/clangd。
 * 全部落空返回 null(renderer 提示到设置页配置)。
 */
export function resolveClangd(): string | null {
  const configured = getSettingsSync().toolchain.clangdPath
  if (configured && existsSync(configured)) return configured
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['clangd'], {
      encoding: 'utf8'
    })
    const found = which.status === 0 ? which.stdout.split('\n')[0]?.trim() : ''
    if (found && existsSync(found)) return found
  } catch {
    // which 不可用则继续走固定回退
  }
  return existsSync('/usr/bin/clangd') ? '/usr/bin/clangd' : null
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 单个 clangd 进程会话:stdio LSP 分帧 + 最小 JSON-RPC。
 * 生命周期:spawn → initialize/initialized → (使用) → dispose。
 */
class ClangdSession {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private disposed = false
  private restarts = 0
  /** 会话已进入 failed(不再重启) */
  failed = false

  constructor(
    readonly root: string,
    readonly clangdPath: string,
    private onServerNotification: (msg: ClangdServerNotification) => void,
    private onAsyncStatus: (status: ClangdStatus) => void
  ) {}

  /** 拉起进程并完成 initialize 握手(重启复用同一路径) */
  async start(): Promise<void> {
    const args = [
      '--background-index',
      '--compile-commands-dir=' + join(this.root, 'build'),
      // 交叉编译器白名单:clangd 询问 driver 提取 xtensa/riscv 系统头文件路径
      '--query-driver=' + join(homedir(), '.espressif', 'tools', '**', 'bin', '*'),
      '--log=error',
      '--pch-storage=memory',
      '--limit-results=80'
    ]
    const proc = spawn(this.clangdPath, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.root })
    this.proc = proc
    this.buffer = Buffer.alloc(0)

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', () => undefined) // --log=error 下噪音极少,静默丢弃
    proc.on('error', (err) => {
      console.error('[clangd] 进程启动失败:', err.message)
      this.handleExit()
    })
    proc.on('exit', () => this.handleExit())

    await this.request('initialize', {
      processId: process.pid,
      rootUri: 'file://' + this.root,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          // 全文同步(didChange 发整篇),桥两端都最简单;snippet 关闭 → 纯文本插入
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: {}
        }
      }
    })
    this.notify('initialized', {})
  }

  /** 进程意外退出:重启(上限 MAX_RESTARTS)或置 failed 并广播 */
  private handleExit(): void {
    const wasProc = this.proc
    this.proc = null
    // 悬挂中的请求全部失败
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('clangd:crashed'))
    }
    this.pending.clear()
    if (this.disposed || !wasProc) return
    if (this.restarts >= MAX_RESTARTS) {
      this.failed = true
      this.onAsyncStatus({ state: 'failed' })
      return
    }
    this.restarts++
    void this.start()
      .then(() => {
        // 重启成功:renderer 收到后重发全部已打开文档的 didOpen
        this.onAsyncStatus({ state: 'running', clangdPath: this.clangdPath })
      })
      .catch(() => {
        this.failed = true
        this.onAsyncStatus({ state: 'failed' })
      })
  }

  /** stdout 分帧:Content-Length: N\r\n\r\n<N 字节 JSON>(可能夹杂其他头行) */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        // 无法解析的头:丢弃到分隔符后继续(防死循环)
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const len = parseInt(m[1], 10)
      const total = headerEnd + 4 + len
      if (this.buffer.length < total) return // 报文未收全
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8')
      this.buffer = this.buffer.subarray(total)
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>)
      } catch {
        // 单条坏报文不拖垮会话
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      // 请求响应
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if ('error' in msg && msg.error) {
        const err = msg.error as { message?: string }
        p.reject(new Error('clangd:lspError ' + (err.message ?? '')))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string' && msg.id === undefined) {
      // 服务器通知:白名单内才转发 renderer
      if (SERVER_NOTIFY_WHITELIST.has(msg.method)) {
        this.onServerNotification({ method: msg.method, params: msg.params })
      }
      return
    }
    // 服务器 → 客户端请求(如 workspace/configuration):最小实现,统一回空结果
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: msg.id, result: null })
    }
  }

  private send(payload: unknown): void {
    const proc = this.proc
    if (!proc || proc.stdin.destroyed) return
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    proc.stdin.write(body)
  }

  /** JSON-RPC 请求(id 跟踪 + 超时) */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error('clangd:notRunning'))
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('clangd:timeout'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** JSON-RPC 通知(无响应) */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** 结束会话:礼貌 shutdown 后杀进程 */
  dispose(): void {
    this.disposed = true
    const proc = this.proc
    this.proc = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('clangd:stopped'))
    }
    this.pending.clear()
    if (proc) {
      try {
        proc.kill()
      } catch {
        // 已退出
      }
    }
  }
}

// ---------------------------------------------------------------
// IPC 注册(单会话:跟随当前工作区)
// ---------------------------------------------------------------

let session: ClangdSession | null = null
/** start 并发去重(多个 C 文件同时打开时只拉起一次) */
let starting: Promise<ClangdStatus> | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** 校验 uri 位于会话工作区内(didOpen 等文档通知的路径牢笼) */
function uriInsideRoot(uri: unknown, root: string): boolean {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return false
  const p = decodeURIComponent(uri.slice('file://'.length))
  const abs = resolve(p)
  return abs === root || abs.startsWith(root + '/')
}

async function startSession(requestedRoot: string | undefined): Promise<ClangdStatus> {
  const watched = getWatchedRoot()
  // renderer 通常不传 root(main 侧以当前工作区为准);传了则必须与工作区一致
  if (!watched) throw new Error('clangd:badRoot')
  if (requestedRoot !== undefined && resolve(requestedRoot) !== resolve(watched)) {
    throw new Error('clangd:badRoot')
  }
  const root = resolve(watched)

  // 已有同根会话:直接返回现状(failed 不自动复活,等用户重开/重启)
  if (session && session.root === root) {
    return session.failed
      ? { state: 'failed' }
      : { state: 'running', clangdPath: session.clangdPath }
  }
  // 工作区已切换:旧会话停掉
  if (session) {
    session.dispose()
    session = null
  }

  if (!existsSync(join(root, 'build', 'compile_commands.json'))) {
    return { state: 'noCompileCommands' }
  }
  const clangdPath = resolveClangd()
  if (!clangdPath) return { state: 'noClangd' }

  const s = new ClangdSession(
    root,
    clangdPath,
    (msg) => broadcast('clangd:event', msg),
    (status) => broadcast('clangd:status', status)
  )
  try {
    await s.start()
  } catch (err) {
    s.dispose()
    console.error('[clangd] initialize 失败:', String(err))
    return { state: 'failed' }
  }
  session = s
  return { state: 'running', clangdPath }
}

export function registerClangdIpc(): void {
  // 惰性启动(EditorHost 打开 C/C++ 文件时调用);返回状态而非抛错,便于 renderer 提示
  ipcMain.handle(
    'clangd:start',
    async (_e, opts?: { root?: string }): Promise<ClangdStatus> => {
      if (starting) return starting
      starting = startSession(opts?.root).finally(() => {
        starting = null
      })
      return starting
    }
  )

  ipcMain.handle('clangd:stop', async (): Promise<void> => {
    session?.dispose()
    session = null
    broadcast('clangd:status', { state: 'stopped' } satisfies ClangdStatus)
  })

  // LSP 请求转发(方法白名单)
  ipcMain.handle(
    'clangd:request',
    async (_e, opts: { method: string; params: unknown }): Promise<unknown> => {
      if (!opts || !REQUEST_WHITELIST.has(opts.method)) throw new Error('clangd:badMethod')
      if (!session || session.failed) throw new Error('clangd:notRunning')
      return session.request(opts.method, opts.params)
    }
  )

  // 文档同步通知(fire-and-forget;会话未就绪时静默丢弃)
  ipcMain.on('clangd:notify', (_e, opts: { method: string; params: unknown }) => {
    if (!opts || !NOTIFY_WHITELIST.has(opts.method) || !session || session.failed) return
    // 路径牢笼:文档通知的 uri 必须位于会话工作区内
    const doc = (opts.params as { textDocument?: { uri?: unknown } } | null)?.textDocument
    if (!doc || !uriInsideRoot(doc.uri, session.root)) return
    session.notify(opts.method, opts.params)
  })
}

/** 退出前清理(main/index.ts before-quit) */
export function disposeClangd(): void {
  session?.dispose()
  session = null
}
