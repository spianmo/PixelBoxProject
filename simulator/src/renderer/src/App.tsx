/**
 * IDE 根组件:布局 + 全局状态
 * 布局:工具栏 | 左文件树 · 中编辑器 · 右设备面板 | 底部控制台(全部可拖拽调宽)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VscFolderOpened } from 'react-icons/vsc'
import type { SimManifest } from './device-sim/types'
import { EditorHost, type EditorHostHandle } from './editor/EditorHost'
import { Toolbar, deviceKey } from './components/Toolbar'
import { FileTree } from './components/FileTree'
import { EditorTabs, type TabInfo } from './components/EditorTabs'
import { ConsolePanel, type ConsoleTab, type LogLine } from './components/ConsolePanel'
import { DevicePanel } from './components/DevicePanel'
import { DragHandle } from './components/DragHandle'
import { ToastHost, showToast } from './components/toast'
import { ConfirmModal } from './components/Modal'
import type { DevdDevice } from '../../shared/ipc-types'

const MAX_LOG_LINES = 2000

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export default function App(): React.JSX.Element {
  const { t } = useTranslation()

  // ---- 布局尺寸 ----
  const [leftWidth, setLeftWidth] = useState(240)
  // 430 = 368px 屏幕 1x 整数缩放 + 白框与边距(device-sim 需要)
  const [rightWidth, setRightWidth] = useState(430)
  const [bottomHeight, setBottomHeight] = useState(180)

  // ---- 工作区 / 编辑器 ----
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())
  const [closingDirty, setClosingDirty] = useState<string | null>(null)
  const editorRef = useRef<EditorHostHandle>(null)

  // ---- 控制台 ----
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('app')
  const [appLogs, setAppLogs] = useState<LogLine[]>([])
  const [buildLogs, setBuildLogs] = useState<LogLine[]>([])

  // ---- 运行 / 设备 ----
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  runningRef.current = running
  const [devices, setDevices] = useState<DevdDevice[]>([])
  const [selectedDeviceKey, setSelectedDeviceKey] = useState('')
  const [scanning, setScanning] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushPercent, setPushPercent] = useState(-1)
  const workspaceRootRef = useRef<string | null>(null)
  workspaceRootRef.current = workspaceRoot

  const appendLog = useCallback((target: ConsoleTab, line: LogLine): void => {
    const setter = target === 'app' ? setAppLogs : setBuildLogs
    setter((prev) => {
      const next = [...prev, line]
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

    // watch 重建完成 → 热重载
    unsubs.push(
      window.api.onBuildDone((result) => {
        if (!runningRef.current) return
        const sim = window.__pixelboxSim
        const root = workspaceRootRef.current
        if (result.success && result.code && result.manifest && result.outDir && sim && root) {
          // device-sim 运行上下文(引擎据此预载 dist/ 与定位存储目录)
          window.__pixelboxSimContext = { workspaceRoot: root, outDir: result.outDir }
          void sim.load(result.code, result.manifest as SimManifest).then(() => {
            showToast(t('run.reloaded'), 'info', 1800)
          })
        }
      })
    )

    // 设备实时发现
    unsubs.push(window.api.onDevdDevices((list) => setDevices(list)))

    // 推送进度
    unsubs.push(
      window.api.onPushProgress((p) => {
        setPushPercent(p.phase === 'done' || p.phase === 'error' ? -1 : p.percent)
      })
    )

    // 模拟器应用日志(device-sim 引擎经 CustomEvent 上报)
    const onSimLog = (ev: WindowEventMap['pixelbox-sim:log']): void => {
      appendLog('app', { level: ev.detail.level, text: ev.detail.text, ts: ev.detail.ts })
    }
    const onSimState = (ev: WindowEventMap['pixelbox-sim:state']): void => {
      if (ev.detail.state === 'crashed') {
        setRunning(false)
        showToast(`${t('common.error')}: ${ev.detail.error ?? 'crashed'}`, 'error')
      } else if (ev.detail.state === 'stopped') {
        setRunning(false)
      } else {
        setRunning(true)
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

  // 启动时先扫一轮设备
  useEffect(() => {
    void refreshDevices()
    // eslint 无此工程:仅首挂载执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 动作 ----

  async function refreshDevices(): Promise<void> {
    setScanning(true)
    try {
      setDevices(await window.api.devdDiscover(3000))
    } catch {
      // mDNS 失败静默(无网卡等)
    } finally {
      setScanning(false)
    }
  }

  async function handleOpenWorkspace(): Promise<void> {
    const root = await window.api.openWorkspace()
    if (!root) return
    // 重置编辑器状态
    for (const tab of tabs) editorRef.current?.closeFile(tab.path)
    setTabs([])
    setActivePath(null)
    setDirtyPaths(new Set())
    if (running) handleStop()
    setWorkspaceRoot(root)
    await window.api.watchWorkspace(root)
  }

  const handleOpenFile = useCallback((path: string): void => {
    setTabs((prev) => (prev.some((tb) => tb.path === path) ? prev : [...prev, { path, name: baseName(path) }]))
    setActivePath(path)
    void editorRef.current?.openFile(path)
  }, [])

  const closeTab = useCallback(
    (path: string): void => {
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
          return null
        })
        return next
      })
    },
    []
  )

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

  async function handleRun(): Promise<void> {
    const root = workspaceRootRef.current
    if (!root) {
      showToast(t('run.noWorkspace'), 'warn')
      return
    }
    setConsoleTab('build')
    await editorRef.current?.saveAll() // 运行前自动保存
    const result = await window.api.build(root)
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
      // device-sim 运行上下文(引擎据此预载 dist/ 与定位存储目录)
      window.__pixelboxSimContext = { workspaceRoot: root, outDir: result.outDir }
      await sim.load(result.code, result.manifest as SimManifest)
      setRunning(true)
      setConsoleTab('app')
      showToast(t('run.started'), 'info', 1800)
      await window.api.buildWatchStart(root) // 开启 watch 热重载
    } catch (err) {
      showToast(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  function handleStop(): void {
    window.__pixelboxSim?.stop()
    void window.api.buildWatchStop()
    setRunning(false)
    showToast(t('run.stopped'), 'info', 1500)
  }

  async function handlePush(): Promise<void> {
    const root = workspaceRootRef.current
    if (!root) {
      showToast(t('run.noWorkspace'), 'warn')
      return
    }
    const dev = devices.find((d) => deviceKey(d) === selectedDeviceKey)
    if (!dev) {
      showToast(t('push.noDevice'), 'warn')
      return
    }
    setConsoleTab('build')
    await editorRef.current?.saveAll()
    setPushBusy(true)
    setPushPercent(0)
    try {
      await window.api.devdPush({ root, host: dev.ip || dev.host, port: dev.port })
      showToast(t('push.done'), 'info')
    } catch (err) {
      showToast(t('push.failed', { message: err instanceof Error ? err.message : String(err) }), 'error', 5000)
    } finally {
      setPushBusy(false)
      setPushPercent(-1)
    }
  }

  // ---- 渲染 ----
  return (
    <div className="flex h-full flex-col">
      <Toolbar
        workspaceName={workspaceRoot ? baseName(workspaceRoot) : null}
        running={running}
        pushBusy={pushBusy}
        pushPercent={pushPercent}
        devices={devices}
        selectedDeviceKey={selectedDeviceKey}
        scanning={scanning}
        onOpenWorkspace={() => void handleOpenWorkspace()}
        onRun={() => void handleRun()}
        onStop={handleStop}
        onPush={() => void handlePush()}
        onSelectDevice={setSelectedDeviceKey}
        onRefreshDevices={() => void refreshDevices()}
      />

      <div className="flex min-h-0 flex-1">
        {/* 左:文件树 */}
        <div style={{ width: leftWidth }} className="shrink-0 overflow-hidden border-r border-ink-700 bg-ink-850">
          {workspaceRoot ? (
            <FileTree
              root={workspaceRoot}
              onOpenFile={handleOpenFile}
              dirtyPaths={dirtyPaths}
              onFileRemoved={handleFileRemoved}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <VscFolderOpened className="text-3xl text-ink-500" />
              <div className="text-sm text-gray-400">{t('fileTree.empty')}</div>
              <div className="text-xs text-gray-600">{t('fileTree.openHint')}</div>
            </div>
          )}
        </div>
        <DragHandle
          orientation="vertical"
          onDelta={(dx) => setLeftWidth((w) => clamp(w + dx, 160, 480))}
        />

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
            />
          )}
          <div className="relative min-h-0 flex-1">
            <EditorHost ref={editorRef} onDirtyChange={handleDirtyChange} />
            {tabs.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-ink-900">
                <span className="text-sm text-gray-600">{t('editor.welcome')}</span>
              </div>
            )}
          </div>
        </div>

        <DragHandle
          orientation="vertical"
          onDelta={(dx) => setRightWidth((w) => clamp(w - dx, 260, 640))}
        />
        {/* 右:设备面板(device-sim 挂载区) */}
        <div style={{ width: rightWidth }} className="shrink-0 overflow-hidden border-l border-ink-700">
          <DevicePanel />
        </div>
      </div>

      <DragHandle
        orientation="horizontal"
        onDelta={(dy) => setBottomHeight((h) => clamp(h - dy, 100, 420))}
      />
      {/* 底:控制台 */}
      <div style={{ height: bottomHeight }} className="shrink-0 border-t border-ink-700">
        <ConsolePanel
          activeTab={consoleTab}
          onTabChange={setConsoleTab}
          appLogs={appLogs}
          buildLogs={buildLogs}
          onClear={(tab) => (tab === 'app' ? setAppLogs([]) : setBuildLogs([]))}
        />
      </div>

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

      <ToastHost />
    </div>
  )
}
