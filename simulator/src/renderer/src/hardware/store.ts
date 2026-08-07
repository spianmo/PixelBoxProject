/**
 * 硬件设计工作区状态(HardwareDesignPanel 及其子对话框共享)
 *
 * - createStore + useSyncExternalStore 轻量订阅(同 shell/store.ts,不用 zustand)
 * - evaluateDesign:design/*.tsx|ts(fs IPC)→ CircuitWebWorker 评估 →
 *   buildBoardSpec/detectScreenPlacement 提炼 3D 规格;成功换新引用并 evalSeq++
 * - 外壳:design/enclosure.scad 唯一真源(wasm worker 编译,电池占位等契约走
 *   PB_META)。enclosure.json 已退役 —— 仅在旧工程迁移时被读一次(生成 .scad),
 *   IDE 不再写入/依赖它;参数化渲染路径仅存于旧设备档案(hardware3d.enclosure)
 * - scadLog:编译事件环(开始/成功+耗时/失败),3D 视图角标与外壳页签共用
 */
import { useSyncExternalStore } from 'react'
import type { AnyCircuitElement } from 'circuit-json'
import { createStore, type Store } from '../device-sim/store'
import { DEFAULT_ENCLOSURE } from '../../../shared/hardwareDefaults'
import { enclosureScadFromParams } from '../../../shared/enclosureScadTemplate'
import type { EnclosureScadPayload } from '../../../shared/ipc-types'
import type { BoardSpec, EnclosureParams, EnclosurePort, ScreenPlacement } from './types'
import { evalTsxFsMap } from './evalWorker'
import { compileScad } from './scadCompiler'
import { arrayBufferToB64 } from './three/enclosureStl'
import { buildBoardSpec, detectScreenPlacement } from './three/boardBuilder'

/** scad 编译日志条目(环形,上限 SCAD_LOG_CAP;3D 视图角标/外壳页签展示) */
export interface ScadLogEntry {
  ts: number
  kind: 'start' | 'ok' | 'error'
  text: string
}

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
  /** OpenSCAD 外壳(design/enclosure.scad 编译产物;几何唯一真源) */
  scad: EnclosureScadPayload | null
  scadStatus: 'idle' | 'compiling' | 'ok' | 'error'
  /** 编译错误(OpenSCAD stderr 摘要;成功清空) */
  scadError: string | null
  /** scad 编译成功计数(3D 重建触发信号) */
  scadSeq: number
  /** scad 编译日志环(新在前;换新引用触发订阅) */
  scadLog: ScadLogEntry[]
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
    scad: null,
    scadStatus: 'idle',
    scadError: null,
    scadLog: [],
    scadSeq: 0,
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
  hardwareStore.replace(initialState())
}

/**
 * 面板挂载/工作区变化入口:root 变化时重置状态并加载外壳参数 + 首次评估;
 * root 未变(面板重挂载)时保留既有评估结果。
 */
export function ensureHardwareWorkspace(root: string | null): void {
  if (currentRoot === root) return
  currentRoot = root
  pendingRoot = null // 旧工作区排队的补跑作废(防止评估结束后复活已切换/关闭的工程)
  pendingScad = null
  resetHardware()
  if (!root) return
  void loadEnclosureScad(root)
  void evaluateDesign(root)
}

// ---------------------------------------------------------------
// 设计评估
// ---------------------------------------------------------------

/** 评估进行中又被请求(fs 事件连发/工作区切换):记下待办,结束后补跑一次 */
let pendingRoot: string | null = null

/**
 * 单飞闩:模块级布尔,不随 resetHardware 复位。若用 store 的 status 作守卫,
 * 工作区切换时 resetHardware 会把 status 打回 'idle',并发评估交叉杀共享 worker。
 */
let evalInFlight = false

/**
 * 读取 <root>/design 下全部 .tsx/.ts(相对路径 fsMap,入口 board.tsx)→
 * worker 评估 → 提炼 BoardSpec/ScreenPlacement 写入 store。
 * 错误进入 status:'error'(error 取首行,哨兵码由面板转 i18n)。
 */
