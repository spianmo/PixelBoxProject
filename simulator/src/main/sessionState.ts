/**
 * 会话状态服务(main 进程,会话恢复阶段 2)—— 上次工作区 + 按工程的编辑器会话
 *
 * 落盘布局(IDE v3:JetBrains .idea 式「会话随工程走」):
 * - userData/pixelbox-sim/sessions/state.json   { lastWorkspaceRoot }(IDE 全局,
 *                                               null = 上次退出停在欢迎页)
 * - <工程根>/.ide/session.json                  每工程会话(WorkspaceSession 去掉 root:
 *                                               标签路径 + Monaco viewState + 激活标签;
 *                                               脏文件内容不落盘,以保存过的为准)
 * - userData/pixelbox-sim/sessions/ws-<sha1_16>.json  旧版按根哈希的会话文件(只读迁移源:
 *                                               首次发现 .ide/session.json 缺失时用一次
 *                                               并写穿到 .ide,之后不再消费)
 *
 * 数据流:renderer 在标签/激活/光标滚动变化时去抖推送 session:update(send,无往返),
 * main 内存即时更新 + 500ms 去抖落盘;退出时 flushSessionState() 同步兜底
 * (before-quit + 主窗 close 双保险)。启动时 renderer 调 session:startup 拿
 * 恢复信息(restore 开关位 + 上次工作区存在性校验 + 该工作区会话);切换工作区时
 * renderer 调 session:for-root 拿目标工程会话(内存待落盘 > .ide > 旧版迁移)。
 *
 * 写盘防呆:工程根已不存在则跳过;EROFS/权限错误记日志跳过 —— 会话恢复属尽力
 * 而为,任何写失败都不得抛回 renderer。
 *
 * session:report:renderer 恢复摘要 → 主进程终端日志(dev 冒烟的断言证据,
 * 前缀统一 [session-restore])。
 */
import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { SessionStartupInfo, SessionUpdatePayload, WorkspaceSession } from '../shared/ipc-types'
import { getSettings } from './settings'

/** 单会话标签数上限(防呆:异常大的会话文件不落盘不恢复) */
const MAX_TABS = 64

function sessionsDir(): string {
  return join(app.getPath('userData'), 'pixelbox-sim', 'sessions')
}

function stateJson(): string {
  return join(sessionsDir(), 'state.json')
}

/** 旧版:工作区根 → userData 会话文件(根路径 sha1 前 16 位;仅作一次性迁移源) */
function legacySessionFile(root: string): string {
  const hash = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 16)
  return join(sessionsDir(), `ws-${hash}.json`)
}

/** 新版:工程内会话文件 <root>/.ide/session.json(会话随工程走,脚手架 .gitignore 已排除) */
function ideSessionFile(root: string): string {
  return join(resolve(root), '.ide', 'session.json')
}

// ---- 内存态(renderer 推送即时更新;去抖落盘 + 退出同步兜底) ----

/** undefined = 本次启动 renderer 尚未推送过(不覆盖磁盘记录) */
let lastWorkspaceRoot: string | null | undefined = undefined
/** 待落盘的工作区会话(按根路径;写盘后保留,退出 flush 幂等重写) */
const pendingSessions = new Map<string, WorkspaceSession>()
let saveTimer: NodeJS.Timeout | null = null
let dirty = false

/**
 * 载荷校验/规范化(坏形状丢弃;标签数量与字段类型防呆)。
 * fallbackRoot:.ide/session.json 不落 root 字段(工程可整体移动),读取时由
 * 调用方补上归属根;session:update 载荷与旧版文件自带 root,无需传。
 */
