/**
 * Git 集成服务(main 进程)—— JetBrains 式版本控制工具窗的数据层
 *
 * - resolveGit():设置 git.executablePath(非空且存在)→ PATH 中的 git → /usr/bin/git
 * - 短命令:spawn 收集 stdout(20s 超时);push/pull 走流式模式(detached 进程组、
 *   行式输出经 git:op-output 广播、取消 SIGTERM→SIGKILL),同一时刻仅一个流式操作
 * - 输出解析(porcelain v2 / log / name-status)在 shared/gitParse.ts 纯函数,
 *   可被独立 node 脚本喂真实 git 输出断言
 * - .git 目录 watcher:主 workspace watcher 忽略点目录(workspace.ts),外部 git
 *   操作(命令行 commit/checkout 等)不会有 fs-event —— 这里对 <root>/.git 的
 *   HEAD/index/refs 单独起 chokidar,去抖 300ms 广播 git:changed。
 *   重挂时机:惰性跟随 git:info(renderer 每次切工作区都会调 git:info,root 变化
 *   即重挂;无需订阅 workspace 模块)。
 * - 错误码约定 `git:<code>`(notRepo/noGit/busy/conflict/authFailed/timeout/
 *   dirtyWorktree/nothingToCommit/remoteExists/noSuchRemote/badRemoteName/
 *   badRemoteUrl/badStrategy),renderer 取消息里最后一个 git:(\w+) 匹配
 * - 原生 Git 菜单联动:onGitActivity 注册回调,git:changed 广播与工作区切换时
 *   触发(menu.ts 订阅并去抖重建;本模块不 import menu 防循环依赖)
 */
import { ipcMain, BrowserWindow } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { getSettingsSync } from './settings'
import { getWatchedRoot } from './workspace'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitDetectResult,
  GitFileChange,
  GitInfo,
  GitOpOutput,
  GitRemoteInfo,
  GitResolveStrategy,
  GitStatusResult
} from '../shared/ipc-types'
import {
  parseGitLog,
  parseNameStatusZ,
  parseRemotesV,
  parseStatusPorcelainV2,
  type ParsedStatusEntry
} from '../shared/gitParse'

/** 短命令超时(status/log 等本地操作,20s 足够大仓库) */
const COMMAND_TIMEOUT_MS = 20_000
/** 历史视图单页提交数 */
const LOG_LIMIT = 200

/**
 * 解析 git 可执行文件:设置覆盖(非空且存在)→ PATH → /usr/bin/git。
 * 全部落空返回 null(renderer 提示到设置页配置);阶梯与 clangd.ts resolveClangd 一致。
 */
export function resolveGit(): string | null {
  const configured = getSettingsSync().git.executablePath
  if (configured && existsSync(configured)) return configured
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], {
      encoding: 'utf8'
    })
    const found = which.status === 0 ? which.stdout.split('\n')[0]?.trim() : ''
    if (found && existsSync(found)) return found
  } catch {
    // which 不可用则继续走固定回退
  }
  return existsSync('/usr/bin/git') ? '/usr/bin/git' : null
}

/** root 校验:必须与当前 workspace watcher 的根一致(路径牢笼,防越权仓库操作) */
function assertRoot(root: unknown): string {
  if (typeof root !== 'string' || root.trim().length === 0) throw new Error('git:badRoot')
  const abs = resolve(root)
  const watched = getWatchedRoot()
  if (watched && resolve(watched) !== abs) throw new Error('git:badRoot')
  return abs
}

/** 相对路径列表校验:全部位于 root 内,返回绝对→相对转换后的相对路径('/'') */
function relPathsInRoot(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('git:badPaths')
  return paths.map((p) => {
    if (typeof p !== 'string') throw new Error('git:badPaths')
    const abs = resolve(p)
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error('git:badPaths')
    return abs === root ? '.' : abs.slice(root.length + 1).split(sep).join('/')
  })
}

/** 短命令执行结果 */
interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 短命令:spawn 收集 stdout/stderr,20s 超时杀进程并报 git:timeout */
function runGit(root: string, args: string[]): Promise<GitResult> {
  const gitPath = resolveGit()
  if (!gitPath) return Promise.reject(new Error('git:noGit'))
  return new Promise<GitResult>((resolvePromise, reject) => {
    const proc = spawn(gitPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      try {
        proc.kill('SIGKILL')
      } catch {
        // 已退出
      }
      reject(new Error('git:timeout'))
    }, COMMAND_TIMEOUT_MS)
    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c))
    proc.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`git:noGit ${e.message}`))
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      })
    })
  })
}

