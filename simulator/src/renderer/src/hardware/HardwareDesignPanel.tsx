/**
 * 硬件设计工具窗(hardware 工程主面板;Stage2 挂到 rail)
 *
 * 顶栏为 JetBrains 式两行紧凑 chrome(右 dock 最窄 ~300px 时不换行不溢出):
 * - 行 1:tab 分段控件(PCB/原理图/3D/外壳/打印),窄于容器时横向滚动
 * - 行 2:图标动作按钮(运行设计 / 爆炸视图仅 3D tab / 添加到模拟器 / 导出下拉)
 * - PCB / 原理图:CircuitSvgView(circuit-to-svg 离线转 SVG;
 *   旧 @tscircuit/pcb-viewer / schematic-viewer 的 react-reconciler@0.32
 *   在 React18 下 import 即崩,已从依赖移除);
 *   每次成功评估以 evalSeq 作 key 重挂载(契约:新数组引用 + 重挂载刷新)
 * - 3D 视图:命令式 HardwareViewer(useEffect 创建/销毁)+ 爆炸视图 toggle
 * - design/*.tsx|ts 文件变更(fs 事件)→ 800ms 防抖自动重评估
 * - STL 导出:临时离屏 HardwareViewer 生成 binary STL → base64 → hardware:export;
 *   Gerber:circuit-json-to-gerber(懒加载)+ Excellon 钻孔 → hardware:export
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LuCircleAlert,
  LuDownload,
  LuExpand,
  LuLoaderCircle,
  LuMonitorSmartphone,
  LuPlay,
  LuRotateCcw
} from 'react-icons/lu'
import type { EnclosureScadMeta, HardwareExportFile } from '../../../shared/ipc-types'
import { showToast } from '../components/toast'
import { monaco } from '../editor/monacoSetup'
import { getAppSettings, subscribeSettings } from '../settings/store'
import { MenuButton, type DropdownItem } from '../shell/Dropdown'
import type { Hardware3D, HardwarePartId } from './types'
import { HardwareViewer } from './three/HardwareViewer'
import {
  compileEnclosureScad,
  compileScadForExport,
  ensureHardwareWorkspace,
  evaluateDesign,
  hardwareStore,
  migrateEnclosureToScad,
  useHardware,
  type ScadLogEntry
} from './store'
import { CircuitSvgView } from './CircuitSvgView'
import { AddDeviceDialog } from './AddDeviceDialog'
import { PrintDialog, type StlPart } from './PrintDialog'

type HwTab = 'pcb' | 'schematic' | 'view3d' | 'enclosure' | 'print'

const TAB_IDS: HwTab[] = ['pcb', 'schematic', 'view3d', 'enclosure', 'print']

/** STL 部件 → 导出文件名 */
const STL_FILE_NAME: Record<HardwarePartId, string> = {
  base: 'enclosure-base.stl',
  lid: 'enclosure-lid.stl',
  board: 'board.stl'
}

// ---------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]
}

/** 二进制 → base64(分块拼接,避免大 STL 撑爆调用栈) */
function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function bufferToB64(buf: ArrayBuffer): string {
  return bytesToB64(new Uint8Array(buf))
}

function textToB64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text))
}

// ---------------------------------------------------------------
// 空态 / 错误态
// ---------------------------------------------------------------

function CenterHint(props: { text: string; spinner?: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      {props.spinner && <LuLoaderCircle className="animate-spin text-[18px] text-accent" />}
      <div className="max-w-[360px] text-xs leading-5 text-ink-500">{props.text}</div>
    </div>
  )
}

