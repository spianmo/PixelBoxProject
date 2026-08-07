/**
 * PrinterService(main 进程)—— 3D 打印机联机(OctoPrint / Moonraker)
 *
 * 打印机只吃 G-code:UX 为「导出 STL → 用户自行切片 → IDE 上传 .gcode 开打 + 进度轮询」。
 * 全部走 Node20 内置 fetch/FormData/fs.openAsBlob,零新依赖;上传 multipart 字段
 * 两家协议都必须叫 `file`。
 *
 * IPC:
 * - printer:test        连接测试(OctoPrint GET /api/version;Moonraker GET /server/info)
 * - printer:pick-gcode  选择 .gcode/.gco/.g 文件(系统对话框;取消返回 null)
 * - printer:upload      上传 G-code(可选立即开打;OctoPrint 校验 effectivePrint,
 *                       Moonraker 校验 print_started)
 * - printer:job         归一化任务状态(completion 统一 0..1;Moonraker 优先
 *                       display_status.progress,回退 virtual_sdcard.progress)
 *
 * 配置来源:SettingsService 的 printer 段(type/baseUrl/apiKey);baseUrl 为空一律
 * throw printer:notConfigured。错误码约定 `printer:<code>`:
 * unreachable(网络不可达/超时)/ badKey(401/403)/ conflict(409,打印中上传同名等)/
 * unsupportedFile(415)/ requestFailed(其余非 2xx)
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import type { PrinterJobStatus, PrinterType, PrinterUploadResult } from '../shared/ipc-types'
import { getSettings } from './settings'

/** 生效的打印机配置(baseUrl 已归一化:补协议、去尾斜杠) */
interface PrinterConfig {
  type: PrinterType
  baseUrl: string
  apiKey: string
}

async function loadConfig(): Promise<PrinterConfig> {
  const { type, baseUrl, apiKey } = (await getSettings()).printer
  const trimmed = baseUrl.trim()
  if (trimmed.length === 0) throw new Error('printer:notConfigured')
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return { type, baseUrl: withProto.replace(/\/+$/, ''), apiKey: apiKey.trim() }
}

/** 认证头(OctoPrint 必需 X-Api-Key;Moonraker 配了 key 时同样经 X-Api-Key 传递) */
function authHeaders(cfg: PrinterConfig): Record<string, string> {
  return cfg.apiKey.length > 0 ? { 'X-Api-Key': cfg.apiKey } : {}
}

/** HTTP 状态码 → printer:<code>(未映射的非 2xx 统一 requestFailed) */
function httpError(status: number): Error {
  if (status === 401 || status === 403) return new Error('printer:badKey')
  if (status === 409) return new Error('printer:conflict')
  if (status === 415) return new Error('printer:unsupportedFile')
  return new Error('printer:requestFailed')
}

/** 在飞请求(退出时统一 abort,不留挂起的上传) */
const inflight = new Set<AbortController>()

/**
 * fetch 包装:网络错误/超时 → printer:unreachable,非 2xx → httpError 映射,
 * 成功解析 JSON 返回(打印机固件偶发返回非 JSON 时同样按 requestFailed 处理)
 */
async function request<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const ac = new AbortController()
  inflight.add(ac)
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: ac.signal })
    } catch {
      throw new Error('printer:unreachable')
    }
    if (!res.ok) throw httpError(res.status)
    try {
      return (await res.json()) as T
    } catch {
      throw new Error('printer:requestFailed')
    }
  } finally {
    clearTimeout(timer)
    inflight.delete(ac)
  }
}

// ---------------------------------------------------------------
// printer:test —— 连接测试,返回版本/状态描述字符串
// ---------------------------------------------------------------

interface OctoVersionResp {
  text?: string
  server?: string
}
interface MoonrakerInfoResp {
  result?: { klippy_state?: string; moonraker_version?: string }
}

async function testConnection(): Promise<string> {
  const cfg = await loadConfig()
  if (cfg.type === 'octoprint') {
    const json = await request<OctoVersionResp>(
      `${cfg.baseUrl}/api/version`,
      { headers: authHeaders(cfg) },
      10_000
    )
    // text 形如 "OctoPrint 1.10.2";缺失时退化拼 server 版本
    return json.text ?? `OctoPrint ${json.server ?? '?'}`
  }
  const json = await request<MoonrakerInfoResp>(
    `${cfg.baseUrl}/server/info`,
    { headers: authHeaders(cfg) },
    10_000
  )
  const version = json.result?.moonraker_version ?? '?'
  const klippy = json.result?.klippy_state ?? 'unknown'
  return `Moonraker ${version} (klippy: ${klippy})`
}

// ---------------------------------------------------------------
// printer:upload —— 上传 G-code(multipart 字段必须叫 file)
// ---------------------------------------------------------------

interface OctoUploadResp {
  effectivePrint?: boolean
  files?: { local?: { name?: string } }
}
interface MoonrakerUploadResp {
  print_started?: boolean
  item?: { path?: string }
}

