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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
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
  LuTriangleAlert
} from 'react-icons/lu'
import type { SimDeviceTag, SimManifest } from './device-sim/types'
import type { FirmwareTaskKind, FirmwareTaskResult, ProjectCreateResult } from '../../shared/ipc-types'
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
import { LogsToolWindow, LogsTabStrip, type BottomTab, type LogLine } from './shell/LogsToolWindow'
import { RunningDevicesPanel } from './shell/RunningDevicesPanel'
import { DeviceManagerPanel } from './shell/DeviceManagerPanel'
import { DeviceWizardHost } from './shell/DeviceWizardModal'
import { QuickOpen } from './shell/QuickOpen'
import { FlashDialog } from './shell/FlashDialog'
import { SettingsModal } from './shell/SettingsModal'
import { NewProjectModal } from './shell/NewProjectModal'
import { StructureView } from './editor/StructureView'
import { MarkdownPreview } from './editor/MarkdownPreview'
import { getMdViewMode, setMdViewMode, type MdViewMode } from './editor/mdViewMode'
import {
  applyDefaultChip,
  chipLabel,
  deviceKey,
  isSimDeviceKey,
  profileByKey,
  refreshDeviceProfiles,
  shellDeviceStore
} from './shell/store'

const MAX_LOG_LINES = 2000

