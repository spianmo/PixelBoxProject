/**
 * 硬件设计工作区状态(HardwareDesignPanel 及其子表单/对话框共享)
 *
 * - createStore + useSyncExternalStore 轻量订阅(同 shell/store.ts,不用 zustand)
 * - evaluateDesign:design/*.tsx|ts(fs IPC)→ CircuitWebWorker 评估 →
 *   buildBoardSpec/detectScreenPlacement 提炼 3D 规格;成功换新引用并 evalSeq++
 * - 外壳参数:design/enclosure.json 读写(写入 500ms 防抖),与 DEFAULT_ENCLOSURE 合并
 */
import { useSyncExternalStore } from 'react'
import type { AnyCircuitElement } from 'circuit-json'
import { createStore, type Store } from '../device-sim/store'
import { DEFAULT_ENCLOSURE } from '../../../shared/hardwareDefaults'
import type { BoardSpec, EnclosureParams, EnclosurePort, ScreenPlacement } from './types'
import { evalTsxFsMap } from './evalWorker'
import { buildBoardSpec, detectScreenPlacement } from './three/boardBuilder'

// ---------------------------------------------------------------
// 状态
// ---------------------------------------------------------------

export interface HardwareState {
  status: 'idle' | 'evaluating' | 'ok' | 'error'
  error: string | null
  /** 每次成功 eval 换新引用(PCBViewer 刷新依据) */
  circuitJson: AnyCircuitElement[] | null
  boardSpec: BoardSpec | null
  screen: ScreenPlacement | null
  /** 载入 design/enclosure.json,变更 500ms 防抖写回 */
  enclosure: EnclosureParams
  explode: 0 | 1
  evalSeq: number
}

function initialState(): HardwareState {
  return {
    status: 'idle',
    error: null,
    circuitJson: null,
    boardSpec: null,
    screen: null,
    enclosure: { ...DEFAULT_ENCLOSURE, ports: [] },
    explode: 0,
    evalSeq: 0
  }
}

export const hardwareStore: Store<HardwareState> = createStore<HardwareState>(initialState())

/** React hook:订阅硬件设计状态 */
export function useHardware(): HardwareState {
  return useSyncExternalStore(hardwareStore.subscribe, hardwareStore.get)
}

// ---------------------------------------------------------------
// 工作区绑定(切换工程时清空旧评估结果,避免串台)
// ---------------------------------------------------------------

/** 当前状态所属的工程根(evaluateDesign 的过期结果守卫) */
let currentRoot: string | null = null

/** 重置为初始状态(工作区切换/关闭时) */
export function resetHardware(): void {
  window.clearTimeout(persistTimer)
  hardwareStore.replace(initialState())
}

/**
 * 面板挂载/工作区变化入口:root 变化时重置状态并加载外壳参数 + 首次评估;
 * root 未变(面板重挂载)时保留既有评估结果。
 */
export function ensureHardwareWorkspace(root: string | null): void {
  if (currentRoot === root) return
  currentRoot = root
  resetHardware()
  if (!root) return
  void loadEnclosureParams(root)
  void evaluateDesign(root)
}

// ---------------------------------------------------------------
// 设计评估
// ---------------------------------------------------------------

/** 评估进行中又被请求(fs 事件连发):记下待办,结束后补跑一次 */
let pendingRoot: string | null = null

/**
 * 读取 <root>/design 下全部 .tsx/.ts(相对路径 fsMap,入口 board.tsx)→
 * worker 评估 → 提炼 BoardSpec/ScreenPlacement 写入 store。
 * 错误进入 status:'error'(error 取首行,哨兵码由面板转 i18n)。
 */
