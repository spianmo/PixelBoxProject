/**
 * IDE 根组件(JetBrains/Android Studio New UI 风格布局)
 *
 * 结构:自绘标题栏(40px)
 *       ├ 左工具窗轨道(44px:项目/设备管理器 · 构建/日志/问题)
 *       ├ 左=项目树 | 中=编辑器多标签 | 右=「运行的设备」 | 底=「日志/构建/问题」
 *       ├ 右工具窗轨道(44px:运行的设备)
 *       └ 状态栏(26px)
 * 全部工具窗可拖拽调宽/高、可折叠;Cmd+P 快速打开文件
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LuCircuitBoard,
  LuColumns2,
  LuEye,
  LuFolderOpen,
  LuFolderTree,
  LuHammer,
  LuListTree,
  LuMonitorSmartphone,
  LuPencil,
  LuScrollText,
  LuSmartphone,
  LuSquareTerminal,
  LuTriangleAlert
} from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { SimDeviceTag, SimManifest } from './device-sim/types'
import type {
  DevdDevice,
  FirmwareTaskKind,
  FirmwareTaskResult,
  ProjectCreateResult,
  ProjectKind
} from '../../shared/ipc-types'
import { reloadRunningSessions, useAnySimRunning } from './device-sim'
import { EditorHost, type EditorHostHandle } from './editor/EditorHost'
import { FileTree } from './components/FileTree'
import { EditorTabs, type TabInfo } from './components/EditorTabs'
import { DragHandle } from './components/DragHandle'
import { ToastHost, showToast } from './components/toast'
import { ConfirmModal } from './components/Modal'
import { TitleBar } from './shell/TitleBar'
import { StatusBar } from './shell/StatusBar'
import { ToolWindow } from './shell/ToolWindow'
import { ToolWindowRail, type RailItem } from './shell/ToolWindowRail'
import { DockOverlay } from './shell/DockOverlay'
import { FloatPanel } from './shell/FloatPanel'
import {
  initViewModes,
  useViewModes,
  type ToolWindowId,
  type ToolWindowViewMode
} from './shell/viewMode'
import { LogsToolWindow, LogsTabStrip, type BottomTab, type LogLine } from './shell/LogsToolWindow'
import { TerminalHeader, TerminalHeaderActions, TerminalPanel } from './terminal/TerminalToolWindow'
import { initTerminals, setTerminalCwd } from './terminal/store'
import { RunningDevicesPanel } from './shell/RunningDevicesPanel'
import { DeviceManagerPanel } from './shell/DeviceManagerPanel'
import { DeviceWizardHost } from './shell/DeviceWizardModal'
import { QuickOpen } from './shell/QuickOpen'
import { FlashDialog } from './shell/FlashDialog'
import { NewProjectModal } from './shell/NewProjectModal'
import { StructureView } from './editor/StructureView'
import { MarkdownPreview } from './editor/MarkdownPreview'
import { getMdViewMode, setMdViewMode, type MdViewMode } from './editor/mdViewMode'
import {
  CHIP_TARGETS,
  applyDefaultChip,
  chipLabel,
  deviceKey,
  isSimDeviceKey,
  profileByKey,
  refreshDeviceProfiles,
  setChip,
  shellDeviceStore,
  type ChipTarget
} from './shell/store'
import { getAppSettings, subscribeSettings } from './settings/store'
import { loadMainLayout, saveMainLayout } from './shell/layoutState'

const MAX_LOG_LINES = 2000

/** 硬件设计工具窗(three.js/tscircuit 重资产,懒加载保持启动 chunk 干净) */
const HardwareDesignPanel = lazy(() =>
  import('./hardware/HardwareDesignPanel').then((m) => ({ default: m.HardwareDesignPanel }))
)

/** 启动恢复只跑一次(StrictMode 双挂载 / 热重载防重入) */
let sessionRestoreStarted = false

/** 左侧工具窗:项目树 / 设备管理器(阶段 2) */
type LeftTool = 'project' | 'devices' | null

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 覆盖式停靠模式(Dock Unpinned / Undock 都以覆盖层呈现,区别仅在外点是否自动收起) */
function isOverlayMode(m: ToolWindowViewMode): boolean {
  return m === 'dockUnpinned' || m === 'undock'
}