/** 左侧工具窗:项目树 / 设备管理器(阶段 2) */
type LeftTool = 'project' | 'devices' | null

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 体积友好显示(通知 / 构建汇报) */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export default function App(): React.JSX.Element {
  const { t } = useTranslation()

  // ---- 布局尺寸 / 工具窗开关 ----
  const [leftWidth, setLeftWidth] = useState(260)
  // 430 = 368px 屏幕 1x 整数缩放 + 白框与边距(device-sim 需要)
  const [rightWidth, setRightWidth] = useState(430)
  const [bottomHeight, setBottomHeight] = useState(220)
  const [leftTool, setLeftTool] = useState<LeftTool>('project')
  const [rightOpen, setRightOpen] = useState(true)
  const [bottomOpen, setBottomOpen] = useState(true)
  const [bottomTab, setBottomTab] = useState<BottomTab>('logs')
  const [quickOpenVisible, setQuickOpenVisible] = useState(false)
  // 结构视图(左侧面板下分栏;允许只开结构)
  const [structureOpen, setStructureOpen] = useState(false)
  const [structTopHeight, setStructTopHeight] = useState(300)

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

  // ---- 固件工具链(阶段 3):任务状态 / 烧录对话框 / 设置页 ----
  const [fwTask, setFwTask] = useState<FirmwareTaskKind | null>(null)
  const [flashOpen, setFlashOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 新建项目向导
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  // Markdown 查看模式(仅活动文件为 md 时生效;切文件时从记忆恢复)
  const [mdMode, setMdModeState] = useState<MdViewMode>('split')
  /** 烧录默认波特率(设置页持久化;打开烧录对话框时刷新) */
  const [defaultBaud, setDefaultBaud] = useState(460800)

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

    // 外部文件变更 → 干净的已打开文件自动重载
    unsubs.push(
      window.api.onFsEvent((ev) => {
        if (ev.type === 'change') void editorRef.current?.reloadIfClean(ev.path)
      })
    )

    return () => unsubs.forEach((u) => u())
  }, [appendLog, t])

  // 启动时先扫一轮设备 + 加载虚拟设备档案(设备管理器数据源)
  useEffect(() => {
    void refreshDevices()
    void refreshDeviceProfiles()
    // 固件任务状态恢复(renderer 重载时任务可能仍在 main 进程运行)
    window.api
      .firmwareStatus()
      .then((s) => setFwTask(s.running))
      .catch(() => undefined)
    // 工具链设置:默认目标芯片(本地无记忆时生效)+ 默认波特率
    window.api
      .toolchainSettingsGet()
      .then((s) => {
        applyDefaultChip(s.defaultTarget)
        setDefaultBaud(s.baudRate)
      })
      .catch(() => undefined)
    // eslint 无此工程:仅首挂载执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 所有会话都停止(逐 tab 关闭 / 崩溃)后,同步停掉 watch 重建
  const prevRunningRef = useRef(false)
  useEffect(() => {
    if (prevRunningRef.current && !running) void window.api.buildWatchStop()
    prevRunningRef.current = running
  }, [running])

  // Cmd/Ctrl+P 快速打开(capture 阶段拦截,避免 Monaco 吃掉按键)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        setQuickOpenVisible((v) => !v)
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
      setLeftTool('project')
      await window.api.watchWorkspace(root)
    },
    // eslint 无此工程:handleStop 为组件内函数,依赖 tabs/running 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, running]
  )

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

  /** 新建项目向导创建成功:作为工作区打开(计入最近列表)+ 编辑器打开 src/main.ts */
  async function handleProjectCreated(result: ProjectCreateResult): Promise<void> {
    setNewProjectOpen(false)
    const root = await window.api.openWorkspacePath(result.root)
    if (!root) return
    await applyWorkspace(root)
    handleOpenFile(result.mainTs)
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
      const target = shellDeviceStore.get().chip
      setBottomOpen(true)
      setBottomTab('build')
      setFwTask(kind) // 先置忙防重入(双击/菜单连点)
      try {
        await window.api.firmwareStart({ kind, target, port, baud })
      } catch (err) {
        setFwTask(null)
        const msg = err instanceof Error ? err.message : String(err)
        const code = /toolchain:(\w+)/.exec(msg)?.[1] ?? 'startFailed'
        showToast(t(`fw.errors.${code}`, { defaultValue: t('fw.errors.startFailed') }), 'error')
      }
    },
    [t]
  )

  /** 烧录…:先刷新默认波特率再打开端口选择对话框 */
  async function handleFirmwareFlashOpen(): Promise<void> {
    try {
      const s = await window.api.toolchainSettingsGet()
      setDefaultBaud(s.baudRate)
    } catch {
      // 读取失败沿用当前默认值
    }
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
    setBottomOpen(true)
    setBottomTab('build')
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
      setRightOpen(true)
      setBottomTab('logs')
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

  async function handlePush(): Promise<void> {
    const root = workspaceRootRef.current
    if (!root) {
      showToast(t('run.noWorkspace'), 'warn')
      return
    }
    const devState = shellDeviceStore.get()
    const dev = isSimDeviceKey(devState.selectedKey)
      ? undefined
      : devState.devices.find((d) => deviceKey(d) === devState.selectedKey)
    if (!dev) {
      showToast(t('push.noDevice'), 'warn')
      return
    }
    setBottomOpen(true)
    setBottomTab('build')
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
    if (bottomOpen && bottomTab === tab) setBottomOpen(false)
    else {
      setBottomTab(tab)
      setBottomOpen(true)
    }
  }

  const leftRailBottom: RailItem[] = [
    {
      key: 'build',
      icon: <LuHammer />,
      label: t('rail.build'),
      active: bottomOpen && bottomTab === 'build',
      onClick: () => toggleBottom('build')
    },
    {
      key: 'logs',
      icon: <LuScrollText />,
      label: t('rail.logs'),
      active: bottomOpen && bottomTab === 'logs',
      onClick: () => toggleBottom('logs')
    },
    {
      key: 'problems',
      icon: <LuTriangleAlert />,
      label: t('rail.problems'),
      active: bottomOpen && bottomTab === 'problems',
      badge: problems.length,
      onClick: () => toggleBottom('problems')
    }
  ]

  const rightRail: RailItem[] = [
    {
      key: 'running',
      icon: <LuSmartphone />,
      label: t('rail.runningDevices'),
      active: rightOpen,
      onClick: () => setRightOpen((v) => !v)
    }
  ]

  // ---- 渲染 ----
  return (
    <div className="flex h-full flex-col bg-ink-900 text-jb-text">
      <TitleBar
        workspaceRoot={workspaceRoot}
        gitBranch={gitBranch}
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
        onFirmwareFlash={() => void handleFirmwareFlashOpen()}
        onFirmwareClean={() => void startFirmwareTask('clean')}
        onFirmwareCancel={handleFirmwareCancel}
        onOpenSettings={() => setSettingsOpen(true)}
        onPush={() => void handlePush()}
        onRefreshDevices={() => void refreshDevices()}
        onQuickOpen={() => setQuickOpenVisible(true)}
      />

      <div className="flex min-h-0 flex-1">
        {/* 左工具窗轨道 */}
        <ToolWindowRail side="left" topItems={leftRailTop} bottomItems={leftRailBottom} />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {/* 左:项目树 / 设备管理器(上)+ 结构视图(下,纵向分栏高度可拖拽) */}
            {(leftTool !== null || structureOpen) && (
              <>
                <div style={{ width: leftWidth }} className="flex shrink-0 flex-col overflow-hidden">
                  {leftTool && (
                    <div
                      className={structureOpen ? 'shrink-0 overflow-hidden' : 'min-h-0 flex-1'}
                      style={structureOpen ? { height: structTopHeight } : undefined}
                    >
                      <ToolWindow
                        title={leftTool === 'project' ? t('rail.project') : t('rail.devices')}
                        icon={leftTool === 'project' ? <LuFolderTree /> : <LuMonitorSmartphone />}
                        onHide={() => setLeftTool(null)}
                      >
                        {leftTool === 'project' ? (
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
                    </div>
                  )}
                  {leftTool && structureOpen && (
                    <DragHandle
                      orientation="horizontal"
                      onDelta={(dy) => setStructTopHeight((h) => clamp(h + dy, 120, 640))}
                    />
                  )}
                  {structureOpen && (
                    <div className="min-h-0 flex-1">
                      <ToolWindow
                        title={t('rail.structure')}
                        icon={<LuListTree />}
                        onHide={() => setStructureOpen(false)}
                      >
                        <StructureView
                          path={activePath}
                          cursorLine={cursor?.line ?? null}
                          onNavigate={(line, column) => editorRef.current?.revealAt(line, column)}
                        />
                      </ToolWindow>
                    </div>
                  )}
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
                  <EditorHost ref={editorRef} onDirtyChange={handleDirtyChange} onCursorChange={(line, column) => setCursor({ line, column })} />
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

            {/* 右:「运行的设备」 */}
            {rightOpen && (
              <>
                <DragHandle orientation="vertical" onDelta={(dx) => setRightWidth((w) => clamp(w - dx, 280, 680))} />
                <div style={{ width: rightWidth }} className="shrink-0 overflow-hidden">
                  <ToolWindow
                    title={t('rail.runningDevices')}
                    icon={<LuSmartphone />}
                    onHide={() => setRightOpen(false)}
                  >
                    <RunningDevicesPanel />
                  </ToolWindow>
                </div>
              </>
            )}
          </div>

          {/* 底:日志 / 构建 / 问题 */}
          {bottomOpen && (
            <>
              <DragHandle orientation="horizontal" onDelta={(dy) => setBottomHeight((h) => clamp(h - dy, 120, 480))} />
              <div style={{ height: bottomHeight }} className="shrink-0">
                <ToolWindow
                  title={t('console.appLog')}
                  header={<LogsTabStrip activeTab={bottomTab} problems={problems.length} onTabChange={setBottomTab} />}
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
              </div>
            </>
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

      {/* IDE 设置页(编辑器 minimap / IDF 路径覆盖 / 默认目标 / 波特率) */}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

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
