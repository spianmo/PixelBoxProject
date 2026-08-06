/**
 * PtyService(main 进程)—— 集成终端会话管理(阶段 1/2)
 *
 * - 真 PTY:node-pty(N-API 预编译/electron-rebuild 产物),以用户 $SHELL 的
 *   login shell 启动,cwd = 当前工作区根(renderer 传入;无工作区用 HOME),
 *   env 继承 + TERM=xterm-256color + LANG 兜底
 * - 兜底:node-pty 加载/spawn 失败时回退 child_process pipe 模式
 *   (TERM=dumb,无 resize/无行编辑,UI 提示体验受限);运行时探测选择,
 *   后端状态经 terminal:backend 暴露给 UI
 * - 数据流:pty 输出按 16ms 聚合批量经 terminal:data 下发(高频输出防 IPC 风暴)
 * - 生命周期:窗口关闭/应用退出 disposeTerminal() 杀净全部会话;
 *   会话计数命名 Local、Local (2)…(关闭释放编号,新会话补位)
 */
import { ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type {
  TerminalBackend,
  TerminalCreateOptions,
  TerminalDataChunk,
  TerminalExitEvent,
  TerminalSessionInfo
} from '../shared/ipc-types'

// ---------------------------------------------------------------
// node-pty 运行时探测(加载失败 → pipe 兜底)
// ---------------------------------------------------------------

/** node-pty 我们用到的最小表面(避免类型层硬依赖其 d.ts) */
interface PtyProcess {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
    }
  ): PtyProcess
}

const nodeRequire = createRequire(__filename)

let ptyModule: NodePtyModule | null | undefined // undefined = 未探测
let ptyLoadError = ''

/** 探测 node-pty 可用性(仅首次真实 require;PIXELBOX_FORCE_PIPE=1 强制兜底,自检用) */
function loadPty(): NodePtyModule | null {
  if (process.env.PIXELBOX_FORCE_PIPE === '1') return null
  if (ptyModule !== undefined) return ptyModule
  try {
    ptyModule = nodeRequire('node-pty') as NodePtyModule
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err)
    ptyModule = null
  }
  return ptyModule
}

/** 当前生效的终端后端(UI 提示「pipe 模式体验受限」用) */
function currentBackend(): TerminalBackend {
  return loadPty() ? 'pty' : 'pipe'
}

// ---------------------------------------------------------------
// 会话管理
// ---------------------------------------------------------------

/** 用户默认 shell(POSIX:$SHELL;缺省 zsh/bash;Windows 直接用 COMSPEC) */
function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe'
  const sh = process.env.SHELL
  if (sh && existsSync(sh)) return sh
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash'
}

/** 继承进程环境并补齐终端必需变量(env 值须为 string,过滤 undefined) */
function sessionEnv(term: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.TERM = term
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  env.COLORTERM = term === 'dumb' ? '' : 'truecolor'
  return env
}

interface Session {
  info: TerminalSessionInfo
  /** 编号(1 → Local,n → Local (n);关闭释放) */
  num: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const sessions = new Map<string, Session>()
const usedNums = new Set<number>()
let idSeq = 0

/** 分配最小空闲编号(Local、Local (2)…;关闭释放后补位,与 JetBrains 行为一致) */
function allocName(): { num: number; name: string } {
  let n = 1
  while (usedNums.has(n)) n++
  usedNums.add(n)
  return { num: n, name: n === 1 ? 'Local' : `Local (${n})` }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// ---- 数据流 16ms 聚合批量下发 ----

const pendingData = new Map<string, string>()
let flushTimer: NodeJS.Timeout | null = null

function queueData(id: string, data: string): void {
  pendingData.set(id, (pendingData.get(id) ?? '') + data)
  if (flushTimer === null) {
    flushTimer = setTimeout(flushData, 16)
  }
}

function flushData(): void {
  flushTimer = null
  if (pendingData.size === 0) return
  const chunks: TerminalDataChunk[] = []
  for (const [id, data] of pendingData) chunks.push({ id, data })
  pendingData.clear()
  broadcast('terminal:data', chunks)
}

/** 会话退出:先冲刷残余输出再发退出事件,保证 renderer 顺序一致 */
function onSessionExit(id: string, exitCode: number | null): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  usedNums.delete(s.num)
  flushData()
  broadcast('terminal:exit', { id, exitCode } satisfies TerminalExitEvent)
}

// ---------------------------------------------------------------
// 会话创建(pty 优先,spawn 失败逐会话回退 pipe)
// ---------------------------------------------------------------

function createPtySession(
  id: string,
  name: string,
  num: number,
  shell: string,
  cwd: string,
  cols: number,
  rows: number
): Session | null {
  const mod = loadPty()
  if (!mod) return null
  try {
    // login shell(-l):加载用户 profile,PATH/别名与外部终端一致
    const p = mod.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: sessionEnv('xterm-256color')
    })
    p.onData((data) => queueData(id, data))
    p.onExit((ev) => onSessionExit(id, ev.exitCode ?? null))
    return {
      info: { id, name, backend: 'pty', shell, cwd, pid: p.pid },
      num,
      write: (data) => p.write(data),
      resize: (c, r) => {
        // pty resize 对非法值抛错(进程已退出等),静默容错
        try {
          p.resize(Math.max(2, c), Math.max(1, r))
        } catch {
          /* 会话已退出 */
        }
      },
      kill: () => {
        try {
          p.kill()
        } catch {
          /* 已退出 */
        }
      }
    }
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err)
    return null
  }
}