/** 体积友好显示(通知 / 构建汇报) */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export default function App(): React.JSX.Element {
  const { t } = useTranslation()

  // ---- 布局尺寸 / 工具窗开关 ----
  // 初值 = 上次布局(localStorage,「恢复上次会话」关闭时为默认布局;
  // main.tsx 已等设置镜像就绪,此处同步读取即真实开关值)
  const initialLayout = useRef(loadMainLayout()).current
  const [leftWidth, setLeftWidth] = useState(initialLayout.leftWidth)
  // 430 = 368px 屏幕 1x 整数缩放 + 白框与边距(device-sim 需要)
  const [rightWidth, setRightWidth] = useState(initialLayout.rightWidth)
  const [bottomHeight, setBottomHeight] = useState(initialLayout.bottomHeight)
  const [leftTool, setLeftTool] = useState<LeftTool>(initialLayout.leftTool)
  const [rightOpen, setRightOpen] = useState(initialLayout.rightOpen)
  // 右侧槽位当前工具(运行的设备 ⇄ 硬件设计,单槽仲裁同底部 bottomView;
  // hardware 仅 hardware 工程可见,不持久化 —— 重启回「运行的设备」避免与工程类型错位)
  const [rightView, setRightView] = useState<'running' | 'hardware'>('running')
  const [bottomOpen, setBottomOpen] = useState(initialLayout.bottomOpen)
  const [bottomTab, setBottomTab] = useState<BottomTab>(initialLayout.bottomTab)
  // 底部区当前视图:日志/构建/问题 窗 ⇄ 终端窗(切换互不销毁,见底部渲染)
  const [bottomView, setBottomView] = useState<'logs' | 'terminal'>(initialLayout.bottomView)
  // 终端窗是否打开过(打开过即保持挂载,隐藏用 CSS,xterm 会话常驻;
  // 上次退出时开着终端则恢复挂载,分栏树形状由 terminal/store.ts 还原)
  const [terminalOpened, setTerminalOpened] = useState(initialLayout.terminalOpened)
  // 终端浮动面板可见性(视图模式 float 时脱离底部槽位仲裁,可与日志窗同时显示)
  const [termFloatVisible, setTermFloatVisible] = useState(false)

  // ---- 工具窗视图模式(五态;模式与 Float 矩形持久化在 shell/viewMode.ts) ----
  const viewModes = useViewModes()
  // 覆盖式停靠层 DOM(Dock Unpinned 外点自动收起的 contains 判定)
  const leftOverlayRef = useRef<HTMLDivElement>(null)
  const rightOverlayRef = useRef<HTMLDivElement>(null)
  const bottomOverlayRef = useRef<HTMLDivElement>(null)
  const [quickOpenVisible, setQuickOpenVisible] = useState(false)
  // 结构视图(左侧面板下分栏;允许只开结构)
  const [structureOpen, setStructureOpen] = useState(initialLayout.structureOpen)
  const [structTopHeight, setStructTopHeight] = useState(initialLayout.structTopHeight)

  // 布局变化 → localStorage 去抖落盘(下次启动经 loadMainLayout 恢复)
  useEffect(() => {
    saveMainLayout({
      leftWidth,
      rightWidth,
      bottomHeight,
      structTopHeight,
      leftTool,
      structureOpen,
      rightOpen,
      bottomOpen,
      bottomView,
      bottomTab,
      terminalOpened
    })
  }, [
    leftWidth,
    rightWidth,
    bottomHeight,
    structTopHeight,
    leftTool,
    structureOpen,
    rightOpen,
    bottomOpen,
    bottomView,
    bottomTab,
    terminalOpened
  ])

  // ---- 工作区 / 编辑器 ----
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())
  const [closingDirty, setClosingDirty] = useState<string | null>(null)
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null)
  const editorRef = useRef<EditorHostHandle>(null)

  // ---- 日志 / 问题 ----
  const [appLogs, setAppLogs] = useState<LogLine[]>([])
  const [buildLogs, setBuildLogs] = useState<LogLine[]>([])
  const [problems, setProblems] = useState<string[]>([])

  // ---- 运行 / 后台任务 ----
  // 阶段 2 多实例:运行态 = 任一模拟器会话在运行(会话/引擎状态由 device-sim sessions 管理)
  const running = useAnySimRunning()
  const runningRef = useRef(false)
  runningRef.current = running
  const [busy, setBusy] = useState<'build' | 'push' | null>(null)
  const [pushPercent, setPushPercent] = useState(-1)
  const workspaceRootRef = useRef<string | null>(null)
  workspaceRootRef.current = workspaceRoot

  // ---- 工程类型(IDE v3:app/firmware/hardware 门控矩阵 §5 的数据源) ----
  const [projectKind, setProjectKind] = useState<ProjectKind | null>(null)
  const projectKindRef = useRef<ProjectKind | null>(null)
  projectKindRef.current = projectKind
  /** project:info 请求序号(快速切换工作区时丢弃过期结果) */
  const projectInfoSeqRef = useRef(0)

  /** 读取工作区项目信息:kind 存 state 供门控;manifest.chip 合法时同步外壳芯片选择 */
  const refreshProjectInfo = useCallback(async (root: string): Promise<void> => {
    const seq = ++projectInfoSeqRef.current
    try {
      const info = await window.api.projectInfo(root)
      if (seq !== projectInfoSeqRef.current) return
      setProjectKind(info.kind)
      // 固件/硬件工程打开时按 manifest.chip 切换目标芯片(非法值忽略)
      if (info.chip && (CHIP_TARGETS as readonly string[]).includes(info.chip)) {
        setChip(info.chip as ChipTarget)
      }
    } catch {
      if (seq === projectInfoSeqRef.current) setProjectKind(null)
    }
  }, [])

  // ---- 固件工具链(阶段 3):任务状态 / 烧录对话框 ----
  const [fwTask, setFwTask] = useState<FirmwareTaskKind | null>(null)
  const [flashOpen, setFlashOpen] = useState(false)
  // 新建项目向导
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  // Markdown 查看模式(仅活动文件为 md 时生效;切文件时从记忆恢复)
  const [mdMode, setMdModeState] = useState<MdViewMode>('split')
  /** 烧录默认波特率(设置页持久化;打开烧录对话框时刷新) */
  const [defaultBaud, setDefaultBaud] = useState(460800)

  /** 打开底部区并切到指定日志类 tab(视图切回日志窗;终端窗状态保留) */
  const openBottomTab = useCallback((tab: BottomTab): void => {
    setBottomView('logs')
    setBottomTab(tab)
    setBottomOpen(true)
  }, [])

  const appendLog = useCallback((target: 'app' | 'build', line: LogLine | LogLine[]): void => {
    const add = Array.isArray(line) ? line : [line]
    if (add.length === 0) return
    const setter = target === 'app' ? setAppLogs : setBuildLogs
    setter((prev) => {
      const next = [...prev, ...add]
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
    })
  }, [])

  // ---- 全局事件订阅 ----
  useEffect(() => {
    const unsubs: Array<() => void> = []

    // 构建日志 → 构建输出页
    unsubs.push(
      window.api.onBuildLog((line) => appendLog('build', { level: line.level, text: line.text, ts: line.ts }))
    )

    // watch 重建完成 → 全部运行中的会话热重载 + 问题列表
    unsubs.push(
      window.api.onBuildDone((result) => {
        setProblems(result.errors)
        if (!runningRef.current) return
        const root = workspaceRootRef.current
        if (result.success && result.code && result.manifest && result.outDir && root) {
          // device-sim 运行上下文(引擎据此预载 dist/ 与定位存储目录;
          // 多实例:同一 bundle 对所有运行中的虚拟设备热重载)
          window.__pixelboxSimContext = { workspaceRoot: root, outDir: result.outDir }
          void reloadRunningSessions(result.code, result.manifest as SimManifest).then(() => {
            showToast(t('run.reloaded'), 'success')
          })
        }
      })
    )

    // 固件工具链输出流(idf.py/esptool,批量行)→ 构建输出页(ANSI 解析在渲染层)
    unsubs.push(
      window.api.onFirmwareLog((lines) =>
        appendLog(
          'build',
          lines.map((l) => ({ level: l.level, text: l.text, ts: l.ts }))
        )
      )
    )

    // 固件任务结束 → 解锁按钮 + 按类型通知(打包通知含产物路径与大小)
    unsubs.push(
      window.api.onFirmwareDone((r: FirmwareTaskResult) => {
        setFwTask(null)
        const chip = chipLabel(r.target)
        if (r.cancelled) {
          showToast(t('fw.cancelled', { kind: t(`fw.kind.${r.kind}`) }), 'warn')
          return
        }
        if (!r.success) {
          showToast(t('fw.failed', { kind: t(`fw.kind.${r.kind}`), chip }), 'error')
          return
        }
        if (r.kind === 'build') {
          const bin = r.artifacts[0]
          showToast(
            bin
              ? t('fw.buildDone', { chip, name: baseName(bin.path), size: fmtSize(bin.sizeBytes) })
              : t('fw.buildDoneBare', { chip }),
            'success'
          )
        } else if (r.kind === 'merge') {
          const merged = r.artifacts.find((a) => a.path.endsWith('-merged.bin'))
          showToast(
            merged
              ? t('fw.mergeDone', { path: merged.path, size: fmtSize(merged.sizeBytes) })
              : t('fw.buildDoneBare', { chip }),
            'success'
          )
        } else if (r.kind === 'flash') {
          showToast(t('fw.flashDone', { chip }), 'success')
        } else {
          showToast(t('fw.cleanDone', { chip }), 'success')
        }
      })
    )

    // 设备实时发现 → 外壳共享 store(标题栏/日志/状态栏联动)
    unsubs.push(window.api.onDevdDevices((list) => shellDeviceStore.set({ devices: list })))

    // 推送进度
    unsubs.push(
      window.api.onPushProgress((p) => {
        setPushPercent(p.phase === 'done' || p.phase === 'error' ? -1 : p.percent)
      })
    )

    // 模拟器应用日志(device-sim 引擎经 CustomEvent 上报;detail 附带来源设备标签,
    // 底部日志按设备下拉路由,见 LogsToolWindow)
    const onSimLog = (ev: WindowEventMap['pixelbox-sim:log']): void => {
      const tag = ev.detail as typeof ev.detail & SimDeviceTag
      appendLog('app', {
        level: ev.detail.level,
        text: ev.detail.text,
        ts: ev.detail.ts,
        deviceKey: tag.deviceKey
      })
    }
    // 运行态由 useAnySimRunning 订阅会话得出;这里只处理崩溃提示
    const onSimState = (ev: WindowEventMap['pixelbox-sim:state']): void => {
      if (ev.detail.state === 'crashed') {
        const tag = ev.detail as typeof ev.detail & SimDeviceTag
        const who = tag.deviceName ? `[${tag.deviceName}] ` : ''
        showToast(`${who}${t('common.error')}: ${ev.detail.error ?? 'crashed'}`, 'error')
      }
    }
    window.addEventListener('pixelbox-sim:log', onSimLog)
    window.addEventListener('pixelbox-sim:state', onSimState)
    unsubs.push(() => window.removeEventListener('pixelbox-sim:log', onSimLog))
    unsubs.push(() => window.removeEventListener('pixelbox-sim:state', onSimState))

    // 外部文件变更 → 干净的已打开文件自动重载;
    // pixelbox.json 变更 → 重取项目信息(工程类型/芯片门控联动)
    unsubs.push(
      window.api.onFsEvent((ev) => {
        if (ev.type === 'change') void editorRef.current?.reloadIfClean(ev.path)
        if (ev.path.endsWith('pixelbox.json')) {
          const root = workspaceRootRef.current
          if (root) void refreshProjectInfo(root)
        }
      })
    )

    return () => unsubs.forEach((u) => u())
  }, [appendLog, refreshProjectInfo, t])

  // 集成终端:事件订阅 + renderer 重载后恢复 main 进程存活会话(幂等)
  useEffect(() => {
    initTerminals()
  }, [])

  // 视图模式:独立窗口关闭回 Dock Pinned + renderer 重载后 toolwindow:list 对账(幂等)
  useEffect(() => {
    initViewModes()
  }, [])

  // 终端视图模式切换的槽位联动:
  // - float:离开底部槽位仲裁(bottomView 回日志),浮动面板立即可见
  // - window:主窗不再渲染(独立窗口接管;数据在 main 侧全窗口广播)
  // - 回停靠系(独立窗口关闭 / 手动切回):回底部槽位并展开
  const bottomViewRef = useRef(bottomView)
  bottomViewRef.current = bottomView
  const prevTermModeRef = useRef(viewModes.terminal)
  useEffect(() => {
    const prev = prevTermModeRef.current
    const cur = viewModes.terminal
    if (prev === cur) return
    prevTermModeRef.current = cur
    if (cur === 'float') {
      setTerminalOpened(true)
      setTermFloatVisible(true)
      if (bottomViewRef.current === 'terminal') setBottomView('logs')
    } else if (cur === 'window') {
      setTermFloatVisible(false)
      if (bottomViewRef.current === 'terminal') setBottomView('logs')
    } else if (prev === 'float' || prev === 'window') {
      setTerminalOpened(true)
      setTermFloatVisible(false)
      setBottomView('terminal')
      setBottomOpen(true)
    }
  }, [viewModes.terminal])

  // 新终端会话的 cwd 跟随当前工作区根(无工作区回退 HOME)
  useEffect(() => {
    setTerminalCwd(workspaceRoot)
  }, [workspaceRoot])

  // 启动时先扫一轮设备 + 加载虚拟设备档案(设备管理器数据源)
  useEffect(() => {
    void refreshDevices()
    void refreshDeviceProfiles()
    // 固件任务状态恢复(renderer 重载时任务可能仍在 main 进程运行)
    window.api
      .firmwareStatus()
      .then((s) => setFwTask(s.running))
      .catch(() => undefined)
    // eslint 无此工程:仅首挂载执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // IDE 设置镜像消费(settings:changed 即时生效,无需重启):
  // 默认目标芯片(标题栏芯片下拉,本地无记忆时生效)+ 烧录默认波特率
  useEffect(() => {
    const apply = (): void => {
      const s = getAppSettings().toolchain
      applyDefaultChip(s.defaultTarget)
      setDefaultBaud(s.baudRate)
    }
    apply()
    return subscribeSettings(apply)
  }, [])

  // 所有会话都停止(逐 tab 关闭 / 崩溃)后,同步停掉 watch 重建
  const prevRunningRef = useRef(false)
  useEffect(() => {
    if (prevRunningRef.current && !running) void window.api.buildWatchStop()
    prevRunningRef.current = running
  }, [running])

  // 全局快捷键(capture 阶段拦截,避免 Monaco 吃掉按键;键位表见 设置 › 快捷键):
  // ⌘/Ctrl+P 快速打开;运行 ⌃R(mac)/ Shift+F10;停止 ⌘F2(mac)/ Ctrl+F2
  const runShortcutRef = useRef<() => void>(() => {})
  const stopShortcutRef = useRef<() => void>(() => {})
  useEffect(() => {
    const isMac = window.api.platform === 'darwin'
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        setQuickOpenVisible((v) => !v)
        return
      }
      // 运行(JetBrains 默认键位):macOS ⌃R;其他平台 ⇧F10
      const runHit = isMac
        ? e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r'
        : e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'F10'
      if (runHit) {
        e.preventDefault()
        e.stopPropagation()
        runShortcutRef.current()
        return
      }
      // 停止:macOS ⌘F2;其他平台 Ctrl+F2
      const stopHit = isMac
        ? e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'F2'
        : e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'F2'
      if (stopHit) {
        e.preventDefault()
        e.stopPropagation()
        stopShortcutRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // git 分支:打开工作区时读取,之后 8s 轮询(切分支/提交后自动跟随)
  useEffect(() => {
    if (!workspaceRoot) {
      setGitBranch(null)
      return
    }
    let alive = true
    const refresh = async (): Promise<void> => {
      const b = await window.api.gitBranch(workspaceRoot)
      if (alive) setGitBranch(b)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 8000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [workspaceRoot])

  // ---- 动作 ----

  async function refreshDevices(): Promise<void> {
    shellDeviceStore.set({ scanning: true })
    try {
      shellDeviceStore.set({ devices: await window.api.devdDiscover(3000) })
    } catch {
      // mDNS 失败静默(无网卡等)
    } finally {
      shellDeviceStore.set({ scanning: false })
    }
  }

  /** 切换到新工作区(重置编辑器 / 停止运行 / 开启监听) */
  const applyWorkspace = useCallback(
    async (root: string): Promise<void> => {
      for (const tab of tabs) editorRef.current?.closeFile(tab.path)
      setTabs([])
      setActivePath(null)
      setCursor(null)
      setDirtyPaths(new Set())
      if (running) handleStop()
      setWorkspaceRoot(root)
      setProjectKind(null) // 先复位门控,project:info 返回后按真实类型放开
      setLeftTool('project')
      await window.api.watchWorkspace(root)
      await refreshProjectInfo(root)
    },
    // eslint 无此工程:handleStop 为组件内函数,依赖 tabs/running 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, running]
  )
  // 启动恢复 / 冒烟钩子经 ref 调用(挂载一次的 effect 不依赖其闭包版本)
  const applyWorkspaceRef = useRef(applyWorkspace)
  applyWorkspaceRef.current = applyWorkspace

  // ---- 会话恢复:编辑器会话(标签 / 激活 / viewState)去抖推送 main 落盘 ----
  // main 侧内存即时 + 500ms 去抖写 sessions/,退出时 close/before-quit 双保险同步兜底
  const sessionReadyRef = useRef(false) // 恢复完成前不推送(避免空初值覆盖上次会话)
  const sessionSaveTimerRef = useRef<number | null>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activePathValRef = useRef(activePath)
  activePathValRef.current = activePath

  const pushSessionUpdate = useCallback((): void => {
    const root = workspaceRootRef.current
    if (!root) {
      window.api.sessionUpdate({ workspaceRoot: null }) // 欢迎页:启动不再恢复工作区
      return
    }
    window.api.sessionUpdate({
      workspaceRoot: root,
      session: {
        root,
        // 脏文件内容不落盘(以保存过的为准),只记路径与 viewState(滚动/光标)
        tabs: tabsRef.current.map((tb) => ({
          path: tb.path,
          viewState: editorRef.current?.getViewState(tb.path) ?? null
        })),
        activePath: activePathValRef.current,
        savedAt: Date.now()
      }
    })
  }, [])

  const scheduleSessionSave = useCallback((): void => {
    if (!sessionReadyRef.current) return
    if (sessionSaveTimerRef.current !== null) window.clearTimeout(sessionSaveTimerRef.current)
    sessionSaveTimerRef.current = window.setTimeout(() => {
      sessionSaveTimerRef.current = null
      pushSessionUpdate()
    }, 600)
  }, [pushSessionUpdate])

  // 标签 / 激活 / 工作区 / 光标变化 → 去抖推送(滚动经 EditorHost onViewStateChange)
  useEffect(() => {
    scheduleSessionSave()
  }, [tabs, activePath, workspaceRoot, cursor, scheduleSessionSave])

  // ---- 会话恢复:启动时重开上次工作区 + 编辑器标签(受「恢复上次会话」开关控制) ----
  useEffect(() => {
    if (sessionRestoreStarted) return
    sessionRestoreStarted = true
    void (async () => {
      try {
        const info = await window.api.sessionStartup()
        if (!info.restore) {
          window.api.sessionReport('恢复未启用(设置关闭)→ 默认布局欢迎页')
          return
        }
        if (info.lastWorkspaceMissing) {
          showToast(t('session.workspaceGone'), 'warn')
          window.api.sessionReport('上次工作区已不存在 → 欢迎页(已通知)')
          return
        }
        if (!info.lastWorkspace) {
          window.api.sessionReport('无上次工作区记录 → 欢迎页')
          return
        }
        // 计入最近列表 + 二次存在性校验(与手动打开同链路)
        const root = await window.api.openWorkspacePath(info.lastWorkspace)
        if (!root) {
          showToast(t('session.workspaceGone'), 'warn')
          window.api.sessionReport('上次工作区已不存在 → 欢迎页(已通知)')
          return
        }
        await applyWorkspaceRef.current(root)
        let opened = 0
        let skipped = 0
        const restoredTabs: TabInfo[] = []
        for (const tab of info.session?.tabs ?? []) {
          try {
            await editorRef.current?.openFile(tab.path)
            if (tab.viewState) editorRef.current?.restoreViewState(tab.path, tab.viewState)
            restoredTabs.push({ path: tab.path, name: baseName(tab.path) })
            opened++
          } catch {
            skipped++ // 文件已删除:静默跳过
          }
        }
        let active: string | null = null
        if (restoredTabs.length > 0) {
          setTabs(restoredTabs)
          const wanted = info.session?.activePath
          active =
            wanted && restoredTabs.some((tb) => tb.path === wanted)
              ? wanted
              : restoredTabs[restoredTabs.length - 1].path
          setActivePath(active)
          editorRef.current?.setActive(active)
        }
        window.api.sessionReport(
          `已恢复工作区 ${root}:标签 ${opened} 个(缺失跳过 ${skipped}),激活 ${active ? baseName(active) : '(无)'}`
        )
      } catch (err) {
        window.api.sessionReport(
          `恢复失败(回欢迎页):${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        sessionReadyRef.current = true // 恢复流程结束后才开始记录新会话
      }
    })()
    // eslint 无此工程:仅首挂载执行一次(模块级 sessionRestoreStarted 防重入)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 冒烟钩子(PIXELBOX_SMOKE_SESSION=1):main 请求打开指定工作区与文件,
  // 走与用户操作完全相同的链路(openWorkspacePath → applyWorkspace → openFile)
  useEffect(() => {
    return window.api.onSmokeSessionPrepare(({ root, file }) => {
      void (async () => {
        const r = await window.api.openWorkspacePath(root)
        if (!r) return
        await applyWorkspaceRef.current(r)
        handleOpenFile(file)
        window.api.sessionReport(`冒烟准备:已打开工作区 ${r} 与文件 ${file}`)
      })()
    })
    // eslint 无此工程:handleOpenFile 为稳定 useCallback,仅首挂载订阅一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleOpenWorkspace(): Promise<void> {
    const root = await window.api.openWorkspace()
    if (!root) return
    await applyWorkspace(root)
  }

  async function handleOpenWorkspacePath(path: string): Promise<void> {
    const root = await window.api.openWorkspacePath(path)
    if (!root) {
      showToast(t('titlebar.workspaceGone'), 'warn')
      return
    }
    await applyWorkspace(root)
  }

  /**
   * 新建项目向导创建成功:作为工作区打开(计入最近列表)+ 编辑器打开入口文件
   * (app=src/main.ts / firmware=main/main.c / hardware=design/board.tsx)
   */
  async function handleProjectCreated(result: ProjectCreateResult): Promise<void> {
    setNewProjectOpen(false)
    const root = await window.api.openWorkspacePath(result.root)
    if (!root) return
    await applyWorkspace(root)
    setProjectKind(result.kind) // 创建结果即时门控(project:info 兜底确认)
    handleOpenFile(result.entryFile)
  }

  const handleOpenFile = useCallback((path: string): void => {
    setTabs((prev) => (prev.some((tb) => tb.path === path) ? prev : [...prev, { path, name: baseName(path) }]))
    setActivePath(path)
    void editorRef.current?.openFile(path)
  }, [])

  const closeTab = useCallback((path: string): void => {
    editorRef.current?.closeFile(path)
    setDirtyPaths((prev) => {
      if (!prev.has(path)) return prev
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    setTabs((prev) => {
      const idx = prev.findIndex((tb) => tb.path === path)
      const next = prev.filter((tb) => tb.path !== path)
      setActivePath((cur) => {
        if (cur !== path) return cur
        const fallback = next[Math.min(idx, next.length - 1)]
        if (fallback) {
          editorRef.current?.setActive(fallback.path)
          return fallback.path
        }
        setCursor(null)
        return null
      })
      return next
    })
  }, [])

  const handleCloseTab = useCallback(
    (path: string): void => {
      if (dirtyPaths.has(path)) setClosingDirty(path)
      else closeTab(path)
    },
    [dirtyPaths, closeTab]
  )

  const handleDirtyChange = useCallback((path: string, dirty: boolean): void => {
    setDirtyPaths((prev) => {
      if (prev.has(path) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  /** 文件被删除或重命名:关闭对应标签 */
  const handleFileRemoved = useCallback(
    (path: string): void => {
      setTabs((prev) => {
        if (!prev.some((tb) => tb.path === path)) return prev
        closeTab(path)
        return prev
      })
    },
    [closeTab]
  )

  // ---- Markdown 查看模式(编辑 / 分屏 / 预览,记忆每文件,默认分屏) ----
  const isMdFile = activePath !== null && /\.(md|markdown)$/i.test(activePath)

  // 切换活动文件时从记忆恢复该文件的模式
  useEffect(() => {
    if (activePath && /\.(md|markdown)$/i.test(activePath)) setMdModeState(getMdViewMode(activePath))
  }, [activePath])

  const changeMdMode = useCallback(
    (mode: MdViewMode): void => {
      if (!activePath) return
      setMdModeState(mode)
      setMdViewMode(activePath, mode)
    },
    [activePath]
  )

  /**
   * 启动固件任务(阶段 3:🔨 构建 / ⋮ 打包 merged.bin / 烧录 / 清理;
   * 目标 = 标题栏芯片下拉 shellDeviceStore.chip,按芯片名传参 idf.py)
   */
  const startFirmwareTask = useCallback(
    async (kind: FirmwareTaskKind, port?: string, baud?: number): Promise<void> => {
      // §5 门控:固件任务仅固件工程可用(渲染端唯一闸口;main 端 cwd 校验兜底)
      if (projectKindRef.current !== 'firmware') {
        showToast(t('fw.errors.notFirmwareProject'), 'warn')
        return
      }
      const target = shellDeviceStore.get().chip
      openBottomTab('build')
      setFwTask(kind) // 先置忙防重入(双击/菜单连点)
      try {
        // cwd = 当前工作区(IDE v3:固件任务作用于工作区工程,不再指向 monorepo firmware/)
        await window.api.firmwareStart({
          kind,
          target,
          port,
          baud,
          cwd: workspaceRootRef.current ?? undefined
        })
      } catch (err) {
        setFwTask(null)
        const msg = err instanceof Error ? err.message : String(err)
        const code = /toolchain:(\w+)/.exec(msg)?.[1] ?? 'startFailed'
        showToast(t(`fw.errors.${code}`, { defaultValue: t('fw.errors.startFailed') }), 'error')
      }
    },
    [t, openBottomTab]
  )

  /** 烧录…:先按设置镜像刷新默认波特率再打开端口选择对话框 */
  function handleFirmwareFlashOpen(): void {
    setDefaultBaud(getAppSettings().toolchain.baudRate)
    setFlashOpen(true)
  }

  /** 取消进行中的固件任务(main 进程杀进程树,结束经 onFirmwareDone 回报) */
  function handleFirmwareCancel(): void {
    void window.api.firmwareCancel()
  }

  async function handleRun(): Promise<void> {
    const root = workspaceRootRef.current
    if (!root) {
      showToast(t('run.noWorkspace'), 'warn')
      return
    }
    // 运行/推送按 key 分流:选中真机时 ▶ 等价于推送(与 AS 部署到所选设备一致)
    const devState = shellDeviceStore.get()
    if (!isSimDeviceKey(devState.selectedKey)) {
      await handlePush()
      return
    }
    // 目标虚拟设备档案(设备管理器数据源;key 失效时 store 已回退内置档案)
    const profile = profileByKey(devState.selectedKey)
    if (!profile) {
      showToast(t('run.noProfile'), 'warn')
      return
    }
    openBottomTab('build')
    await editorRef.current?.saveAll() // 运行前自动保存
    setBusy('build')
    let result: Awaited<ReturnType<typeof window.api.build>>
    try {
      result = await window.api.build(root)
    } finally {
      setBusy(null)
    }
    setProblems(result.errors)
    if (!result.success || !result.code || !result.manifest || !result.outDir) {
      showToast(t('run.buildFailed'), 'error')
      return
    }
    const sim = window.__pixelboxSim
    if (!sim) {
      showToast(t('run.simMissing'), 'warn')
      return
    }
    try {
      // device-sim 运行上下文(引擎据此预载 dist/ 与定位存储目录;
      // device = 目标档案,facade 据此创建/复用对应会话 tab,多设备可并行)
      window.__pixelboxSimContext = { workspaceRoot: root, outDir: result.outDir, device: profile }
      await sim.load(result.code, result.manifest as SimManifest)
      setRightView('running')
      setRightOpen(true)
      openBottomTab('logs')
      showToast(t('run.startedOn', { name: profile.name }), 'success')
      await window.api.buildWatchStart(root) // 开启 watch 热重载
    } catch (err) {
      showToast(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  function handleStop(): void {
    window.__pixelboxSim?.stop() // 停止全部会话(逐 tab 的 ✕ 只关单个)
    void window.api.buildWatchStop()
    showToast(t('run.stopped'), 'info')
  }

  // 快捷键 → 动作(经 ref 桥接:capture 监听器仅挂载一次;禁用态与标题栏按钮一致,
  // ▶ 与门控矩阵 §5 同步:仅 app 工程与传统目录可运行)
  runShortcutRef.current = () => {
    const kind = projectKindRef.current
    if (busy !== 'build' && (kind === 'app' || kind === null)) void handleRun()
  }
  stopShortcutRef.current = () => {
    if (running) handleStop()
  }

  /** 推送到指定真机;缺省 target 时按设备下拉当前选中的真机 */
  async function handlePush(target?: DevdDevice): Promise<void> {
    const root = workspaceRootRef.current
    if (!root) {
      showToast(t('run.noWorkspace'), 'warn')
      return
    }
    const devState = shellDeviceStore.get()
    const dev =
      target ??
      (isSimDeviceKey(devState.selectedKey)
        ? undefined
        : devState.devices.find((d) => deviceKey(d) === devState.selectedKey))
    if (!dev) {
      showToast(t('push.noDevice'), 'warn')
      return
    }
    openBottomTab('build')
    await editorRef.current?.saveAll()
    setBusy('push')
    setPushPercent(0)
    try {
      await window.api.devdPush({ root, host: dev.ip || dev.host, port: dev.port })
      showToast(t('push.done'), 'success')
    } catch (err) {
      showToast(t('push.failed', { message: err instanceof Error ? err.message : String(err) }), 'error')
    } finally {
      setBusy(null)
      setPushPercent(-1)
    }
  }

  /**
   * 标题栏「推送到设备」(仅 app 工程,§5):
   * 选中真机 → 直推;选中虚拟设备 → 先扫一轮 devd,推给首台发现的真机,无则提示
   */
  async function handlePushToDevice(): Promise<void> {
    if (!isSimDeviceKey(shellDeviceStore.get().selectedKey)) {
      await handlePush()
      return
    }
    await refreshDevices() // 复用现有发现链路(结果写入 shellDeviceStore)
    const found = shellDeviceStore.get().devices
    if (found.length === 0) {
      showToast(t('titlebar.pushNoDevice'), 'warn')
      return
    }
    await handlePush(found[0])
  }

  // ---- 工具窗轨道条目 ----

  const leftRailTop: RailItem[] = [
    {
      key: 'project',
      icon: <LuFolderTree />,
      label: t('rail.project'),
      active: leftTool === 'project',
      onClick: () => setLeftTool((v) => (v === 'project' ? null : 'project'))
    },
    {
      // 结构视图:左侧面板下分栏(与项目树/设备管理器可同开,也允许只开结构)
      key: 'structure',
      icon: <LuListTree />,
      label: t('rail.structure'),
      active: structureOpen,
      onClick: () => setStructureOpen((v) => !v)
    },
    {
      key: 'devices',
      icon: <LuMonitorSmartphone />,
      label: t('rail.devices'),
      active: leftTool === 'devices',
      onClick: () => setLeftTool((v) => (v === 'devices' ? null : 'devices'))
    }
  ]

  const toggleBottom = (tab: BottomTab): void => {
    if (bottomOpen && bottomView === 'logs' && bottomTab === tab) setBottomOpen(false)
    else openBottomTab(tab)
  }

  /**
   * 终端窗开关,按视图模式分流:
   * - window:聚焦独立窗口(main 侧幂等)
   * - float:开关浮动面板(不参与底部槽位仲裁,可与日志窗并存)
   * - 停靠系:底部区在 日志/构建/问题 窗与终端窗之间切换,状态互不销毁
   */
  const toggleTerminal = (): void => {
    if (viewModes.terminal === 'window') {
      void window.api.toolwindowOpen('terminal')
      return
    }
    if (viewModes.terminal === 'float') {
      setTerminalOpened(true)
      setTermFloatVisible((v) => !v)
      return
    }
    if (bottomOpen && bottomView === 'terminal') setBottomOpen(false)
    else {
      setTerminalOpened(true)
      setBottomView('terminal')
      setBottomOpen(true)
    }
  }

  /** 终端轨道图标激活态(独立窗口开着即视为激活) */
  const terminalRailActive =
    viewModes.terminal === 'window'
      ? true
      : viewModes.terminal === 'float'
        ? termFloatVisible
        : bottomOpen && bottomView === 'terminal'

  const leftRailBottom: RailItem[] = [
    {
      key: 'build',
      icon: <LuHammer />,
      label: t('rail.build'),
      active: bottomOpen && bottomView === 'logs' && bottomTab === 'build',
      onClick: () => toggleBottom('build')
    },
    {
      key: 'logs',
      icon: <LuScrollText />,
      label: t('rail.logs'),
      active: bottomOpen && bottomView === 'logs' && bottomTab === 'logs',
      onClick: () => toggleBottom('logs')
    },
    {
      // 集成终端(问题图标上方)
      key: 'terminal',
      icon: <LuSquareTerminal />,
      label: t('rail.terminal'),
      active: terminalRailActive,
      onClick: toggleTerminal
    },
    {
      key: 'problems',
      icon: <LuTriangleAlert />,
      label: t('rail.problems'),
      active: bottomOpen && bottomView === 'logs' && bottomTab === 'problems',
      badge: problems.length,
      onClick: () => toggleBottom('problems')
    }
  ]

  /** 右侧槽位开关(running ⇄ hardware 单槽仲裁,同底部 toggleBottom) */
  const toggleRight = (view: 'running' | 'hardware'): void => {
    if (rightOpen && rightView === view) setRightOpen(false)
    else {
      setRightView(view)
      setRightOpen(true)
    }
  }

  // 工程类型离开 hardware(切工作区/pixelbox.json 改动)→ 收起硬件工具窗(rail 图标同步消失)
  useEffect(() => {
    if (projectKind !== 'hardware' && rightView === 'hardware') {
      setRightView('running')
      setRightOpen(false)
    }
  }, [projectKind, rightView])

  const rightRail: RailItem[] = [
    {
      key: 'running',
      icon: <LuSmartphone />,
      label: t('rail.runningDevices'),
      active: rightOpen && rightView === 'running',
      onClick: () => toggleRight('running')
    },
    // 硬件设计工具窗:仅 hardware 工程显示(§5 门控矩阵)
    ...(projectKind === 'hardware'
      ? [
          {
            key: 'hardware',
            icon: <LuCircuitBoard />,
            label: t('rail.hardware'),
            active: rightOpen && rightView === 'hardware',
            onClick: () => toggleRight('hardware')
          } satisfies RailItem
        ]
      : [])
  ]

  // ---- 视图模式:各工具窗归属位置(停靠槽 / 覆盖层 / 浮动;window 只在独立窗口渲染) ----

  // 左槽当前工具(项目树/设备管理器)与结构视图:pinned 进停靠列,overlay 进左覆盖层
  const leftToolMode: ToolWindowViewMode | null = leftTool ? viewModes[leftTool] : null
  const leftPinnedTool = leftTool !== null && leftToolMode === 'dockPinned' ? leftTool : null
  const leftOverlayTool = leftTool !== null && leftToolMode !== null && isOverlayMode(leftToolMode) ? leftTool : null
  const structPinned = structureOpen && viewModes.structure === 'dockPinned'
  const structOverlay = structureOpen && isOverlayMode(viewModes.structure)

  // 右侧槽位(运行的设备 ⇄ 硬件设计,rightView 仲裁)
  const rightTool: ToolWindowId = rightView
  const rightPinned = rightOpen && viewModes[rightTool] === 'dockPinned'
  const rightOverlay = rightOpen && isOverlayMode(viewModes[rightTool])

  // 底部槽位(bottomView 仲裁);终端 float/window 时脱离仲裁(见 toggleTerminal)
  const bottomDockView: 'logs' | 'terminal' | null = bottomOpen
    ? bottomView === 'logs' && viewModes.logs === 'dockPinned'
      ? 'logs'
      : bottomView === 'terminal' && viewModes.terminal === 'dockPinned'
        ? 'terminal'
        : null
    : null
  const bottomOverlayTool: ToolWindowId | null = bottomOpen
    ? bottomView === 'logs' && isOverlayMode(viewModes.logs)
      ? 'logs'
      : bottomView === 'terminal' && terminalOpened && isOverlayMode(viewModes.terminal)
        ? 'terminal'
        : null
    : null

  // Dock Unpinned:全局 mousedown 外点自动收起(轨道图标 [data-tw-rail] 豁免;
  // Undock 常驻不收;覆盖层内部点击经 contains 判定豁免)
  const leftUnpinnedShown =
    (leftOverlayTool !== null && viewModes[leftOverlayTool] === 'dockUnpinned') ||
    (structOverlay && viewModes.structure === 'dockUnpinned')
  const rightUnpinnedShown = rightOverlay && viewModes[rightTool] === 'dockUnpinned'
  const bottomUnpinnedShown = bottomOverlayTool !== null && viewModes[bottomOverlayTool] === 'dockUnpinned'
  useEffect(() => {
    if (!leftUnpinnedShown && !rightUnpinnedShown && !bottomUnpinnedShown) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('[data-tw-rail]')) return
      if (leftUnpinnedShown && !leftOverlayRef.current?.contains(target)) {
        if (leftOverlayTool !== null && viewModes[leftOverlayTool] === 'dockUnpinned') setLeftTool(null)
        if (structOverlay && viewModes.structure === 'dockUnpinned') setStructureOpen(false)
      }
      if (rightUnpinnedShown && !rightOverlayRef.current?.contains(target)) setRightOpen(false)
      if (bottomUnpinnedShown && !bottomOverlayRef.current?.contains(target)) setBottomOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [leftUnpinnedShown, rightUnpinnedShown, bottomUnpinnedShown, leftOverlayTool, structOverlay, viewModes])

  /**
   * 按 id 渲染工具窗(停靠槽 / 覆盖层 / FloatPanel 三种落点共用同一份内容;
   * dragStart 由 FloatPanel 注入,接到头部空白区拖动)
   */
  const renderTool = (id: ToolWindowId, dragStart?: (e: React.MouseEvent) => void): React.JSX.Element | null => {
    switch (id) {
      case 'project':
      case 'devices':
        return (
          <ToolWindow
            title={id === 'project' ? t('rail.project') : t('rail.devices')}
            icon={id === 'project' ? <LuFolderTree /> : <LuMonitorSmartphone />}
            toolId={id}
            onHeaderMouseDown={dragStart}
            onHide={() => setLeftTool(null)}
          >
            {id === 'project' ? (
              workspaceRoot ? (
                <FileTree
                  root={workspaceRoot}
                  onOpenFile={handleOpenFile}
                  dirtyPaths={dirtyPaths}
                  onFileRemoved={handleFileRemoved}
                  activePath={activePath}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <LuFolderOpen className="text-3xl text-ink-500" />
                  <div className="text-[13px] text-jb-muted">{t('fileTree.empty')}</div>
                  <button
                    className="rounded bg-accent px-3 py-1 text-xs text-white hover:bg-accent-dim"
                    onClick={() => void handleOpenWorkspace()}
                  >
                    {t('titlebar.openWorkspace')}
                  </button>
                </div>
              )
            ) : (
              // 设备管理器(虚拟设备档案表格 + 新建模拟器向导,阶段 2 落地)
              <DeviceManagerPanel />
            )}
          </ToolWindow>
        )
      case 'structure':
        return (
          <ToolWindow
            title={t('rail.structure')}
            icon={<LuListTree />}
            toolId="structure"
            onHeaderMouseDown={dragStart}
            onHide={() => setStructureOpen(false)}
          >
            <StructureView
              path={activePath}
              cursorLine={cursor?.line ?? null}
              onNavigate={(line, column) => editorRef.current?.revealAt(line, column)}
            />
          </ToolWindow>
        )
      case 'running':
        return (
          <ToolWindow
            title={t('rail.runningDevices')}
            icon={<LuSmartphone />}
            toolId="running"
            onHeaderMouseDown={dragStart}
            onHide={() => setRightOpen(false)}
          >
            <RunningDevicesPanel />
          </ToolWindow>
        )
      case 'hardware':
        // 硬件设计(PCB/原理图/3D 外壳/打印,仅 hardware 工程;面板懒加载)
        return (
          <ToolWindow
            title={t('rail.hardware')}
            icon={<LuCircuitBoard />}
            toolId="hardware"
            onHeaderMouseDown={dragStart}
            onHide={() => setRightOpen(false)}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-jb-muted">
                  <VscLoading className="animate-spin text-xl" />
                </div>
              }
            >
              <HardwareDesignPanel workspaceRoot={workspaceRoot} />
            </Suspense>
          </ToolWindow>
        )
      case 'logs':
        return (
          <ToolWindow
            title={t('console.appLog')}
            header={<LogsTabStrip activeTab={bottomTab} problems={problems.length} onTabChange={setBottomTab} />}
            toolId="logs"
            // 「独立窗口」项作用于 构建输出(build:log/toolchain:log 全窗口广播,可跨窗镜像);
            // 日志/问题 tab 状态在主窗 renderer 内,项置灰
            windowToolId="build"
            windowEnabled={bottomTab === 'build'}
            onHeaderMouseDown={dragStart}
            onHide={() => setBottomOpen(false)}
          >
            <LogsToolWindow
              activeTab={bottomTab}
              appLogs={appLogs}
              buildLogs={buildLogs}
              problems={problems}
              onClear={(tab) => (tab === 'logs' ? setAppLogs([]) : setBuildLogs([]))}
            />
          </ToolWindow>
        )
      case 'terminal':
        return (
          <ToolWindow
            title={t('terminal.title')}
            header={<TerminalHeader />}
            // 终端自身 ⋮ 并入视图模式组(viewMode),ToolWindow 不再渲染第二个 ⋮
            actions={<TerminalHeaderActions viewMode />}
            toolId="terminal"
            viewModeButton={false}
            onHeaderMouseDown={dragStart}
            onHide={
              viewModes.terminal === 'float' ? () => setTermFloatVisible(false) : () => setBottomOpen(false)
            }
          >
            <TerminalPanel />
          </ToolWindow>
        )
      default:
        return null
    }
  }

  // ---- 渲染 ----
  return (
    <div className="flex h-full flex-col bg-ink-900 text-jb-text">
      <TitleBar
        workspaceRoot={workspaceRoot}
        gitBranch={gitBranch}
        projectKind={projectKind}
        running={running}
        building={busy === 'build'}
        pushBusy={busy === 'push'}
        pushPercent={pushPercent}
        fwTask={fwTask}
        onOpenWorkspace={() => void handleOpenWorkspace()}
        onOpenWorkspacePath={(p) => void handleOpenWorkspacePath(p)}
        onNewProject={() => setNewProjectOpen(true)}
        onRun={() => void handleRun()}
        onStop={handleStop}
        onFirmwareBuild={() => void startFirmwareTask('build')}
        onFirmwarePackage={() => void startFirmwareTask('merge')}
        onFirmwareFlash={handleFirmwareFlashOpen}
        onFirmwareClean={() => void startFirmwareTask('clean')}
        onFirmwareCancel={handleFirmwareCancel}
        onOpenSettings={() => void window.api.settingsWindowOpen()}
        onPush={() => void handlePushToDevice()}
        onRefreshDevices={() => void refreshDevices()}
        onQuickOpen={() => setQuickOpenVisible(true)}
      />

      <div className="flex min-h-0 flex-1">
        {/* 左工具窗轨道 */}
        <ToolWindowRail side="left" topItems={leftRailTop} bottomItems={leftRailBottom} />

        {/* 中央内容容器:相对定位,覆盖式停靠层(Unpinned/Undock)挂在其上不挤压布局 */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {/* 左:项目树 / 设备管理器(上)+ 结构视图(下,纵向分栏高度可拖拽);仅 dockPinned 占槽位 */}
            {(leftPinnedTool !== null || structPinned) && (
              <>
                <div style={{ width: leftWidth }} className="flex shrink-0 flex-col overflow-hidden">
                  {leftPinnedTool && (
                    <div
                      className={structPinned ? 'shrink-0 overflow-hidden' : 'min-h-0 flex-1'}
                      style={structPinned ? { height: structTopHeight } : undefined}
                    >
                      {renderTool(leftPinnedTool)}
                    </div>
                  )}
                  {leftPinnedTool && structPinned && (
                    <DragHandle
                      orientation="horizontal"
                      onDelta={(dy) => setStructTopHeight((h) => clamp(h + dy, 120, 640))}
                    />
                  )}
                  {structPinned && <div className="min-h-0 flex-1">{renderTool('structure')}</div>}
                </div>
                <DragHandle orientation="vertical" onDelta={(dx) => setLeftWidth((w) => clamp(w + dx, 180, 520))} />
              </>
            )}

            {/* 中:编辑器(EditorHost 常驻同一位置,保持 monaco 实例与模型) */}
            <div className="flex min-w-0 flex-1 flex-col bg-ink-900">
              {tabs.length > 0 && (
                <EditorTabs
                  tabs={tabs}
                  activePath={activePath}
                  dirtyPaths={dirtyPaths}
                  onSelect={(p) => {
                    setActivePath(p)
                    editorRef.current?.setActive(p)
                  }}
                  onClose={handleCloseTab}
                  trailing={
                    // md 文件:编辑 / 分屏 / 预览 切换按钮组(记忆每文件模式)
                    isMdFile ? (
                      <div className="flex items-center gap-0.5 rounded border border-ink-700 p-0.5">
                        {(
                          [
                            { mode: 'edit', icon: <LuPencil />, label: t('markdown.modeEdit') },
                            { mode: 'split', icon: <LuColumns2 />, label: t('markdown.modeSplit') },
                            { mode: 'preview', icon: <LuEye />, label: t('markdown.modePreview') }
                          ] as Array<{ mode: MdViewMode; icon: React.ReactNode; label: string }>
                        ).map((b) => (
                          <button
                            key={b.mode}
                            title={b.label}
                            onClick={() => changeMdMode(b.mode)}
                            className={`flex h-5 w-6 items-center justify-center rounded text-[13px] ${
                              mdMode === b.mode
                                ? 'bg-jb-selection text-jb-text'
                                : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
                            }`}
                          >
                            {b.icon}
                          </button>
                        ))}
                      </div>
                    ) : undefined
                  }
                />
              )}
              <div className="relative flex min-h-0 flex-1">
                {/* 预览模式:编辑器隐藏但保持挂载(monaco 实例/模型不销毁) */}
                <div className={`h-full min-w-0 ${isMdFile && mdMode === 'preview' ? 'hidden' : 'flex-1'}`}>
                  <EditorHost
                    ref={editorRef}
                    onDirtyChange={handleDirtyChange}
                    onCursorChange={(line, column) => setCursor({ line, column })}
                    onViewStateChange={scheduleSessionSave}
                  />
                </div>
                {isMdFile && activePath && mdMode !== 'edit' && (
                  <>
                    {mdMode === 'split' && <div className="w-px shrink-0 bg-ink-700" />}
                    <MarkdownPreview path={activePath} editorRef={editorRef} />
                  </>
                )}
                {tabs.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center bg-ink-900">
                    <span className="text-[13px] text-ink-500">{t('editor.welcome')}</span>
                  </div>
                )}
              </div>
            </div>

            {/* 右:「运行的设备」⇄「硬件设计」(rightView 仲裁;仅 dockPinned 占槽位) */}
            {rightPinned && (
              <>
                <DragHandle orientation="vertical" onDelta={(dx) => setRightWidth((w) => clamp(w - dx, 280, 680))} />
                <div style={{ width: rightWidth }} className="shrink-0 overflow-hidden">
                  {renderTool(rightTool)}
                </div>
              </>
            )}
          </div>

          {/* 底:日志/构建/问题 窗 ⇄ 终端窗(hidden 切换,两窗状态互不销毁;
              终端 xterm 实例常驻 xtermRegistry,底部区整体关闭重开会话也不丢;
              仅 dockPinned 的窗进槽位,overlay/float 模式在下方另行渲染) */}
          {bottomDockView !== null && (
            <>
              <DragHandle orientation="horizontal" onDelta={(dy) => setBottomHeight((h) => clamp(h - dy, 120, 480))} />
              <div style={{ height: bottomHeight }} className="shrink-0">
                {viewModes.logs === 'dockPinned' && (
                  <div className={bottomDockView === 'logs' ? 'h-full' : 'hidden'}>{renderTool('logs')}</div>
                )}
                {terminalOpened && viewModes.terminal === 'dockPinned' && (
                  <div className={bottomDockView === 'terminal' ? 'h-full' : 'hidden'}>{renderTool('terminal')}</div>
                )}
              </div>
            </>
          )}

          {/* 覆盖式停靠层(Dock Unpinned / Undock):absolute 覆盖编辑区,z-450 */}
          {(leftOverlayTool !== null || structOverlay) && (
            <DockOverlay
              ref={leftOverlayRef}
              side="left"
              size={leftWidth}
              onResizeDelta={(dx) => setLeftWidth((w) => clamp(w + dx, 180, 520))}
            >
              {leftOverlayTool && (
                <div
                  className={structOverlay ? 'shrink-0 overflow-hidden' : 'min-h-0 flex-1'}
                  style={structOverlay ? { height: structTopHeight } : undefined}
                >
                  {renderTool(leftOverlayTool)}
                </div>
              )}
              {leftOverlayTool && structOverlay && (
                <DragHandle
                  orientation="horizontal"
                  onDelta={(dy) => setStructTopHeight((h) => clamp(h + dy, 120, 640))}
                />
              )}
              {structOverlay && <div className="min-h-0 flex-1">{renderTool('structure')}</div>}
            </DockOverlay>
          )}
          {rightOverlay && (
            <DockOverlay
              ref={rightOverlayRef}
              side="right"
              size={rightWidth}
              onResizeDelta={(dx) => setRightWidth((w) => clamp(w - dx, 280, 680))}
            >
              {renderTool(rightTool)}
            </DockOverlay>
          )}
          {bottomOverlayTool !== null && (
            <DockOverlay
              ref={bottomOverlayRef}
              side="bottom"
              size={bottomHeight}
              onResizeDelta={(dy) => setBottomHeight((h) => clamp(h - dy, 120, 480))}
            >
              {renderTool(bottomOverlayTool)}
            </DockOverlay>
          )}
        </div>

        {/* 右工具窗轨道 */}
        <ToolWindowRail side="right" topItems={rightRail} />
      </div>

      {/* 状态栏 */}
      <StatusBar
        workspaceRoot={workspaceRoot}
        activePath={activePath}
        gitBranch={gitBranch}
        cursor={cursor}
        busy={busy}
        pushPercent={pushPercent}
        fwTask={fwTask}
      />

      {/* 浮动工具窗(视图模式 Float,z-600;可见性沿用各自槽位开关,终端有独立开关) */}
      {leftTool !== null && viewModes[leftTool] === 'float' && (
        <FloatPanel toolId={leftTool}>{(drag) => renderTool(leftTool, drag)}</FloatPanel>
      )}
      {structureOpen && viewModes.structure === 'float' && (
        <FloatPanel toolId="structure">{(drag) => renderTool('structure', drag)}</FloatPanel>
      )}
      {rightOpen && viewModes[rightTool] === 'float' && (
        <FloatPanel toolId={rightTool}>{(drag) => renderTool(rightTool, drag)}</FloatPanel>
      )}
      {bottomOpen && bottomView === 'logs' && viewModes.logs === 'float' && (
        <FloatPanel toolId="logs">{(drag) => renderTool('logs', drag)}</FloatPanel>
      )}
      {terminalOpened && termFloatVisible && viewModes.terminal === 'float' && (
        <FloatPanel toolId="terminal">{(drag) => renderTool('terminal', drag)}</FloatPanel>
      )}

      {/* Cmd+P 快速打开 */}
      {quickOpenVisible && (
        <QuickOpen
          workspaceRoot={workspaceRoot}
          onOpen={handleOpenFile}
          onClose={() => setQuickOpenVisible(false)}
        />
      )}

      {/* 关闭未保存标签的确认 */}
      {closingDirty && (
        <ConfirmModal
          message={t('editor.closeDirtyConfirm', { name: baseName(closingDirty) })}
          onConfirm={() => {
            closeTab(closingDirty)
            setClosingDirty(null)
          }}
          onCancel={() => setClosingDirty(null)}
        />
      )}

      {/* 「新建模拟器」向导(标题栏设备下拉 / 设备管理器共用,openDeviceWizard 触发) */}
      <DeviceWizardHost />

      {/* 烧录对话框(串口扫描轮询 + 无设备下载模式指引) */}
      {flashOpen && (
        <FlashDialog
          target={shellDeviceStore.get().chip}
          busy={fwTask !== null}
          defaultBaud={defaultBaud}
          onFlash={(port, baud) => {
            setFlashOpen(false)
            void startFirmwareTask('flash', port, baud)
          }}
          onClose={() => setFlashOpen(false)}
        />
      )}

      {/* IDE 设置已迁移到独立设置窗口(?window=settings,main/settingsWindow.ts) */}

      {/* 新建项目向导(标题栏项目下拉「新建项目…」触发) */}
      {newProjectOpen && (
        <NewProjectModal
          onCreated={(r) => void handleProjectCreated(r)}
          onClose={() => setNewProjectOpen(false)}
        />
      )}

      <ToastHost />
    </div>
  )
}