/** 短命令 + 失败时按 stderr 归类错误码抛出 */
async function runGitOk(root: string, args: string[]): Promise<string> {
  const r = await runGit(root, args)
  if (r.code !== 0) throw new Error(classifyError(r.stderr) + ' ' + r.stderr.slice(0, 400))
  return r.stdout
}

/** stderr → git:<code>(renderer 侧 i18n) */
function classifyError(stderr: string): string {
  const s = stderr.toLowerCase()
  if (s.includes('not a git repository')) return 'git:notRepo'
  if (s.includes('authentication failed') || s.includes('permission denied') || s.includes('could not read username')) {
    return 'git:authFailed'
  }
  if (s.includes('conflict')) return 'git:conflict'
  if (
    s.includes('would be overwritten') ||
    s.includes('commit your changes or stash them') ||
    s.includes('cannot rebase: you have unstaged changes')
  ) {
    return 'git:dirtyWorktree'
  }
  if (s.includes('nothing to commit')) return 'git:nothingToCommit'
  if (s.includes('already exists')) return 'git:remoteExists'
  if (s.includes('no such remote')) return 'git:noSuchRemote'
  return 'git:failed'
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------
// git 活动回调(menu.ts 订阅重建原生 Git 菜单;git.ts 不 import menu 防循环依赖)
// ---------------------------------------------------------------

const activityListeners: Array<() => void> = []

/** 注册 git 活动回调:git:changed 广播 / 工作区(root)切换时触发(menu.ts 用) */
export function onGitActivity(cb: () => void): void {
  activityListeners.push(cb)
}

function notifyActivity(): void {
  for (const cb of activityListeners) cb()
}

/** git:changed 广播 + 顺带通知菜单重建(所有主动广播点统一走这里) */
function broadcastGitChanged(root: string): void {
  broadcast('git:changed', { root })
  notifyActivity()
}

// ---------------------------------------------------------------
// .git 目录 watcher(外部 git 操作 → git:changed 去抖广播)
// ---------------------------------------------------------------

let gitWatcher: FSWatcher | null = null
let gitWatchedRoot: string | null = null
let changedTimer: NodeJS.Timeout | null = null

/**
 * (重)挂 .git watcher:监听 HEAD / index / refs(分支、提交、切分支、fetch 全覆盖)。
 * 由 git:info 惰性调用(renderer 打开/切换工作区必查 git:info,root 变化即重挂;
 * 非 git 仓库时卸载 —— git init 后下一次 git:info 会重新挂上)。
 */
function ensureGitWatcher(root: string, isRepo: boolean): void {
  if (gitWatchedRoot === root && (gitWatcher !== null) === isRepo) return
  void gitWatcher?.close()
  gitWatcher = null
  gitWatchedRoot = root
  notifyActivity() // 工作区/仓库态变化:通知原生 Git 菜单重建(去抖在 menu.ts)
  if (!isRepo) return
  const gitDir = join(root, '.git')
  gitWatcher = chokidar.watch(
    [join(gitDir, 'HEAD'), join(gitDir, 'index'), join(gitDir, 'refs')],
    { ignoreInitial: true, persistent: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 50 } }
  )
  const notify = (): void => {
    // 300ms 去抖:一次 commit 会连续触发 index/HEAD/refs 多个事件
    if (changedTimer) clearTimeout(changedTimer)
    changedTimer = setTimeout(() => {
      changedTimer = null
      broadcastGitChanged(root)
    }, 300)
  }
  gitWatcher.on('add', notify)
  gitWatcher.on('change', notify)
  gitWatcher.on('unlink', notify)
  gitWatcher.on('addDir', notify)
  gitWatcher.on('unlinkDir', notify)
}

// ---------------------------------------------------------------
// push / pull 流式操作(单实例;detached 进程组,取消 SIGTERM→SIGKILL)
// ---------------------------------------------------------------

interface ActiveOp {
  op: 'push' | 'pull'
  proc: ChildProcess
}

let activeOp: ActiveOp | null = null