function sanitizeSession(raw: unknown, fallbackRoot?: string): WorkspaceSession | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  const root = typeof s.root === 'string' && s.root.length > 0 ? s.root : fallbackRoot
  if (typeof root !== 'string' || root.length === 0) return null
  if (!Array.isArray(s.tabs)) return null
  const sanitizeTabs = (raw: unknown): WorkspaceSession['tabs'] => {
    const out: WorkspaceSession['tabs'] = []
    if (!Array.isArray(raw)) return out
    for (const t of raw.slice(0, MAX_TABS)) {
      if (typeof t !== 'object' || t === null) continue
      const tab = t as Record<string, unknown>
      if (typeof tab.path !== 'string' || tab.path.length === 0) continue
      out.push({ path: tab.path, viewState: tab.viewState ?? null })
    }
    return out
  }
  const tabs = sanitizeTabs(s.tabs)
  // 分屏会话(IDE v3.x):groups 1-2 组 + splitDir;坏形状整体丢弃回单组
  let groups: WorkspaceSession['groups']
  let splitDir: WorkspaceSession['splitDir']
  if (Array.isArray(s.groups) && (s.splitDir === 'row' || s.splitDir === 'col')) {
    const gs = s.groups.slice(0, 2).map((g) => {
      const grp = (typeof g === 'object' && g !== null ? g : {}) as Record<string, unknown>
      return {
        tabs: sanitizeTabs(grp.tabs),
        activePath: typeof grp.activePath === 'string' ? grp.activePath : null
      }
    })
    if (gs.length === 2 && gs[1].tabs.length > 0) {
      groups = gs
      splitDir = s.splitDir
    }
  }
  return {
    root,
    tabs,
    activePath: typeof s.activePath === 'string' ? s.activePath : null,
    ...(groups ? { groups, splitDir } : {}),
    savedAt: typeof s.savedAt === 'number' ? s.savedAt : Date.now()
  }
}

function scheduleSave(): void {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushSessionState()
  }, 500)
}

/**
 * 同步写 <root>/.ide/session.json(mkdir -p .ide;落盘形状 = WorkspaceSession 去 root)。
 * 工程根已不存在(被删除/移动)→ 跳过;EROFS/权限等写失败 → 记日志跳过。
 * 恒不抛出 —— 调用方(flush / 迁移写穿)无需再包 try。
 */
