/**
 * 硬件设计工具窗(hardware 工程主面板;Stage2 挂到 rail)
 *
 * 顶栏:运行设计(评估中转 spinner)| tab 切换(PCB/原理图/3D/外壳/打印)|
 *       右侧:添加到模拟器 / 导出下拉(STL 全部/底盒/顶盖/板卡、Gerber)
 * - PCB / 原理图 viewer 走懒加载 import()(@tscircuit/pcb-viewer ~ 大依赖);
 *   每次成功评估以 evalSeq 作 key 重挂载(契约:新数组引用 + 重挂载刷新)
 * - 3D 视图:命令式 HardwareViewer(useEffect 创建/销毁)+ 爆炸视图 toggle
 * - design/*.tsx|ts 文件变更(fs 事件)→ 800ms 防抖自动重评估
 * - STL 导出:临时离屏 HardwareViewer 生成 binary STL → base64 → hardware:export;
 *   Gerber:circuit-json-to-gerber(懒加载)+ Excellon 钻孔 → hardware:export
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LuChevronDown,
  LuCircleAlert,
  LuDownload,
  LuExpand,
  LuLoaderCircle,
  LuMonitorSmartphone,
  LuPlay,
  LuRotateCcw
} from 'react-icons/lu'
import type { AnyCircuitElement } from 'circuit-json'
import type { HardwareExportFile } from '../../../shared/ipc-types'
import { showToast } from '../components/toast'
import { MenuButton, type DropdownItem } from '../shell/Dropdown'
import type { Hardware3D, HardwarePartId } from './types'
import { HardwareViewer } from './three/HardwareViewer'
import { ensureHardwareWorkspace, evaluateDesign, hardwareStore, useHardware } from './store'
import { EnclosureForm } from './EnclosureForm'
import { AddDeviceDialog } from './AddDeviceDialog'
import { PrintDialog, type StlPart } from './PrintDialog'

// ---------------------------------------------------------------
// 懒加载 2D viewer(契约:渲染进程严禁 @tscircuit/eval 包根;
// pcb/schematic viewer 是独立包,亦懒加载避免拖慢外壳启动)
// ---------------------------------------------------------------

const PCBViewerLazy = lazy(async () => ({
  default: (await import('@tscircuit/pcb-viewer')).PCBViewer
}))
const SchematicViewerLazy = lazy(async () => ({
  default: (await import('@tscircuit/schematic-viewer')).SchematicViewer
}))

/** viewer 各自捆绑的 circuit-json 版本可能与仓库锁版本号不同,经 unknown 对齐 */
type PcbCircuitJson = React.ComponentProps<typeof PCBViewerLazy>['circuitJson']
type SchCircuitJson = React.ComponentProps<typeof SchematicViewerLazy>['circuitJson']

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

function CenterSpinner(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <LuLoaderCircle className="animate-spin text-[18px] text-accent" />
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
// PCB tab(PCBViewer 需要像素高度:ResizeObserver 量容器)
// ---------------------------------------------------------------

function PcbTab(props: { circuitJson: AnyCircuitElement[]; evalSeq: number }): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const h = Math.floor(entries[0]?.contentRect.height ?? 0)
      if (h > 0) setHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={wrapRef} className="h-full w-full overflow-hidden">
      {height > 0 && (
        <Suspense fallback={<CenterSpinner />}>
          <PCBViewerLazy
            key={props.evalSeq}
            circuitJson={props.circuitJson as unknown as PcbCircuitJson}
            height={height}
          />
        </Suspense>
      )}
    </div>
  )
}

// ---------------------------------------------------------------
// 3D tab(命令式 HardwareViewer:创建/销毁与数据更新分离)
// ---------------------------------------------------------------

function View3DTab(props: {
  hw3d: Hardware3D
  explode: 0 | 1
  onToggleExplode: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<HardwareViewer | null>(null)

  // 创建/销毁(先于下方数据 effect 声明,挂载时按序执行)
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const viewer = new HardwareViewer(canvas, { interactive: true })
    viewerRef.current = viewer
    const ro = new ResizeObserver(() => viewer.resize())
    ro.observe(wrap)
    return () => {
      ro.disconnect()
      viewerRef.current = null
      viewer.dispose()
    }
  }, [])

  useEffect(() => {
    viewerRef.current?.setHardware(props.hw3d)
  }, [props.hw3d])

  useEffect(() => {
    viewerRef.current?.setExplode(props.explode)
  }, [props.explode])

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <button
        onClick={props.onToggleExplode}
        title={t('hw.view3d.explode')}
        className={`absolute right-2 top-2 flex h-7 items-center gap-1 rounded border px-2 text-[12px] ${
          props.explode === 1
            ? 'border-accent/60 bg-accent/15 text-accent'
            : 'border-ink-600 bg-ink-850/80 text-jb-muted hover:text-jb-text'
        }`}
      >
        <LuExpand className="text-[12px]" />
        <span>{t('hw.view3d.explode')}</span>
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[11px] text-ink-500">
        {t('hw.view3d.hint')}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// 主面板
// ---------------------------------------------------------------