function ErrorState(props: { title: string; message: string; retryLabel: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-[560px] rounded border border-red-500/40 bg-red-500/10 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-red-400">
          <LuCircleAlert className="shrink-0" />
          <span>{props.title}</span>
        </div>
        <div className="selectable break-all font-mono text-xs leading-5 text-red-300">{props.message}</div>
        <button
          onClick={props.onRetry}
          className="mt-2 flex h-6 items-center gap-1 rounded border border-ink-600 px-2 text-[12px] text-jb-muted hover:bg-ink-800 hover:text-jb-text"
        >
          <LuRotateCcw className="text-[11px]" />
          <span>{props.retryLabel}</span>
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// 顶栏图标按钮(同 SimPanel ToolStripButton 密度:h-7 w-7 纯图标 + title)
// ---------------------------------------------------------------

function HwToolButton(props: {
  title: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-[14px] ${
        props.disabled
          ? 'cursor-not-allowed text-ink-500'
          : props.active
            ? 'bg-jb-selection text-jb-text'
            : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
      }`}
    >
      {props.children}
    </button>
  )
}

// ---------------------------------------------------------------
// 3D tab(命令式 HardwareViewer:创建/销毁与数据更新分离)
// ---------------------------------------------------------------

function View3DTab(props: {
  hw3d: Hardware3D
  explode: 0 | 1
  /** scad 编译状态与日志(视图右上角状态角标 + 可展开日志;store.scadLog) */
  scadStatus: 'idle' | 'compiling' | 'ok' | 'error'
  scadLog: ScadLogEntry[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<HardwareViewer | null>(null)
  const [logOpen, setLogOpen] = useState(false)

  // 创建/销毁(先于下方数据 effect 声明,挂载时按序执行)
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const viewer = new HardwareViewer(canvas, {
      interactive: true,
      axes: getAppSettings().appearance.show3dAxes
    })
    viewerRef.current = viewer
    const ro = new ResizeObserver(() => viewer.resize())
    ro.observe(wrap)
    return () => {
      ro.disconnect()
      viewerRef.current = null
      viewer.dispose()
    }
  }, [])

  // 坐标轴指示器开关(settings 实时生效;subscribeSettings 是全量通知,值不变也无害)
  useEffect(() => {
    return subscribeSettings(() => {
      viewerRef.current?.setAxesVisible(getAppSettings().appearance.show3dAxes)
    })
  }, [])

  useEffect(() => {
    viewerRef.current?.setHardware(props.hw3d)
  }, [props.hw3d])

  useEffect(() => {
    viewerRef.current?.setExplode(props.explode)
  }, [props.explode])

  const lastLog = props.scadLog[0]
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[11px] text-ink-500">
        {t('hw.view3d.hint')}
      </div>
      {/* scad 编译状态角标(右上;点击展开日志环):敲代码 → 立刻能看到「编译中→完成/失败」 */}
      {(props.scadStatus !== 'idle' || props.scadLog.length > 0) && (
        <div className="absolute right-2 top-2 flex max-w-[75%] flex-col items-end gap-1">
          <button
            onClick={() => setLogOpen((v) => !v)}
            title={t('hw.scad.logToggle')}
            className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] ${
              props.scadStatus === 'error'
                ? 'border-red-500/40 bg-red-500/10 text-red-400'
                : 'border-ink-600 bg-ink-850/90 text-jb-muted hover:text-jb-text'
            }`}
          >
            {props.scadStatus === 'compiling' && <LuLoaderCircle className="animate-spin text-accent" />}
            {props.scadStatus === 'error' && <LuCircleAlert />}
            <span className="max-w-[360px] truncate">
              {props.scadStatus === 'compiling'
                ? t('hw.scad.compiling')
                : (lastLog?.text ?? t('hw.scad.ok'))}
            </span>
          </button>
          {logOpen && props.scadLog.length > 0 && (
            <div className="selectable max-h-48 w-[380px] overflow-y-auto rounded border border-ink-600 bg-ink-850/95 p-2 font-mono text-[11px] leading-4 shadow-lg">
              {props.scadLog.map((e, i) => (
                <div
                  key={`${e.ts}-${i}`}
                  className={
                    e.kind === 'error'
                      ? 'text-red-400'
                      : e.kind === 'ok'
                        ? 'text-green-400'
                        : 'text-jb-muted'
                  }
                >
                  {new Date(e.ts).toLocaleTimeString()} · {e.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------
// OpenSCAD 外壳状态卡(外壳 tab 的 scad 模式内容:编译态 + 契约摘要 + 编辑入口)
// ---------------------------------------------------------------

function ScadEnclosureCard(props: {
  root: string
  status: 'idle' | 'compiling' | 'ok' | 'error'
  error: string | null
  meta: EnclosureScadMeta | null
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const scadPath = `${props.root}/design/enclosure.scad`
  return (
    <div className="flex flex-col gap-3 text-[13px] text-jb-text">
      <div className="rounded border border-ink-700 bg-ink-850 p-3">
        <div className="mb-1 font-medium">{t('hw.scad.title')}</div>
        <p className="mb-2 text-[12px] leading-5 text-jb-muted">{t('hw.scad.desc')}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => props.onOpenFile?.(scadPath)}
            className="rounded bg-accent px-2 py-0.5 text-xs text-white hover:bg-accent-dim"
          >
            {t('hw.scad.openFile')}
          </button>
          {props.status === 'compiling' && (
            <span className="flex items-center gap-1 text-[12px] text-jb-muted">
              <LuLoaderCircle className="animate-spin text-accent" />
              {t('hw.scad.compiling')}
            </span>
          )}
          {props.status === 'ok' && (
            <span className="text-[12px] text-green-400">{t('hw.scad.ok')}</span>
          )}
        </div>
      </div>
      {props.status === 'error' && props.error && (
        <div className="selectable rounded border border-red-500/30 bg-red-500/10 p-2 font-mono text-[11px] leading-4 text-red-400">
          {props.error}
        </div>
      )}
      {props.meta && (
        <div className="rounded border border-ink-700 p-3 text-[12px] leading-5 text-jb-muted">
          <div className="mb-1 font-medium text-jb-text">{t('hw.scad.metaTitle')}</div>
          <div>
            {t('hw.scad.metaOuter')}: {props.meta.outerW ?? '—'} × {props.meta.outerD ?? '—'} ×{' '}
            {props.meta.lidTopZ ?? '—'} mm
          </div>
          <div>
            {t('hw.scad.metaBoardTop')}: {props.meta.boardTopZ} mm · {t('hw.scad.metaScreen')}:{' '}
            {props.meta.screenWindow ? t('common.yes') : t('common.no')}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------
// 主面板
// ---------------------------------------------------------------

export function HardwareDesignPanel(props: {
  workspaceRoot: string | null
  /** 在主编辑器打开文件(外壳 tab 的「打开 enclosure.scad」入口;App 传 handleOpenFile) */
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const hw = useHardware()
  // 默认打开 3D 可视(PCB 验证的第一视角;2D PCB/原理图按需切换)
  const [tab, setTab] = useState<HwTab>('view3d')
  const [addOpen, setAddOpen] = useState(false)
  // (「编辑外壳」手柄模式随参数化外壳一并退役:几何唯一真源是 enclosure.scad)
  const exportBusyRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const root = props.workspaceRoot

  /** 事件目标位于文本编辑上下文(原生撤销归输入框/Monaco,不抢) */
  const inTextEditingContext = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    target.closest('input,textarea,[contenteditable],.monaco-editor') !== null

  /** 点按面板内非输入区域时让面板根获焦,承接 ⌘Z/⇧⌘Z(容器 tabIndex=-1 可编程聚焦) */
  const onPanelPointerDown = (e: React.PointerEvent): void => {
    if (inTextEditingContext(e.target)) return
    panelRef.current?.focus({ preventScroll: true })
  }

  /**
   * 面板级外壳撤销/重做快捷键(⌘Z/⇧⌘Z,Windows/Linux 另收 Ctrl+Y)。
   * 监听只挂在面板子树:不碰全局,更不抢 Monaco 的 ⌘Z;
   * 仅在真正执行了撤销/重做时 preventDefault。
   */
  // (外壳撤销/重做已随参数化模式退役:.scad 的文本撤销由 Monaco 承接)

  // 工作区绑定:root 变化重置并首评;面板重挂载且尚无结果时自动评估
  useEffect(() => {
    ensureHardwareWorkspace(root)
    if (!root) return
    const s = hardwareStore.get()
    if (s.circuitJson === null && s.status === 'idle') void evaluateDesign(root)
  }, [root])

  // design/ 变更:*.tsx|ts → 800ms 防抖重评估;enclosure.scad → 500ms 防抖重编译
  // (外部改动/git checkout 路径;编辑器内敲字走下方 Monaco 模型订阅,不等落盘)
  useEffect(() => {
    if (!root) return
    let evalTimer = 0
    let scadTimer = 0
    const off = window.api.onFsEvent((ev) => {
      const p = ev.path.replace(/\\/g, '/')
      if (!p.includes('/design/')) return
      if (/\.scad$/i.test(p)) {
        window.clearTimeout(scadTimer)
        scadTimer = window.setTimeout(() => {
          void compileEnclosureScad(root)
        }, 500)
        return
      }
      if (!/\.(tsx|ts)$/i.test(p)) return
      window.clearTimeout(evalTimer)
      evalTimer = window.setTimeout(() => {
        void evaluateDesign(root)
      }, 800)
    })
    return () => {
      window.clearTimeout(evalTimer)
      window.clearTimeout(scadTimer)
      off()
    }
  }, [root])

  // 即时编辑即时渲染:订阅 enclosure.scad 的 Monaco 模型内容(不等保存落盘),
  // 600ms 去抖直接喂编译器;模型可能后于面板创建(用户稍后才打开该文件)→
  // onDidCreateModel 兜底
  useEffect(() => {
    if (!root) return
    const uriStr = monaco.Uri.file(`${root}/design/enclosure.scad`).toString()
    let timer = 0
    const subs: { dispose(): void }[] = []
    const hook = (model: ReturnType<typeof monaco.editor.getModels>[number]): void => {
      if (model.uri.toString() !== uriStr) return
      subs.push(
        model.onDidChangeContent(() => {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            void compileEnclosureScad(root, model.getValue())
          }, 600)
        })
      )
    }
    for (const m of monaco.editor.getModels()) hook(m)
    subs.push(monaco.editor.onDidCreateModel(hook))
    return () => {
      window.clearTimeout(timer)
      for (const s of subs) s.dispose()
    }
  }, [root])

  // 旧参数化工程迁移:首次评估成功(boardSpec/screen 就绪)且无 enclosure.scad 时,
  // 用当前参数生成 .scad(migrate 内部对已存在文件跳过,幂等)
  useEffect(() => {
    if (!root || hw.status !== 'ok' || !hw.boardSpec) return
    void migrateEnclosureToScad(root).then((migrated) => {
      if (migrated) showToast(t('hw.scad.migrated'), 'info')
    })
    // eslint 无此工程:t 稳定,迁移仅关心评估结果就绪
  }, [root, hw.status, hw.boardSpec])

  /** 3D 数据(boardSpec/外壳/scad 产物/屏幕任一变化 → 新引用触发 viewer 重建) */
  const hw3d = useMemo<Hardware3D | null>(() => {
    if (!hw.boardSpec) return null
    return {
      board: hw.boardSpec,
      ...(hw.scad ? { scad: hw.scad } : {}),
      screen: hw.screen ?? undefined,
      designRoot: root ?? undefined
    }
  }, [hw.boardSpec, hw.scad, hw.screen, root])

  /** 哨兵错误码 → i18n(其余原样展示) */
  const errorText = (msg: string): string => {
    if (msg === 'hardware:evalTimeout') return t('hw.errors.evalTimeout')
    if (msg === 'hardware:noBoardEntry') return t('hw.errors.noBoardEntry')
    if (msg === 'hw:noBoard') return t('hw.errors.noBoard') // boardBuilder:电路无 <board> 或板尺寸无效
    return msg
  }

  // ---- 导出 ----

  const exportStlParts = async (parts: HardwarePartId[]): Promise<void> => {
    const s = hardwareStore.get()
    if (!root || !s.boardSpec) {
      showToast(t('hw.export.needEval'), 'warn')
      return
    }
    if (exportBusyRef.current) return
    exportBusyRef.current = true
    // 临时离屏 viewer:导出不依赖 3D tab 是否打开
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    let viewer: HardwareViewer | null = null
    try {
      const v = new HardwareViewer(canvas, { interactive: false, background: null })
      viewer = v
      v.setHardware({
        board: s.boardSpec,
        ...(s.scad ? { scad: s.scad } : {}),
        screen: s.screen ?? undefined
      })
      // scad 模式的 base/lid:全质量重编译(文件自带 $fn,预览产物是降采样的),
      // OpenSCAD 输出即 Z-up 打印坐标,直接落盘;board 仍由 three 场景导出。
      // 源码优先取 Monaco 活缓冲:3D 预览跟随未保存编辑,导出必须与所见一致
      const liveScad = monaco.editor
        .getModel(monaco.Uri.file(`${root}/design/enclosure.scad`))
        ?.getValue()
      const files: HardwareExportFile[] = []
      for (const part of parts) {
        if (s.scad && (part === 'base' || part === 'lid')) {
          if (hardwareStore.get().scadStatus === 'compiling') showToast(t('hw.scad.exportSlow'), 'info')
          files.push({
            name: STL_FILE_NAME[part],
            dataB64: bufferToB64(await compileScadForExport(root, part, liveScad))
          })
        } else {
          files.push({ name: STL_FILE_NAME[part], dataB64: bufferToB64(v.exportSTL(part)) })
        }
      }
      const res = await window.api.hardwareExport({ root, kind: 'print', files })
      showToast(t('hw.export.stlDone', { dir: res.dir }), 'success')
    } catch (err) {
      showToast(t('hw.export.failed', { msg: firstLine(err) }), 'error')
    } finally {
      viewer?.dispose()
      exportBusyRef.current = false
    }
  }

  const exportGerber = async (): Promise<void> => {
    const s = hardwareStore.get()
    if (!root || !s.circuitJson) {
      showToast(t('hw.export.needEval'), 'warn')
      return
    }
    if (exportBusyRef.current) return
    exportBusyRef.current = true
    try {
      const g = await import('circuit-json-to-gerber')
      const cj = s.circuitJson as unknown as Parameters<typeof g.convertSoupToGerberCommands>[0]
      const layers = g.stringifyGerberCommandLayers(g.convertSoupToGerberCommands(cj))
      const files: HardwareExportFile[] = Object.entries(layers).map(([layer, content]) => ({
        name: `${layer}.gbr`,
        dataB64: textToB64(content)
      }))
      files.push(
        {
          name: 'plated.drl',
          dataB64: textToB64(
            g.stringifyExcellonDrill(
              g.convertSoupToExcellonDrillCommands({ circuitJson: cj, is_plated: true })
            )
          )
        },
        {
          name: 'unplated.drl',
          dataB64: textToB64(
            g.stringifyExcellonDrill(
              g.convertSoupToExcellonDrillCommands({ circuitJson: cj, is_plated: false })
            )
          )
        }
      )
      const res = await window.api.hardwareExport({ root, kind: 'gerber', files })
      showToast(t('hw.export.gerberDone', { dir: res.dir }), 'success')
    } catch (err) {
      showToast(t('hw.export.failed', { msg: firstLine(err) }), 'error')
    } finally {
      exportBusyRef.current = false
    }
  }

  const onExportStlPart = (part: StlPart): void => {
    void exportStlParts(part === 'all' ? ['base', 'lid', 'board'] : [part])
  }

  const exportItems: DropdownItem[] = [
    { key: 'stl-all', label: `STL · ${t('hw.parts.all')}`, onSelect: () => onExportStlPart('all') },
    { key: 'stl-base', label: `STL · ${t('hw.parts.base')}`, onSelect: () => onExportStlPart('base') },
    { key: 'stl-lid', label: `STL · ${t('hw.parts.lid')}`, onSelect: () => onExportStlPart('lid') },
    { key: 'stl-board', label: `STL · ${t('hw.parts.board')}`, onSelect: () => onExportStlPart('board') },
    { key: 'gerber', group: '', label: t('hw.toolbar.exportGerber'), onSelect: () => void exportGerber() }
  ]

  const ready = hw.status === 'ok' && hw.boardSpec !== null

  // ---- tab 内容 ----

  const renderTab = (): React.JSX.Element => {
    if (!root) return <CenterHint text={t('hw.empty.noWorkspace')} />
    switch (tab) {
      case 'enclosure':
        // scad 模式:外壳即代码 —— 状态卡(编译态/错误/契约摘要)+ 打开编辑器入口;
        // 无 .scad 的旧工程仍显示参数表单(评估成功后自动迁移,随后切换到 scad 卡)
        if (hw.scad !== null || hw.scadStatus !== 'idle') {
          return (
            <div className="h-full overflow-y-auto p-3">
              <ScadEnclosureCard
                root={root}
                status={hw.scadStatus}
                error={hw.scadError}
                meta={hw.scad?.meta ?? null}
                onOpenFile={props.onOpenFile}
              />
            </div>
          )
        }
        // 旧参数化工程(尚无 .scad):评估成功后自动迁移,此处给等待提示
        return (
          <CenterHint
            text={t('hw.scad.migrating')}
            spinner={hw.status === 'evaluating' || hw.status === 'idle'}
          />
        )
      case 'print':
        return (
          <div className="h-full overflow-y-auto p-3">
            <PrintDialog onExportStl={onExportStlPart} />
          </div>
        )
      case 'pcb':
      case 'schematic':
      case 'view3d': {
        if (hw.status === 'error') {
          return (
            <ErrorState
              title={t('hw.empty.error')}
              message={errorText(hw.error ?? '')}
              retryLabel={t('hw.toolbar.run')}
              onRetry={() => void evaluateDesign(root)}
            />
          )
        }
        if (!hw.circuitJson || !hw3d) {
          return (
            <CenterHint
              text={hw.status === 'evaluating' ? t('hw.toolbar.evaluating') : t('hw.empty.idle')}
              spinner={hw.status === 'evaluating'}
            />
          )
        }
        if (tab === 'pcb' || tab === 'schematic') {
          // evalSeq 作 key:每次成功评估重挂载,配合新数组引用刷新视图(契约)
          return (
            <div className="h-full w-full overflow-hidden">
              <CircuitSvgView
                key={hw.evalSeq}
                circuitJson={hw.circuitJson}
                kind={tab}
                evalSeq={hw.evalSeq}
              />
            </div>
          )
        }
        return (
          <View3DTab
            hw3d={hw3d}
            explode={hw.explode}
            scadStatus={hw.scadStatus}
            scadLog={hw.scadLog}
          />
        )
      }
    }
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onPointerDownCapture={onPanelPointerDown}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      {/* 顶栏:JetBrains 式两行紧凑 chrome(永不换行;300px 窄宽可用) */}
      <div className="shrink-0 border-b border-ink-700">
        {/* 行 1:tab 分段控件 —— 窄于容器时整条横向滚动(隐藏滚动条),而非换行 */}
        <div className="flex h-8 min-w-0 items-center overflow-x-auto px-2 [&::-webkit-scrollbar]:hidden">
          <div className="flex shrink-0 items-center gap-0.5 rounded bg-ink-850 p-0.5">
            {TAB_IDS.map((id) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-[12px] ${
                  tab === id ? 'bg-ink-700 text-jb-text' : 'text-jb-muted hover:text-jb-text'
                }`}
              >
                {t(`hw.tabs.${id}`)}
              </button>
            ))}
          </div>
        </div>

        {/* 行 2:动作按钮(全部纯图标 + title 提示) */}
        <div className="flex h-8 min-w-0 items-center gap-0.5 px-2">
          <HwToolButton
            onClick={() => {
              if (root) void evaluateDesign(root)
            }}
            disabled={!root || hw.status === 'evaluating'}
            title={`${t('hw.toolbar.run')}\n${t('hw.toolbar.runHint')}`}
          >
            {hw.status === 'evaluating' ? (
              <LuLoaderCircle className="animate-spin text-accent" />
            ) : (
              <LuPlay className="text-green-500" />
            )}
          </HwToolButton>
          {tab === 'view3d' && (
            <>
              <HwToolButton
                onClick={() => {
                  hardwareStore.set({ explode: hw.explode === 1 ? 0 : 1 })
                }}
                active={hw.explode === 1}
                title={t('hw.view3d.explode')}
              >
                <LuExpand />
              </HwToolButton>
            </>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <HwToolButton
              onClick={() => setAddOpen(true)}
              disabled={!ready}
              title={`${t('hw.toolbar.addToSim')}\n${t('hw.toolbar.addToSimHint')}`}
            >
              <LuMonitorSmartphone />
            </HwToolButton>
            <MenuButton
              align="right"
              items={exportItems}
              disabled={!ready}
              title={t('hw.toolbar.export')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[14px] text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:cursor-not-allowed disabled:text-ink-500"
            >
              <LuDownload />
            </MenuButton>
          </div>
        </div>
      </div>

      {/* 状态行:评估中 / 评估失败(外壳、打印 tab 内容区不展示错误,在此常驻);
          首评时内容区已有居中 spinner 提示,状态行只在已有旧结果或表单类 tab 下出现 */}
      {hw.status === 'evaluating' && (hw.circuitJson !== null || tab === 'enclosure' || tab === 'print') && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-700 px-2 py-1 text-[12px] text-jb-muted">
          <LuLoaderCircle className="shrink-0 animate-spin text-accent" />
          <span className="line-clamp-1 min-w-0 break-all">{t('hw.toolbar.evaluating')}</span>
        </div>
      )}
      {hw.status === 'error' && hw.error && (tab === 'enclosure' || tab === 'print') && (
        <div className="selectable shrink-0 border-b border-red-500/30 bg-red-500/10 px-2 py-1 text-[12px] text-red-400">
          <span className="line-clamp-2 break-all">{errorText(hw.error)}</span>
        </div>
      )}

      {/* 内容区 */}
      <div className="min-h-0 flex-1">{renderTab()}</div>

      {addOpen && root && <AddDeviceDialog workspaceRoot={root} onClose={() => setAddOpen(false)} />}
    </div>
  )
}
