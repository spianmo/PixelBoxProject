/**
 * OpenSCAD 编译调度(主线程侧):scadWorker 的生命周期 + 请求排队 + 超时重建
 *
 * - Worker 惰性创建(首个硬件工程才拉起 11MB wasm chunk),单实例串行:
 *   wasm 编译吃满单核,并行两个实例只会互相拖慢,排队即可
 * - 超时(预览 60s / 导出 180s)或 worker 崩溃:terminate + 置空,下次请求重建;
 *   排队中的请求全部以失败回执
 * - PB_META 契约解析:从编译日志抓 PB_META{...} JSON(模板生成的 echo;
 *   用户删掉该行时返回 null,调用方回退包围盒推导)
 */
import type { EnclosureScadMeta } from '../../../shared/ipc-types'

export interface ScadCompileResult {
  stl: ArrayBuffer
  meta: EnclosureScadMeta | null
  logs: string[]
}

interface ScadJob {
  code: string
  part: 'base' | 'lid' | 'all'
  fnOverride?: number
  timeoutMs: number
  resolve: (r: ScadCompileResult) => void
  reject: (e: Error) => void
}

let worker: Worker | null = null
let seqCounter = 0
/** 排队中的任务(客户端串行:一次只派发一个,超时计时从派发起算 ——
 *  排队的预览短计时器不会反杀正在编译、预算更长的导出任务) */
const queue: ScadJob[] = []
/** 已派发给 worker 的任务(worker 单实例串行,恒最多一个) */
let active: { job: ScadJob; seq: number; timer: number } | null = null

/** 预览编译超时(fn=20 模板 ≈ 4s,给足慢机余量) */
const PREVIEW_TIMEOUT_MS = 60_000
/** 全质量导出超时(fn=64 ≈ 19s) */
const EXPORT_TIMEOUT_MS = 180_000

/** 从编译日志解析 PB_META 契约(echo 行形如 `ECHO: "PB_META{...}"`) */
export function parseScadMeta(logs: string[]): EnclosureScadMeta | null {
  for (const line of logs) {
    const at = line.indexOf('PB_META')
    if (at < 0) continue
    // echo 会给字符串加引号并转义,宽松抓 {...} 段再反转义
    const raw = line.slice(at + 'PB_META'.length).replace(/\\"/g, '"')
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
      if (typeof obj.boardTopZ !== 'number') continue
      const bat = obj.battery
      const battery =
        Array.isArray(bat) && bat.length === 3 && bat.every((v) => typeof v === 'number' && v > 0)
          ? ([bat[0], bat[1], bat[2]] as [number, number, number])
          : null
      return {
        boardTopZ: obj.boardTopZ,
        screenFaceZ: typeof obj.screenFaceZ === 'number' ? obj.screenFaceZ : null,
        lidTopZ: typeof obj.lidTopZ === 'number' ? obj.lidTopZ : null,
        baseTopZ: typeof obj.baseTopZ === 'number' ? obj.baseTopZ : null,
        outerW: typeof obj.outerW === 'number' ? obj.outerW : null,
        outerD: typeof obj.outerD === 'number' ? obj.outerD : null,
        screenWindow: obj.screenWindow === true,
        battery,
        batteryZ: typeof obj.batteryZ === 'number' ? obj.batteryZ : null,
        colorHex: typeof obj.colorHex === 'string' ? obj.colorHex : null
      }
    } catch {
      // JSON 损坏(用户改了 echo):继续找下一行
    }
  }
  return null
}

function ensureWorker(): Worker {
  if (worker) return worker
  // Rspack 要求字面量形态才能静态拆 worker chunk(同 monacoSetup 的约定)
  worker = new Worker(new URL('./scadWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev) => {
    const { seq, ok, stl, error, logs } = ev.data as {
      seq: number
      ok: boolean
      stl?: ArrayBuffer
      error?: string
      logs: string[]
    }
    if (!active || active.seq !== seq) return // 迟到回执(已超时重建):丢弃
    const { job, timer } = active
    active = null
    window.clearTimeout(timer)
    if (ok && stl) job.resolve({ stl, meta: parseScadMeta(logs), logs })
    else job.reject(new Error(error ?? 'scad:compileFailed'))
    dispatchNext()
  }
  worker.onerror = () => failAll(new Error('scad:workerCrashed'))
  return worker
}

/** 派发队首任务(active 空闲时);超时计时自派发这一刻起算 */
function dispatchNext(): void {
  if (active || queue.length === 0) return
  const job = queue.shift()!
  const seq = ++seqCounter
  const timer = window.setTimeout(() => {
    // 超时:wasm 编译不可中断,只能整体重建。先给超时任务本身失败回执
    // (它已不在 pending 集合,failAll 摸不到它 —— 漏发会让调用方永久挂起,
    // 连锁卡死 store 的 scadInFlight 与面板的 exportBusyRef),再清队重建
    const a = active
    active = null
    a?.job.reject(new Error('scad:timeout'))
    failAll(new Error('scad:timeout'))
  }, job.timeoutMs)
  active = { job, seq, timer }
  ensureWorker().postMessage({ seq, code: job.code, part: job.part, fnOverride: job.fnOverride })
}

/** 杀 worker 并让活跃 + 排队任务全部失败回执(超时/崩溃/释放) */
function failAll(err: Error): void {
  worker?.terminate()
  worker = null
  if (active) {
    window.clearTimeout(active.timer)
    active.job.reject(err)
    active = null
  }
  for (const job of queue.splice(0)) job.reject(err)
}

/**
 * 编译一个分件。fnOverride 给预览质量(如 20);不给则用文件自带 $fn(导出)。
 * 客户端串行排队;超时/崩溃后 worker 自动重建,调用方直接重试即可。
 */
export function compileScad(
  code: string,
  part: 'base' | 'lid' | 'all',
  fnOverride?: number
): Promise<ScadCompileResult> {
  return new Promise<ScadCompileResult>((resolve, reject) => {
    queue.push({
      code,
      part,
      fnOverride,
      timeoutMs: fnOverride ? PREVIEW_TIMEOUT_MS : EXPORT_TIMEOUT_MS,
      resolve,
      reject
    })
    dispatchNext()
  })
}

/** 释放 worker(工作区关闭等;下次编译自动重建) */
export function disposeScadWorker(): void {
  failAll(new Error('scad:disposed'))
}