/** 把子进程输出块切分为完整行(\r 进度行也切开),尾部残行留在缓冲 */
function splitChunk(buf: { rest: string }, chunk: string): string[] {
  buf.rest += chunk
  const parts = buf.rest.split(/\r\n|\n|\r/)
  buf.rest = parts.pop() ?? ''
  return parts.filter((s) => s.trim().length > 0)
}

/**
 * 流式执行 push/pull:行式输出经 git:op-output 广播,结束追加 done 记录。
 * 返回 Promise 在进程退出后 resolve(exitCode ≠ 0 时按 stderr 归类抛错)。
 */
function runStreaming(root: string, op: 'push' | 'pull', args: string[]): Promise<void> {
  const gitPath = resolveGit()
  if (!gitPath) return Promise.reject(new Error('git:noGit'))
  if (activeOp) return Promise.reject(new Error('git:busy'))
  return new Promise<void>((resolvePromise, reject) => {
    // detached:自建进程组,取消时 kill(-pid) 连 ssh/credential helper 一起终止;
    // GIT_TERMINAL_PROMPT=0:无凭据时立即失败(authFailed)而非挂死等待输入
    const proc = spawn(gitPath, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    activeOp = { op, proc }
    const emit = (text: string): void => {
      broadcast('git:op-output', { kind: 'line', op, text } satisfies GitOpOutput)
    }
    const stdoutBuf = { rest: '' }
    const stderrBuf = { rest: '' }
    // stdout 也参与错误归类:pull 的合并冲突信息(CONFLICT…)走 stdout 而非 stderr
    const errAll: string[] = []
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (c: string) => {
      const lines = splitChunk(stdoutBuf, c)
      errAll.push(...lines)
      lines.forEach(emit)
    })
    proc.stderr?.on('data', (c: string) => {
      // git 把进度(Counting objects…)也写 stderr,原样透传;整体留存供错误归类
      const lines = splitChunk(stderrBuf, c)
      errAll.push(...lines)
      lines.forEach(emit)
    })
    proc.on('error', (e) => {
      if (activeOp?.proc !== proc) return
      activeOp = null
      broadcast('git:op-output', { kind: 'done', op, text: '', exitCode: null } satisfies GitOpOutput)
      reject(new Error('git:failed ' + e.message))
    })
    proc.on('close', (code) => {
      if (activeOp?.proc !== proc) return
      activeOp = null
      // 冲刷残行
      for (const s of [stdoutBuf.rest, stderrBuf.rest]) {
        if (s.trim().length > 0) {
          errAll.push(s)
          emit(s)
        }
      }
      broadcast('git:op-output', { kind: 'done', op, text: '', exitCode: code } satisfies GitOpOutput)
      if (code === 0) resolvePromise()
      else reject(new Error(classifyError(errAll.join('\n'))))
    })
  })
}

/** 取消进行中的 push/pull:SIGTERM 进程组,3s 未退出补 SIGKILL */
function cancelOp(): void {
  const op = activeOp
  if (!op || op.proc.pid === undefined) return
  const pid = op.proc.pid
  const killGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig)
    } catch {
      // 进程已退出
    }
  }
  killGroup('SIGTERM')
  setTimeout(() => {
    if (activeOp?.proc === op.proc) killGroup('SIGKILL')
  }, 3000)
}

// ---------------------------------------------------------------
// 查询拼装
// ---------------------------------------------------------------

/** 相对条目 → GitFileChange(拼绝对路径) */
function toChanges(root: string, entries: ParsedStatusEntry[]): GitFileChange[] {
  return entries.map((e) => ({
    path: join(root, ...e.relPath.split('/')),
    relPath: e.relPath,
    status: e.status,
    ...(e.origRelPath !== undefined ? { origRelPath: e.origRelPath } : {})
  }))
}