export async function evaluateDesign(root: string): Promise<void> {
  if (evalInFlight) {
    pendingRoot = root
    // 工作区切换排队时 store 已被重置为 idle:补上 evaluating,面板 spinner 不掉
    if (hardwareStore.get().status !== 'evaluating') {
      hardwareStore.set({ status: 'evaluating', error: null })
    }
    return
  }
  evalInFlight = true
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
    evalInFlight = false
    if (pendingRoot !== null) {
      const next = pendingRoot
      pendingRoot = null
      // 仅当待办仍是当前工作区才补跑(已切换/关闭的工程不复活)
      if (next === currentRoot) void evaluateDesign(next)
    }
  }
}

// ---------------------------------------------------------------
// OpenSCAD 外壳(design/enclosure.scad → wasm 编译 → base/lid STL + PB_META)
// ---------------------------------------------------------------

/** 预览编译的 $fn 覆盖(实测模板 fn=16≈3.6s / fn=64≈19s;导出走全质量) */
const SCAD_PREVIEW_FN = 20

/** 编译进行中又来了新代码:记下最新,结束后补跑(与 evaluateDesign 同款单飞) */
let pendingScad: { root: string; code: string } | null = null
let scadInFlight = false

/**
 * 编译 enclosure.scad(base+lid 各一趟,预览质量)并写入 store。
 * code 未传时读盘;编译期间切工作区丢弃过期结果。
 */
export async function compileEnclosureScad(root: string, code?: string): Promise<void> {
  let source = code
  if (source === undefined) {
    try {
      source = await window.api.readFile(`${root}/design/enclosure.scad`)
    } catch {
      return // 无 .scad(旧参数化工程):保持参数化路径
    }
  }
  if (scadInFlight) {
    pendingScad = { root, code: source }
    return
  }
  scadInFlight = true
  const t0 = Date.now()
  hardwareStore.set({ scadStatus: 'compiling' })
  pushScadLog('start', `编译 enclosure.scad(${source.length} 字符,预览 $fn=${SCAD_PREVIEW_FN})`)
  try {
    // base/lid 串行(worker 单实例,底层本就排队;串行拿到更早的首件反馈)
    const baseR = await compileScad(source, 'base', SCAD_PREVIEW_FN)
    const lidR = await compileScad(source, 'lid', SCAD_PREVIEW_FN)
    if (currentRoot !== root) return
    const st = hardwareStore.get()
    hardwareStore.set({
      scad: {
        baseStlB64: arrayBufferToB64(baseR.stl),
        lidStlB64: arrayBufferToB64(lidR.stl),
        meta: baseR.meta ?? lidR.meta
      },
      scadStatus: 'ok',
      scadError: null,
      scadSeq: st.scadSeq + 1
    })
    pushScadLog(
      'ok',
      `编译完成 ${((Date.now() - t0) / 1000).toFixed(1)}s(底盒 ${Math.round(baseR.stl.byteLength / 1024)}KB + 顶盖 ${Math.round(lidR.stl.byteLength / 1024)}KB${baseR.meta ? '' : ';PB_META 缺失,已回退包围盒推导'})`
    )
  } catch (err) {
    if (currentRoot !== root) return
    const message = err instanceof Error ? err.message : String(err)
    hardwareStore.set({ scadStatus: 'error', scadError: message })
    pushScadLog('error', message.split('\n').slice(0, 2).join(' '))
  } finally {
    scadInFlight = false
    if (pendingScad) {
      const next = pendingScad
      pendingScad = null
      if (next.root === currentRoot) void compileEnclosureScad(next.root, next.code)
    }
  }
}

/** scad 编译日志环上限 */
const SCAD_LOG_CAP = 50

/** 推入一条编译日志(新在前,截断到环上限) */
function pushScadLog(kind: ScadLogEntry['kind'], text: string): void {
  const st = hardwareStore.get()
  hardwareStore.set({
    scadLog: [{ ts: Date.now(), kind, text }, ...st.scadLog].slice(0, SCAD_LOG_CAP)
  })
}