function createPipeSession(
  id: string,
  name: string,
  num: number,
  shell: string,
  cwd: string
): Session {
  // pipe 兜底:TERM=dumb 告知 shell 无终端能力(无色彩/无行编辑)
  const child: ChildProcess = spawn(shell, ['-l'], {
    cwd,
    env: sessionEnv('dumb'),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (b: Buffer) => queueData(id, b.toString('utf8')))
  child.stderr?.on('data', (b: Buffer) => queueData(id, b.toString('utf8')))
  child.on('exit', (code) => onSessionExit(id, code))
  child.on('error', (err) => {
    queueData(id, `\r\n[pixelbox] shell 启动失败: ${err.message}\r\n`)
    onSessionExit(id, null)
  })
  return {
    info: { id, name, backend: 'pipe', shell, cwd, pid: child.pid ?? -1 },
    num,
    write: (data) => {
      // pipe 模式下回车统一换行(shell 按行读取)
      child.stdin?.write(data.replace(/\r/g, '\n'))
    },
    resize: () => {
      /* pipe 模式无窗口尺寸概念 */
    },
    kill: () => {
      try {
        child.kill('SIGHUP')
        // SIGHUP 未生效则强杀(shell 忽略 HUP 的场景)
        const pid = child.pid
        if (pid !== undefined) {
          setTimeout(() => {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              /* 已退出 */
            }
          }, 1500)
        }
      } catch {
        /* 已退出 */
      }
    }
  }
}

// ---------------------------------------------------------------
// IPC 注册 / 清理
// ---------------------------------------------------------------

export function registerTerminalIpc(): void {
  // 新建会话:pty 优先,失败回退 pipe(逐会话探测,状态在返回值 backend 中)
  ipcMain.handle('terminal:create', (_e, opts?: TerminalCreateOptions): TerminalSessionInfo => {
    const shell = defaultShell()
    const cwd = opts?.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
    const cols = opts?.cols && opts.cols > 1 ? Math.floor(opts.cols) : 80
    const rows = opts?.rows && opts.rows > 0 ? Math.floor(opts.rows) : 24
    const id = `term-${++idSeq}`
    const { num, name } = allocName()
    const session =
      createPtySession(id, name, num, shell, cwd, cols, rows) ??
      createPipeSession(id, name, num, shell, cwd)
    sessions.set(id, session)
    return session.info
  })

  // 键盘输入 → shell(send 通道,不需要往返确认)
  ipcMain.on('terminal:write', (_e, id: string, data: string): void => {
    sessions.get(id)?.write(data)
  })

  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number): void => {
    sessions.get(id)?.resize(cols, rows)
  })

  // 关闭会话(杀进程;退出事件回流后从表中移除)
  ipcMain.handle('terminal:close', (_e, id: string): void => {
    sessions.get(id)?.kill()
  })

  // 重命名(renderer 重载后 terminal:list 恢复用)
  ipcMain.handle('terminal:rename', (_e, id: string, name: string): void => {
    const s = sessions.get(id)
    if (s && name.trim().length > 0) s.info.name = name.trim().slice(0, 64)
  })

  // 存活会话列表(renderer 重载恢复 tab)
  ipcMain.handle('terminal:list', (): TerminalSessionInfo[] => {
    return [...sessions.values()].map((s) => s.info)
  })

  // 当前后端探测结果(pipe 时 UI 显示「体验受限」提示)
  ipcMain.handle('terminal:backend', (): { backend: TerminalBackend; error: string } => {
    return { backend: currentBackend(), error: ptyLoadError }
  })
}

/** 应用退出/窗口关闭:杀净全部终端会话,不留孤儿进程 */
export function disposeTerminal(): void {
  for (const s of sessions.values()) {
    usedNums.delete(s.num)
    s.kill()
  }
  sessions.clear()
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingData.clear()
}