async function queryInfo(root: string): Promise<GitInfo> {
  const gitFound = resolveGit() !== null
  const isRepo = existsSync(join(root, '.git'))
  ensureGitWatcher(root, isRepo && gitFound)
  if (!gitFound || !isRepo) {
    return { isRepo, branch: null, upstream: null, ahead: 0, behind: 0, gitFound }
  }
  // 头信息足矣:跳过未跟踪扫描(大仓库提速)
  const r = await runGit(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no'])
  if (r.code !== 0) throw new Error(classifyError(r.stderr))
  const st = parseStatusPorcelainV2(r.stdout)
  let branch = st.branch.head
  if (branch === '(detached)' && st.branch.oid) branch = st.branch.oid.slice(0, 7)
  return {
    isRepo: true,
    branch,
    upstream: st.branch.upstream,
    ahead: st.branch.ahead,
    behind: st.branch.behind,
    gitFound
  }
}

async function queryStatus(root: string): Promise<GitStatusResult> {
  // -uall:未跟踪目录展开为逐文件条目(每行都可 暂存/丢弃/开 diff);
  // --ignored=matching:补 '!' 条目(gitignore 命中,FileTree 橄榄色;目录整条不展开)
  const out = await runGitOk(root, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--ignored=matching'
  ])
  const st = parseStatusPorcelainV2(out)
  return {
    staged: toChanges(root, st.staged),
    unstaged: toChanges(root, st.unstaged),
    untracked: toChanges(root, st.untracked),
    conflicted: toChanges(root, st.conflicted),
    ignored: toChanges(root, st.ignored)
  }
}

/** 本地分支列表(当前分支标记;menu.ts 原生菜单与 git:branches IPC 共用) */
export async function queryBranches(root: string): Promise<GitBranchInfo[]> {
  const out = await runGitOk(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%00%(HEAD)'])
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [name, head] = l.split('\0')
      return { name, current: head === '*' }
    })
}

// ---------------------------------------------------------------
// Remote 参数校验(防选项注入:name 白名单、url 禁止 '-' 开头)
// ---------------------------------------------------------------

/** remote 名:字母数字 _.- 白名单且不以 '-' 开头 */
function assertRemoteName(name: unknown): string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 250 ||
    name.startsWith('-') ||
    !/^[A-Za-z0-9_.-]+$/.test(name)
  ) {
    throw new Error('git:badRemoteName')
  }
  return name
}

/** remote URL:去空白后非空且不以 '-' 开头(防被 git 解析为选项) */
function assertRemoteUrl(url: unknown): string {
  if (typeof url !== 'string') throw new Error('git:badRemoteUrl')
  const u = url.trim()
  if (u.length === 0 || u.startsWith('-')) throw new Error('git:badRemoteUrl')
  return u
}

// ---------------------------------------------------------------
// IPC 注册 / 收尾
// ---------------------------------------------------------------

