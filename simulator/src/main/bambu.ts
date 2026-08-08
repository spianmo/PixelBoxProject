/**
 * Bambu Lab(拓竹)LAN 模式驱动(main 进程)—— printer.ts 的 bambu 分支
 *
 * 协议(社区实证,OrcaSlicer / Home Assistant 集成同款):
 * - 控制/状态:MQTT over TLS 8883,用户名恒 'bblp',密码 = 打印机「LAN 访问码」,
 *   自签证书(rejectUnauthorized:false);订阅 device/<serial>/report,
 *   指令发 device/<serial>/request(pushall 拉全量状态)
 * - 传文件:FTPS 隐式 TLS 990(同一凭据),落 SD 卡根目录
 * - 开打:.3mf / .gcode.3mf → project_file(url=file:///sdcard/<name>,
 *   param=Metadata/plate_1.gcode);裸 .gcode → gcode_file(仅老固件;
 *   新固件已移除,失败请用 Bambu Studio/OrcaSlicer 导出 .gcode.3mf)
 * - 进度:report.print 的 mc_percent / mc_remaining_time(分钟)/ gcode_state
 *   (IDLE/PREPARE/RUNNING/PAUSE/FINISH/FAILED)/ subtask_name
 *
 * 连接策略:MQTT 客户端按 host|serial|访问码 缓存复用(打印对话框 2.5s 轮询
 * 不重复握手),60s 空闲自动断开;report 增量合并进 lastPrint(X1 系推 diff,
 * P1/A1 周期全量,pushall 强制全量)。错误码沿用 printer:<code> 约定:
 * badKey = 访问码错(MQTT 鉴权拒绝/FTPS 530),unreachable = 连不上,
 * 其余 requestFailed。
 */
import { connectAsync, type MqttClient } from 'mqtt'
import { Client as FtpClient } from 'basic-ftp'
import { basename } from 'node:path'
import type { PrinterJobStatus, PrinterUploadResult } from '../shared/ipc-types'

export interface BambuConfig {
  /** 打印机局域网 IP/主机名(不带协议) */
  host: string
  /** 机身序列号(设备信息页可查,MQTT 主题路径用) */
  serial: string
  /** LAN 访问码(打印机屏幕 网络设置 页) */
  accessCode: string
}

/** report.print 段 → 归一化任务状态(纯函数,node 单测覆盖) */
export function bambuReportToJob(print: Record<string, unknown> | null): PrinterJobStatus {
  const pct = typeof print?.mc_percent === 'number' ? print.mc_percent : 0
  const leftMin = typeof print?.mc_remaining_time === 'number' ? print.mc_remaining_time : null
  const state =
    typeof print?.gcode_state === 'string' && print.gcode_state.length > 0
      ? print.gcode_state.toLowerCase()
      : 'unknown'
  const file =
    typeof print?.subtask_name === 'string' && print.subtask_name.length > 0
      ? print.subtask_name
      : undefined
  return {
    state,
    completion: Math.min(1, Math.max(0, pct / 100)),
    ...(leftMin !== null ? { printTimeLeftSec: leftMin * 60 } : {}),
    ...(file ? { fileName: file } : {})
  }
}

/** MQTT 鉴权失败的错误特征(mqtt.js CONNACK code 4/5 文案) */
function classifyMqttError(err: unknown): Error {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  if (msg.includes('not authorized') || msg.includes('bad user name or password')) {
    return new Error('printer:badKey')
  }
  return new Error('printer:unreachable')
}

interface CachedClient {
  key: string
  client: MqttClient
  /** report.print 增量合并(diff 推送逐字段并入) */
  lastPrint: Record<string, unknown> | null
  /** 最近一次 report 到达时刻(等新鲜数据用) */
  lastAt: number
  idleTimer: NodeJS.Timeout | null
}

let cached: CachedClient | null = null

/** 空闲断开(打印对话框关掉后不留常驻连接) */
const IDLE_DISCONNECT_MS = 60_000
/** pushall 后等 report 的时限 */
const REPORT_TIMEOUT_MS = 8_000

function touchIdle(entry: CachedClient): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => {
    if (cached === entry) {
      cached = null
      entry.client.end(true)
    }
  }, IDLE_DISCONNECT_MS)
}