export async function evaluateDesign(root: string): Promise<void> {
  if (hardwareStore.get().status === 'evaluating') {
    pendingRoot = root
    return
  }
  currentRoot = root
  hardwareStore.set({ status: 'evaluating', error: null })
  try {
    const entries = await window.api.readDir(`${root}/design`)
    const files = entries.filter((e) => !e.isDir && /\.(tsx|ts)$/i.test(e.name))
    if (!files.some((f) => f.name === 'board.tsx')) throw new Error('hardware:noBoardEntry')

    const fsMap: Record<string, string> = {}
    for (const f of files) fsMap[f.name] = await window.api.readFile(f.path)

    const circuitJson = await evalTsxFsMap(fsMap, 'board.tsx')
    const boardSpec = buildBoardSpec(circuitJson)
    const screen = detectScreenPlacement(circuitJson)

    if (currentRoot !== root) return // 评估期间已切换工作区,丢弃过期结果
    hardwareStore.set({
      status: 'ok',
      error: null,
      circuitJson,
      boardSpec,
      screen,
      evalSeq: hardwareStore.get().evalSeq + 1
    })
  } catch (err) {
    if (currentRoot !== root) return
    const message = err instanceof Error ? err.message : String(err)
    hardwareStore.set({ status: 'error', error: message.split('\n')[0] })
  } finally {
    if (pendingRoot !== null) {
      const next = pendingRoot
      pendingRoot = null
      void evaluateDesign(next)
    }
  }
}

// ---------------------------------------------------------------
// 外壳参数(design/enclosure.json)
// ---------------------------------------------------------------

/** EnclosureParams 的全部数值字段(载入清洗与表单共用) */
const ENCLOSURE_NUMERIC_KEYS = [
  'wallMM',
  'clearanceMM',
  'baseHeightMM',
  'lidHeightMM',
  'standoffHeightMM',
  'standoffOuterR',
  'standoffInnerR',
  'cornerR'
] as const

const PORT_WALLS = ['north', 'south', 'east', 'west'] as const

function isPort(v: unknown): v is EnclosurePort {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  if (!(PORT_WALLS as readonly string[]).includes(p.wall as string)) return false
  const nums = ['x', 'y', 'w', 'h'].every(
    (k) => typeof p[k] === 'number' && Number.isFinite(p[k] as number)
  )
  return nums && (p.r === undefined || (typeof p.r === 'number' && Number.isFinite(p.r)))
}

/** 磁盘 JSON → 合法 EnclosureParams(缺字段/脏数据回落 DEFAULT_ENCLOSURE) */
function sanitizeEnclosure(raw: unknown): EnclosureParams {
  const merged: EnclosureParams = { ...DEFAULT_ENCLOSURE, ports: [] }
  if (typeof raw !== 'object' || raw === null) return merged
  const r = raw as Record<string, unknown>
  for (const key of ENCLOSURE_NUMERIC_KEYS) {
    const v = r[key]
    if (typeof v === 'number' && Number.isFinite(v)) merged[key] = v
  }
  if (typeof r.screenWindow === 'boolean') merged.screenWindow = r.screenWindow
  if (Array.isArray(r.ports)) {
    merged.ports = r.ports.filter(isPort).map((p) => ({ ...p }))
  }
  return merged
}

/** 读取 design/enclosure.json(无文件/解析失败 → DEFAULT_ENCLOSURE) */
export async function loadEnclosureParams(root: string): Promise<void> {
  let params: EnclosureParams = { ...DEFAULT_ENCLOSURE, ports: [] }
  try {
    const text = await window.api.readFile(`${root}/design/enclosure.json`)
    params = sanitizeEnclosure(JSON.parse(text))
  } catch {
    // 文件不存在或损坏:用默认值(首次保存时落盘)
  }
  hardwareStore.set({ enclosure: params })
}

let persistTimer = 0

/** 更新外壳参数:store 即时生效(3D 实时重建),500ms 防抖写回 enclosure.json */
export function setEnclosureParams(root: string, patch: Partial<EnclosureParams>): void {
  const next: EnclosureParams = { ...hardwareStore.get().enclosure, ...patch }
  hardwareStore.set({ enclosure: next })
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    void window.api
      .writeFile(`${root}/design/enclosure.json`, `${JSON.stringify(next, null, 2)}\n`)
      .catch(() => {
        // 写盘失败不打断编辑(下次变更重试)
      })
  }, 500)
}