async function uploadGcode(path: string, startPrint: boolean): Promise<PrinterUploadResult> {
  const cfg = await loadConfig()
  const fileName = basename(path)
  // 文件系统错误(ENOENT/EACCES/EISDIR,如切片器重切后旧文件已删)统一映射
  // printer:badFile,避免裸 Node 错误绕过 `printer:<code>` 约定直达 toast
  let blob: Blob
  try {
    blob = await openAsBlob(path)
  } catch {
    throw new Error('printer:badFile')
  }
  const form = new FormData()
  form.append('file', blob, fileName)

  if (cfg.type === 'octoprint') {
    // OctoPrint:select/print 标志请求开打;真实是否开打以响应 effectivePrint 为准
    // (打印机忙/未就绪时服务器可能接受文件但不开打)
    form.append('select', startPrint ? 'true' : 'false')
    form.append('print', startPrint ? 'true' : 'false')
    const json = await request<OctoUploadResp>(
      `${cfg.baseUrl}/api/files/local`,
      { method: 'POST', headers: authHeaders(cfg), body: form },
      120_000
    )
    return {
      printStarted: json.effectivePrint === true,
      remoteName: json.files?.local?.name ?? fileName
    }
  }

  // Moonraker:root=gcodes 落到 G-code 目录;print=true 请求开打,以 print_started 为准
  form.append('root', 'gcodes')
  form.append('print', startPrint ? 'true' : 'false')
  const json = await request<MoonrakerUploadResp>(
    `${cfg.baseUrl}/server/files/upload`,
    { method: 'POST', headers: authHeaders(cfg), body: form },
    120_000
  )
  return {
    printStarted: json.print_started === true,
    remoteName: json.item?.path ?? fileName
  }
}

// ---------------------------------------------------------------
// printer:job —— 归一化任务状态(completion 0..1)
// ---------------------------------------------------------------

interface OctoJobResp {
  state?: string
  progress?: { completion?: number | null; printTimeLeft?: number | null }
  job?: { file?: { name?: string | null } }
}
interface MoonrakerQueryResp {
  result?: {
    status?: {
      print_stats?: { state?: string; filename?: string }
      virtual_sdcard?: { progress?: number }
      display_status?: { progress?: number }
    }
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

async function queryJob(): Promise<PrinterJobStatus> {
  const cfg = await loadConfig()
  if (cfg.type === 'octoprint') {
    const json = await request<OctoJobResp>(
      `${cfg.baseUrl}/api/job`,
      { headers: authHeaders(cfg) },
      10_000
    )
    // OctoPrint completion 为 0-100(空闲时 null)→ 统一 0..1;state 小写归一
    // (OctoPrint 报 "Printing"/"Operational",Moonraker 本就小写,两家对齐)
    const completion = typeof json.progress?.completion === 'number' ? json.progress.completion / 100 : 0
    const left = json.progress?.printTimeLeft
    return {
      state: (json.state ?? 'unknown').toLowerCase(),
      completion: clamp01(completion),
      ...(typeof left === 'number' ? { printTimeLeftSec: left } : {}),
      ...(json.job?.file?.name ? { fileName: json.job.file.name } : {})
    }
  }

  const json = await request<MoonrakerQueryResp>(
    `${cfg.baseUrl}/printer/objects/query?print_stats&virtual_sdcard&display_status`,
    { headers: authHeaders(cfg) },
    10_000
  )
  const status = json.result?.status
  // 优先 display_status.progress(含 M73 修正),回退 virtual_sdcard.progress
  const progress = status?.display_status?.progress ?? status?.virtual_sdcard?.progress ?? 0
  const fileName = status?.print_stats?.filename
  return {
    state: (status?.print_stats?.state ?? 'unknown').toLowerCase(),
    completion: clamp01(typeof progress === 'number' ? progress : 0),
    ...(fileName ? { fileName } : {})
  }
}

// ---------------------------------------------------------------
// IPC 注册 / 收尾
// ---------------------------------------------------------------

export function registerPrinterIpc(): void {
  // 连接测试(设置页 / 打印对话框「测试连接」)
  ipcMain.handle('printer:test', async (): Promise<string> => testConnection())

  // 选择 G-code 文件(切片器产物;取消返回 null)
  ipcMain.handle('printer:pick-gcode', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'G-code', extensions: ['gcode', 'gco', 'g'] }]
    }
    const ret = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (ret.canceled || ret.filePaths.length === 0) return null
    return ret.filePaths[0]
  })

  // 上传 G-code(startPrint 请求立即开打;printStarted 以服务器回执为准)
  ipcMain.handle(
    'printer:upload',
    async (_e, opts: { path: string; startPrint: boolean }): Promise<PrinterUploadResult> => {
      if (typeof opts?.path !== 'string' || opts.path.trim().length === 0) {
        throw new Error('printer:badFile')
      }
      return uploadGcode(opts.path, opts.startPrint === true)
    }
  )

  // 任务状态轮询(打印对话框 2.5s 间隔)
  ipcMain.handle('printer:job', async (): Promise<PrinterJobStatus> => queryJob())
}

/** 退出前兜底:中止全部在飞请求(长上传不阻塞退出) */
export function disposePrinter(): void {
  for (const ac of inflight) ac.abort()
  inflight.clear()
}