async function getClient(cfg: BambuConfig): Promise<CachedClient> {
  const key = `${cfg.host}|${cfg.serial}|${cfg.accessCode}`
  if (cached?.key === key && cached.client.connected) {
    touchIdle(cached)
    return cached
  }
  disposeBambu()
  let client: MqttClient
  try {
    client = await connectAsync(`mqtts://${cfg.host}:8883`, {
      username: 'bblp',
      password: cfg.accessCode,
      rejectUnauthorized: false, // 打印机自签证书
      connectTimeout: 8_000,
      reconnectPeriod: 0 // 不自动重连:失败即回执错误,下次调用重建
    })
  } catch (err) {
    throw classifyMqttError(err)
  }
  const entry: CachedClient = { key, client, lastPrint: null, lastAt: 0, idleTimer: null }
  client.on('message', (_topic, payload) => {
    try {
      const j = JSON.parse(payload.toString()) as { print?: Record<string, unknown> }
      if (j.print && typeof j.print === 'object') {
        entry.lastPrint = { ...(entry.lastPrint ?? {}), ...j.print }
        entry.lastAt = Date.now()
      }
    } catch {
      // 非 JSON 帧(不该出现):忽略
    }
  })
  client.on('error', () => {
    // 连接级错误:废弃缓存,下次调用重建
    if (cached === entry) disposeBambu()
  })
  try {
    await client.subscribeAsync(`device/${cfg.serial}/report`)
  } catch {
    client.end(true)
    throw new Error('printer:requestFailed')
  }
  cached = entry
  touchIdle(entry)
  return entry
}

/** 发 pushall 并等一帧比调用时刻新的 report(超时回退最近已知状态) */
async function requestReport(cfg: BambuConfig): Promise<Record<string, unknown> | null> {
  const entry = await getClient(cfg)
  const since = Date.now()
  entry.client.publish(
    `device/${cfg.serial}/request`,
    JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } })
  )
  const deadline = since + REPORT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (entry.lastAt >= since) return entry.lastPrint
    await new Promise((r) => setTimeout(r, 150))
  }
  return entry.lastPrint // 超时:退回最近已知(首连即超时则为 null)
}

// ---------------------------------------------------------------
// printer.ts 消费面:test / upload / job
// ---------------------------------------------------------------

export async function bambuTest(cfg: BambuConfig): Promise<string> {
  const print = await requestReport(cfg)
  if (print === null) throw new Error('printer:requestFailed')
  const job = bambuReportToJob(print)
  return `Bambu Lab LAN (${cfg.serial}) · ${job.state}`
}

export async function bambuUpload(
  cfg: BambuConfig,
  path: string,
  startPrint: boolean
): Promise<PrinterUploadResult> {
  const fileName = basename(path)
  // FTPS 隐式 TLS 上传到 SD 卡根目录
  const ftp = new FtpClient(30_000)
  try {
    await ftp.access({
      host: cfg.host,
      port: 990,
      user: 'bblp',
      password: cfg.accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false }
    })
    await ftp.uploadFrom(path, `/${fileName}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/530|log ?in/i.test(msg)) throw new Error('printer:badKey')
    if (/ENOENT|EACCES|EISDIR/.test(msg)) throw new Error('printer:badFile')
    throw new Error('printer:unreachable')
  } finally {
    ftp.close()
  }
  if (!startPrint) return { printStarted: false, remoteName: fileName }

  // 开打指令:.3mf/.gcode.3mf 走 project_file;裸 .gcode 走 gcode_file(老固件)
  const entry = await getClient(cfg)
  const seq = String(Date.now())
  const payload = /\.3mf$/i.test(fileName)
    ? {
        print: {
          sequence_id: seq,
          command: 'project_file',
          url: `file:///sdcard/${fileName}`,
          param: 'Metadata/plate_1.gcode',
          subtask_name: fileName,
          use_ams: false,
          timelapse: false,
          bed_leveling: true,
          flow_cali: false,
          vibration_cali: false,
          layer_inspect: false
        }
      }
    : { print: { sequence_id: seq, command: 'gcode_file', param: `/sdcard/${fileName}` } }
  entry.client.publish(`device/${cfg.serial}/request`, JSON.stringify(payload))

  // 无同步回执:短轮询 report,gcode_state 进入 PREPARE/RUNNING/SLICING 即视为已开打
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    const state = bambuReportToJob(entry.lastPrint).state
    if (state === 'prepare' || state === 'running' || state === 'slicing') {
      return { printStarted: true, remoteName: fileName }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return { printStarted: false, remoteName: fileName }
}

export async function bambuJob(cfg: BambuConfig): Promise<PrinterJobStatus> {
  const print = await requestReport(cfg)
  return bambuReportToJob(print)
}

/** 断开缓存连接(退出前 / 凭据变化重建) */
export function disposeBambu(): void {
  const entry = cached
  cached = null
  if (!entry) return
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.client.end(true)
}