function writeIdeSession(root: string, session: WorkspaceSession): boolean {
  try {
    const abs = resolve(root)
    if (!existsSync(abs)) return false // 工作区已不存在:静默跳过
    mkdirSync(join(abs, '.ide'), { recursive: true })
    const persisted = {
      tabs: session.tabs,
      activePath: session.activePath,
      ...(session.groups ? { groups: session.groups, splitDir: session.splitDir } : {}),
      savedAt: session.savedAt
    }
    writeFileSync(ideSessionFile(abs), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
    return true
  } catch (err) {
    // 只读文件系统 / 权限不足等:尽力而为,绝不抛回 renderer
    console.log(
      `[session-restore] .ide/session.json 写入跳过(${root}):${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}

/** 同步兜底落盘(before-quit + 主窗 close 双保险;文件均为小 JSON) */
export function flushSessionState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!dirty) return
  dirty = false
  try {
    // state.json(lastWorkspaceRoot)仍是 IDE 全局状态,留在 userData
    mkdirSync(sessionsDir(), { recursive: true })
    if (lastWorkspaceRoot !== undefined) {
      writeFileSync(
        stateJson(),
        JSON.stringify({ lastWorkspaceRoot }, null, 2),
        'utf8'
      )
    }
  } catch {
    // userData 只读等:静默(会话恢复属尽力而为)
  }
  let written = 0
  for (const [root, session] of pendingSessions) {
    if (writeIdeSession(root, session)) written++
  }
  console.log(
    `[session-restore] 会话已落盘(lastWorkspace=${lastWorkspaceRoot ?? '(欢迎页)'},.ide 会话 ${written}/${pendingSessions.size} 份)`
  )
}

async function readLastWorkspaceRoot(): Promise<string | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(stateJson(), 'utf8')) as Record<string, unknown>
    return typeof raw.lastWorkspaceRoot === 'string' ? raw.lastWorkspaceRoot : null
  } catch {
    return null
  }
}

/** 内存待落盘会话查询(A→B→A 快速切换:最终推送可能尚未过 500ms 去抖落盘) */
function getPendingSession(root: string): WorkspaceSession | null {
  const abs = resolve(root)
  for (const [key, session] of pendingSessions) {
    if (resolve(key) === abs) return session
  }
  return null
}

/** 读 <root>/.ide/session.json(root 字段由归属根补上 —— 工程移动后仍可解析) */
async function readIdeSession(root: string): Promise<WorkspaceSession | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(ideSessionFile(root), 'utf8')) as unknown
    return sanitizeSession(raw, resolve(root))
  } catch {
    return null
  }
}

/** 读旧版 userData 会话文件(迁移源;防哈希碰撞/文件错位:root 必须一致) */
async function readLegacySession(root: string): Promise<WorkspaceSession | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(legacySessionFile(root), 'utf8')) as unknown
    const session = sanitizeSession(raw)
    return session && resolve(session.root) === resolve(root) ? session : null
  } catch {
    return null
  }
}

/**
 * 工作区会话读取(优先级:内存待落盘 > .ide/session.json > 旧版 userData 迁移)。
 * 旧版命中时一次性写穿到 .ide/session.json —— 此后 .ide 存在,旧文件不再被消费。
 */
async function readWorkspaceSession(root: string): Promise<WorkspaceSession | null> {
  const pending = getPendingSession(root)
  if (pending) return pending
  const ide = await readIdeSession(root)
  if (ide) return ide
  const legacy = await readLegacySession(root)
  if (legacy) {
    if (writeIdeSession(root, legacy)) {
      console.log(`[session-restore] 旧版会话已迁移到 .ide/session.json:${root}`)
    }
  }
  return legacy
}

export function registerSessionIpc(): void {
  // 启动恢复信息(renderer App 挂载时查询一次)
  ipcMain.handle('session:startup', async (): Promise<SessionStartupInfo> => {
    const settings = await getSettings()
    const restore = settings.system.restoreSession
    const recorded = await readLastWorkspaceRoot()
    const exists = recorded !== null && existsSync(recorded)
    const info: SessionStartupInfo = {
      restore,
      lastWorkspace: restore && exists ? recorded : null,
      lastWorkspaceMissing: restore && recorded !== null && !exists,
      session: restore && exists && recorded ? await readWorkspaceSession(recorded) : null
    }
    console.log(
      `[session-restore] 启动查询:restore=${restore} lastWorkspace=${recorded ?? '(无)'}` +
        `${info.lastWorkspaceMissing ? '(已不存在)' : ''} tabs=${info.session?.tabs.length ?? 0}`
    )
    return info
  })

  // 指定工作区的编辑器会话(renderer applyWorkspace 切换工作区时查询;
  // 目录无效/无会话返回 null,读失败一律吞掉 —— 打开工作区不因会话损坏而失败)
  ipcMain.handle('session:for-root', async (_e, root: string): Promise<WorkspaceSession | null> => {
    if (typeof root !== 'string' || root.length === 0 || !existsSync(root)) return null
    const session = await readWorkspaceSession(root)
    console.log(`[session-restore] 工作区会话查询:${root} tabs=${session?.tabs.length ?? 0}`)
    return session
  })

  // renderer 去抖推送(fire-and-forget;内存即时 + 500ms 去抖落盘)
  ipcMain.on('session:update', (_e, payload: SessionUpdatePayload) => {
    if (typeof payload !== 'object' || payload === null) return
    lastWorkspaceRoot = typeof payload.workspaceRoot === 'string' ? payload.workspaceRoot : null
    const session = sanitizeSession(payload.session)
    if (lastWorkspaceRoot && session && resolve(session.root) === resolve(lastWorkspaceRoot)) {
      pendingSessions.set(lastWorkspaceRoot, session)
    }
    scheduleSave()
  })

  // renderer 恢复摘要 → 主进程终端日志(冒烟断言证据)
  ipcMain.on('session:report', (_e, text: string) => {
    console.log(`[session-restore] ${String(text).slice(0, 500)}`)
  })
}