export function HardwareDesignPanel(props: { workspaceRoot: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const hw = useHardware()
  const [tab, setTab] = useState<HwTab>('pcb')
  const [addOpen, setAddOpen] = useState(false)
  const exportBusyRef = useRef(false)
  const root = props.workspaceRoot

  // 工作区绑定:root 变化重置并首评;面板重挂载且尚无结果时自动评估
  useEffect(() => {
    ensureHardwareWorkspace(root)
    if (!root) return
    const s = hardwareStore.get()
    if (s.circuitJson === null && s.status === 'idle') void evaluateDesign(root)
  }, [root])

  // design/*.tsx|ts 变更 → 800ms 防抖重评估
  useEffect(() => {
    if (!root) return
    let timer = 0
    const off = window.api.onFsEvent((ev) => {
      const p = ev.path.replace(/\\/g, '/')
      if (!p.includes('/design/') || !/\.(tsx|ts)$/i.test(p)) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void evaluateDesign(root)
      }, 800)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [root])

  /** 3D 数据(boardSpec/外壳/屏幕任一变化 → 新引用触发 viewer 重建) */
  const hw3d = useMemo<Hardware3D | null>(() => {
    if (!hw.boardSpec) return null
    return {
      board: hw.boardSpec,
      enclosure: hw.enclosure,
      screen: hw.screen ?? undefined,
      designRoot: root ?? undefined
    }
  }, [hw.boardSpec, hw.enclosure, hw.screen, root])

  /** 哨兵错误码 → i18n(其余原样展示) */
  const errorText = (msg: string): string => {
    if (msg === 'hardware:evalTimeout') return t('hw.errors.evalTimeout')
    if (msg === 'hardware:noBoardEntry') return t('hw.errors.noBoardEntry')
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
      v.setHardware({ board: s.boardSpec, enclosure: s.enclosure, screen: s.screen ?? undefined })
      const files: HardwareExportFile[] = parts.map((part) => ({
        name: STL_FILE_NAME[part],
        dataB64: bufferToB64(v.exportSTL(part))
      }))
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
        return (
          <div className="h-full overflow-y-auto p-3">
            <EnclosureForm root={root} />
          </div>
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
        if (tab === 'pcb') return <PcbTab circuitJson={hw.circuitJson} evalSeq={hw.evalSeq} />
        if (tab === 'schematic') {
          return (
            <div className="h-full w-full overflow-hidden">
              <Suspense fallback={<CenterSpinner />}>
                <SchematicViewerLazy
                  key={hw.evalSeq}
                  circuitJson={hw.circuitJson as unknown as SchCircuitJson}
                  containerStyle={{ height: '100%', width: '100%' }}
                />
              </Suspense>
            </div>
          )
        }
        return (
          <View3DTab
            hw3d={hw3d}
            explode={hw.explode}
            onToggleExplode={() => hardwareStore.set({ explode: hw.explode === 1 ? 0 : 1 })}
          />
        )
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-ink-700 px-2">
        <button
          onClick={() => {
            if (root) void evaluateDesign(root)
          }}
          disabled={!root || hw.status === 'evaluating'}
          title={t('hw.toolbar.runHint')}
          className="flex h-7 items-center gap-1.5 rounded px-2 text-[13px] text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:cursor-not-allowed disabled:text-ink-500"
        >
          {hw.status === 'evaluating' ? (
            <LuLoaderCircle className="animate-spin text-accent" />
          ) : (
            <LuPlay className="text-green-500" />
          )}
          <span>{t('hw.toolbar.run')}</span>
        </button>

        {/* tab 切换(分段控件) */}
        <div className="ml-1 flex items-center gap-0.5 rounded bg-ink-850 p-0.5">
          {TAB_IDS.map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded px-2 py-0.5 text-[12px] ${
                tab === id ? 'bg-ink-700 text-jb-text' : 'text-jb-muted hover:text-jb-text'
              }`}
            >
              {t(`hw.tabs.${id}`)}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setAddOpen(true)}
            disabled={!ready}
            title={t('hw.toolbar.addToSimHint')}
            className="flex h-7 items-center gap-1.5 rounded px-2 text-[13px] text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:cursor-not-allowed disabled:text-ink-500"
          >
            <LuMonitorSmartphone className="text-[13px]" />
            <span>{t('hw.toolbar.addToSim')}</span>
          </button>
          <MenuButton align="right" items={exportItems} disabled={!ready} title={t('hw.toolbar.export')}>
            <LuDownload className="text-[13px]" />
            <span>{t('hw.toolbar.export')}</span>
            <LuChevronDown className="text-[10px]" />
          </MenuButton>
        </div>
      </div>

      {/* 评估失败常驻横幅(外壳/打印 tab 下也可见) */}
      {hw.status === 'error' && hw.error && (tab === 'enclosure' || tab === 'print') && (
        <div className="selectable shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-400">
          {errorText(hw.error)}
        </div>
      )}

      {/* 内容区 */}
      <div className="min-h-0 flex-1">{renderTab()}</div>

      {addOpen && root && <AddDeviceDialog workspaceRoot={root} onClose={() => setAddOpen(false)} />}
    </div>
  )
}