/**
 * 载入(或迁移出)enclosure.scad:
 * - 有 .scad:直接编译
 * - 无 .scad 但有 enclosure.json(旧参数化工程):等首次评估出 boardSpec 后,
 *   由面板调 migrateEnclosureToScad 生成 .scad(此处不动盘,保持只读语义)
 */
export async function loadEnclosureScad(root: string): Promise<void> {
  await compileEnclosureScad(root)
}

/**
 * 旧工程一次性迁移:读 design/enclosure.json(enclosure.json 在 IDE 内唯一的
 * 残留用途)+ 板规格生成 design/enclosure.scad 并写盘(已存在 .scad 则跳过)。
 * 由面板在评估完成(boardSpec/screen 就绪)后调用,保证模板里板尺寸/屏幕窗正确。
 * 迁移后 json 留在磁盘不再被读写(用户可自行删除)。
 */
export async function migrateEnclosureToScad(root: string): Promise<boolean> {
  try {
    await window.api.readFile(`${root}/design/enclosure.scad`)
    return false // 已有,不迁移
  } catch {
    // 不存在:继续生成
  }
  const st = hardwareStore.get()
  if (!st.boardSpec) return false
  const params = await readLegacyEnclosureParams(root)
  const code = enclosureScadFromParams(
    params,
    {
      widthMM: st.boardSpec.widthMM,
      heightMM: st.boardSpec.heightMM,
      thicknessMM: st.boardSpec.thicknessMM
    },
    st.screen
  )
  try {
    await window.api.writeFile(`${root}/design/enclosure.scad`, code)
  } catch {
    return false
  }
  void compileEnclosureScad(root, code)
  return true
}

/** 旧 enclosure.json → 迁移用参数(缺文件/坏字段回落默认;ports 逐条校验防生成坏 scad) */
async function readLegacyEnclosureParams(root: string): Promise<EnclosureParams> {
  const merged: EnclosureParams = { ...DEFAULT_ENCLOSURE, ports: [] }
  try {
    const raw = JSON.parse(await window.api.readFile(`${root}/design/enclosure.json`)) as Record<
      string,
      unknown
    >
    for (const key of [
      'wallMM',
      'clearanceMM',
      'baseHeightMM',
      'lidHeightMM',
      'standoffHeightMM',
      'standoffOuterR',
      'standoffInnerR',
      'cornerR'
    ] as const) {
      const v = raw[key]
      if (typeof v === 'number' && Number.isFinite(v)) merged[key] = v
    }
    if (typeof raw.screenWindow === 'boolean') merged.screenWindow = raw.screenWindow
    if (typeof raw.colorHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.colorHex)) {
      merged.colorHex = raw.colorHex
    }
    if (typeof raw.batteryMM === 'object' && raw.batteryMM !== null) {
      const b = raw.batteryMM as Record<string, unknown>
      if (
        (['w', 'h', 't'] as const).every(
          (k) => typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) > 0
        )
      ) {
        merged.batteryMM = { w: b.w as number, h: b.h as number, t: b.t as number }
      }
    }
    if (Array.isArray(raw.ports)) merged.ports = raw.ports.filter(isPort).map((p) => ({ ...p }))
  } catch {
    // 无 json 的旧工程:按默认壳生成
  }
  return merged
}

function isPort(v: unknown): v is EnclosurePort {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  if (!['north', 'south', 'east', 'west'].includes(p.wall as string)) return false
  const nums = ['x', 'y', 'w', 'h'].every(
    (k) => typeof p[k] === 'number' && Number.isFinite(p[k] as number)
  )
  return nums && (p.r === undefined || (typeof p.r === 'number' && Number.isFinite(p.r)))
}

/**
 * 全质量导出编译(用文件自带 $fn;打印/导出用)。
 * code 由调用方传入 Monaco 活缓冲(未保存的编辑与 3D 预览所见一致 ——
 * 只读磁盘会静默导出旧几何);未打开该文件时读盘兜底。
 */
export async function compileScadForExport(
  root: string,
  part: 'base' | 'lid',
  code?: string
): Promise<ArrayBuffer> {
  const source = code ?? (await window.api.readFile(`${root}/design/enclosure.scad`))
  const r = await compileScad(source, part)
  return r.stl
}
