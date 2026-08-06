/**
 * 会话状态服务(main 进程,会话恢复阶段 2)—— 上次工作区 + 按工作区的编辑器会话
 *
 * 落盘布局(userData/pixelbox-sim/sessions/):
 * - state.json           { lastWorkspaceRoot }(null = 上次退出停在欢迎页)
 * - ws-<sha1_16>.json    WorkspaceSession(标签路径 + Monaco viewState + 激活标签,
 *                        按工作区根哈希分文件;脏文件内容不落盘,以保存过的为准)
 *
 * 数据流:renderer 在标签/激活/光标滚动变化时去抖推送 session:update(send,无往返),
 * main 内存即时更新 + 500ms 去抖落盘;退出时 flushSessionState() 同步兜底
 * (before-quit + 主窗 close 双保险)。启动时 renderer 调 session:startup 拿
 * 恢复信息(restore 开关位 + 上次工作区存在性校验 + 该工作区会话)。
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

/** 工作区根 → 会话文件(根路径 sha1 前 16 位,避免路径字符与长度问题) */
function sessionFile(root: string): string {
  const hash = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 16)
  return join(sessionsDir(), `ws-${hash}.json`)
}

// ---- 内存态(renderer 推送即时更新;去抖落盘 + 退出同步兜底) ----

/** undefined = 本次启动 renderer 尚未推送过(不覆盖磁盘记录) */
let lastWorkspaceRoot: string | null | undefined = undefined
/** 待落盘的工作区会话(按根路径;写盘后保留,退出 flush 幂等重写) */
const pendingSessions = new Map<string, WorkspaceSession>()
let saveTimer: NodeJS.Timeout | null = null
let dirty = false

/** 载荷校验/规范化(坏形状丢弃;标签数量与字段类型防呆) */
function sanitizeSession(raw: unknown): WorkspaceSession | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  if (typeof s.root !== 'string' || s.root.length === 0) return null
  if (!Array.isArray(s.tabs)) return null
  const tabs: WorkspaceSession['tabs'] = []
  for (const t of s.tabs.slice(0, MAX_TABS)) {
    if (typeof t !== 'object' || t === null) continue
    const tab = t as Record<string, unknown>
    if (typeof tab.path !== 'string' || tab.path.length === 0) continue
    tabs.push({ path: tab.path, viewState: tab.viewState ?? null })
  }
  return {
    root: s.root,
    tabs,
    activePath: typeof s.activePath === 'string' ? s.activePath : null,
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

/** 同步兜底落盘(before-quit + 主窗 close 双保险;文件均为小 JSON) */
export function flushSessionState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!dirty) return
  dirty = false
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    if (lastWorkspaceRoot !== undefined) {
      writeFileSync(
        stateJson(),
        JSON.stringify({ lastWorkspaceRoot }, null, 2),
        'utf8'
      )
    }
    for (const [root, session] of pendingSessions) {
      writeFileSync(sessionFile(root), JSON.stringify(session, null, 2), 'utf8')
    }
    console.log(
      `[session-restore] 会话已落盘(lastWorkspace=${lastWorkspaceRoot ?? '(欢迎页)'},会话文件 ${pendingSessions.size} 份)`
    )
  } catch {
    // 只读文件系统等:静默(会话恢复属尽力而为)
  }
}

async function readLastWorkspaceRoot(): Promise<string | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(stateJson(), 'utf8')) as Record<string, unknown>
    return typeof raw.lastWorkspaceRoot === 'string' ? raw.lastWorkspaceRoot : null
  } catch {
    return null
  }
}

async function readWorkspaceSession(root: string): Promise<WorkspaceSession | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(sessionFile(root), 'utf8')) as unknown
    const session = sanitizeSession(raw)
    // 防哈希碰撞/文件错位:root 必须一致
    return session && resolve(session.root) === resolve(root) ? session : null
  } catch {
    return null
  }
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