export function registerGitIpc(): void {
  // git 可执行检测(设置页实时回显;可传草稿覆盖路径做不落盘试探)
  ipcMain.handle('git:detect', async (_e, overridePath?: string): Promise<GitDetectResult> => {
    let gitPath: string | null
    if (typeof overridePath === 'string' && overridePath.trim().length > 0) {
      gitPath = existsSync(overridePath.trim()) ? overridePath.trim() : null
    } else {
      gitPath = resolveGit()
    }
    if (!gitPath) return { found: false, path: '', version: null }
    try {
      const v = spawnSync(gitPath, ['--version'], { encoding: 'utf8', timeout: 5000 })
      const m = /git version ([\d.]+)/.exec(v.stdout ?? '')
      return { found: v.status === 0, path: gitPath, version: m ? m[1] : null }
    } catch {
      return { found: false, path: gitPath, version: null }
    }
  })

  // 仓库概览:是否 git 仓库 / 当前分支 / ahead-behind / upstream(顺带惰性重挂 .git watcher)
  ipcMain.handle('git:info', async (_e, root: string): Promise<GitInfo> => {
    return queryInfo(assertRoot(root))
  })

  // 初始化仓库(可选首次 add -A;不自动提交,首个 commit 由用户在面板完成)
  ipcMain.handle('git:init', async (_e, root: string, addAll?: boolean): Promise<void> => {
    const abs = assertRoot(root)
    await runGitOk(abs, ['init'])
    if (addAll === true) await runGitOk(abs, ['add', '-A'])
    ensureGitWatcher(abs, false) // 强制下一次 git:info 重挂(.git 刚出现)
    broadcastGitChanged(abs)
  })

  // 变更列表(porcelain v2 解析为 staged/unstaged/untracked/conflicted 四组)
  ipcMain.handle('git:status', async (_e, root: string): Promise<GitStatusResult> => {
    return queryStatus(assertRoot(root))
  })

  // 暂存(add)/ 取消暂存(reset)指定文件
  ipcMain.handle('git:stage', async (_e, root: string, paths: string[]): Promise<void> => {
    const abs = assertRoot(root)
    await runGitOk(abs, ['add', '--', ...relPathsInRoot(abs, paths)])
  })
  ipcMain.handle('git:unstage', async (_e, root: string, paths: string[]): Promise<void> => {
    const abs = assertRoot(root)
    await runGitOk(abs, ['reset', 'HEAD', '--', ...relPathsInRoot(abs, paths)])
  })

  // 丢弃工作区修改(已跟踪 checkout --;未跟踪 clean 单文件)。
  // 破坏性操作:renderer 侧 ConfirmModal 确认后才允许调用
  ipcMain.handle(
    'git:discard',
    async (_e, root: string, paths: string[], untracked?: boolean): Promise<void> => {
      const abs = assertRoot(root)
      const rels = relPathsInRoot(abs, paths)
      if (untracked === true) await runGitOk(abs, ['clean', '-f', '--', ...rels])
      else await runGitOk(abs, ['checkout', '--', ...rels])
    }
  )

  // 提交暂存区(空暂存区报 git:nothingToCommit,不空跑 git)
  ipcMain.handle('git:commit', async (_e, root: string, message: string): Promise<void> => {
    const abs = assertRoot(root)
    if (typeof message !== 'string' || message.trim().length === 0) throw new Error('git:emptyMessage')
    const staged = await runGitOk(abs, ['diff', '--cached', '--name-only', '-z'])
    if (staged.replaceAll('\0', '').length === 0) throw new Error('git:nothingToCommit')
    await runGitOk(abs, ['commit', '-m', message])
  })

  // 推送(流式输出;无 upstream 时自动 -u origin <branch>)
  ipcMain.handle('git:push', async (_e, root: string): Promise<void> => {
    const abs = assertRoot(root)
    const info = await queryInfo(abs)
    if (!info.isRepo) throw new Error('git:notRepo')
    const args =
      info.upstream === null && info.branch
        ? ['push', '-u', 'origin', info.branch]
        : ['push']
    await runStreaming(abs, 'push', args)
  })

  // 拉取(流式输出;合并冲突时 runStreaming 按 stderr 报 git:conflict)
  ipcMain.handle('git:pull', async (_e, root: string): Promise<void> => {
    await runStreaming(assertRoot(root), 'pull', ['pull'])
  })

  // 取消进行中的 push/pull
  ipcMain.handle('git:cancel-op', (): void => cancelOp())

  // 提交历史(NUL 分隔字段;parents 供 renderer 画车道图,--graph 不用)
  ipcMain.handle('git:log', async (_e, root: string): Promise<GitCommitInfo[]> => {
    const abs = assertRoot(root)
    const r = await runGit(abs, [
      'log',
      '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%P',
      '-n',
      String(LOG_LIMIT)
    ])
    // 空仓库(无任何提交)git log 报错:返回空列表而非抛错
    if (r.code !== 0) {
      if (/does not have any commits yet|bad default revision/i.test(r.stderr)) return []
      throw new Error(classifyError(r.stderr))
    }
    return parseGitLog(r.stdout)
  })

  // 某 commit 的变更文件列表(相对其第一父;根提交对空树)。
  // 走 log 而非 diff-tree:diff-tree 对合并提交默认零输出(历史视图点开 merge
  // 显示零文件),而 diff-tree 的 -m 即便加 --first-parent 也会输出两个父的
  // diff(实测);log -1 -m --first-parent 才是精确的「仅相对第一父」,
  // 配 log.showRoot=true 覆盖根提交
  ipcMain.handle('git:commit-files', async (_e, root: string, hash: string): Promise<GitFileChange[]> => {
    const abs = assertRoot(root)
    if (typeof hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('git:badRev')
    const out = await runGitOk(abs, [
      '-c',
      'log.showRoot=true',
      'log',
      '-1',
      '-m',
      '--first-parent',
      '--name-status',
      '-z',
      '--format=',
      '-M',
      hash
    ])
    return toChanges(abs, parseNameStatusZ(out))
  })

  // 某版本的文件内容(diff 页签左/右侧数据;该版本不存在此文件 → 空串,新增文件 diff 用)
  ipcMain.handle('git:show-file', async (_e, root: string, rev: string, relPath: string): Promise<string> => {
    const abs = assertRoot(root)
    // 白名单字符 + 禁止 '-' 开头(防被 git 解析为选项)
    if (typeof rev !== 'string' || !/^[0-9a-fA-F~^:/@{}.\w-]+$/.test(rev) || rev.startsWith('-')) {
      throw new Error('git:badRev')
    }
    if (typeof relPath !== 'string' || relPath.includes('..')) throw new Error('git:badPaths')
    const r = await runGit(abs, ['show', `${rev}:${relPath}`])
    return r.code === 0 ? r.stdout : ''
  })

  // 本地分支列表(当前分支标记)
  ipcMain.handle('git:branches', async (_e, root: string): Promise<GitBranchInfo[]> => {
    return queryBranches(assertRoot(root))
  })

  // 冲突解决:ours/theirs 先 checkout 对应侧,再 add 标记已解决;mark 仅 add。
  // 路径牢笼与 git:stage 一致(relPathsInRoot)
  ipcMain.handle(
    'git:resolve',
    async (_e, root: string, paths: string[], strategy: GitResolveStrategy): Promise<void> => {
      const abs = assertRoot(root)
      if (strategy !== 'ours' && strategy !== 'theirs' && strategy !== 'mark') {
        throw new Error('git:badStrategy')
      }
      const rels = relPathsInRoot(abs, paths)
      if (strategy !== 'mark') {
        await runGitOk(abs, ['checkout', strategy === 'ours' ? '--ours' : '--theirs', '--', ...rels])
      }
      await runGitOk(abs, ['add', '--', ...rels])
      broadcastGitChanged(abs)
    }
  )

  // Remote 列表(`git remote -v` 解析;fetch/push URL 分列)
  ipcMain.handle('git:remotes', async (_e, root: string): Promise<GitRemoteInfo[]> => {
    const abs = assertRoot(root)
    return parseRemotesV(await runGitOk(abs, ['remote', '-v']))
  })

  // Remote 增/删/改 URL(.git/config 不在 watcher 监听范围,须主动广播 git:changed)
  ipcMain.handle('git:remote-add', async (_e, root: string, name: string, url: string): Promise<void> => {
    const abs = assertRoot(root)
    await runGitOk(abs, ['remote', 'add', assertRemoteName(name), assertRemoteUrl(url)])
    broadcastGitChanged(abs)
  })
  ipcMain.handle('git:remote-remove', async (_e, root: string, name: string): Promise<void> => {
    const abs = assertRoot(root)
    await runGitOk(abs, ['remote', 'remove', assertRemoteName(name)])
    broadcastGitChanged(abs)
  })
  ipcMain.handle(
    'git:remote-set-url',
    async (_e, root: string, name: string, url: string): Promise<void> => {
      const abs = assertRoot(root)
      await runGitOk(abs, ['remote', 'set-url', assertRemoteName(name), assertRemoteUrl(url)])
      broadcastGitChanged(abs)
    }
  )

  // 切分支/新建分支(create=true 时 -b;脏工作区冲突由 classifyError 报 git:dirtyWorktree)
  ipcMain.handle(
    'git:checkout',
    async (_e, root: string, branch: string, create?: boolean): Promise<void> => {
      const abs = assertRoot(root)
      // 校验按 git check-ref-format 规则子集:禁选项注入('-' 开头)/控制字符/
      // ref 语法禁字符/..;不做 ASCII 白名单 —— 'fix#123'、'c++-port'、中文分支
      // 都是 git 合法名,白名单会导致分支菜单里能看见却切不过去
      /* eslint-disable-next-line no-control-regex */
      const bad =
        typeof branch !== 'string' ||
        branch.length === 0 ||
        branch.length > 250 ||
        branch.startsWith('-') ||
        branch.includes('..') ||
        /[\x00-\x1f\x7f ~^:?*[\\]/.test(branch) ||
        branch.endsWith('/') ||
        branch.endsWith('.') ||
        branch.endsWith('.lock')
      if (bad) throw new Error('git:badRev')
      // 尾随 '--':向 git 声明分支名后无路径参数(名字与文件同名时消歧)
      await runGitOk(abs, create === true ? ['checkout', '-b', branch, '--'] : ['checkout', branch, '--'])
      broadcastGitChanged(abs)
    }
  )
}

/** 退出前收尾:杀流式操作进程组 + 关 .git watcher */
export function disposeGit(): void {
  const pid = activeOp?.proc.pid
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
  activeOp = null
  if (changedTimer) {
    clearTimeout(changedTimer)
    changedTimer = null
  }
  void gitWatcher?.close()
  gitWatcher = null
  gitWatchedRoot = null
}
