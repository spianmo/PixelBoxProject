/**
 * 「运行的设备」面板(对齐 AS Running Devices,阶段 2:多实例)
 * - 顶部小标签栏:每个模拟器会话一个 tab + ✕(关闭 = 停止并销毁该会话)
 * - 内容区挂载 device-sim 宿主(SimHost 按激活会话渲染屏幕/工具条/外设抽屉,
 *   分辨率取会话档案,多设备可并行运行)
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LuSmartphone, LuX } from 'react-icons/lu'
import { setupDeviceSim, useSimSessions, setActiveSession, closeSession } from '../device-sim'
import type { SimSession } from '../device-sim'

/** 单个会话 tab(订阅自己引擎的运行态:绿点=运行中) */
function SessionTab({ session, active }: { session: SimSession; active: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const ui = useSyncExternalStore(session.engine.uiStore.subscribe, session.engine.uiStore.get)
  return (
    <div
      role="tab"
      onClick={() => setActiveSession(session.key)}
      className={`relative flex cursor-pointer items-center gap-1.5 px-2.5 text-xs ${
        active ? 'text-jb-text' : 'text-jb-muted hover:text-jb-text'
      }`}
      title={ui.appName ?? session.profile.name}
    >
      <LuSmartphone className={ui.running ? 'text-green-400' : 'text-ink-500'} />
      <span className="max-w-[120px] truncate">{session.profile.name}</span>
      <button
        title={t('sim.closeTab')}
        onClick={(e) => {
          e.stopPropagation()
          closeSession(session.key)
        }}
        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-jb-muted hover:bg-ink-700 hover:text-jb-text"
      >
        <LuX />
      </button>
      {active && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />}
    </div>
  )
}

export function RunningDevicesPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const mountRef = useRef<HTMLDivElement>(null)
  const { sessions, activeKey } = useSimSessions()

  useEffect(() => {
    // 挂载 device-sim 宿主(幂等;会话/分辨率由 simSessionsStore 驱动)
    if (mountRef.current) setupDeviceSim(mountRef.current)
  }, [])

  return (
    <div className="flex h-full flex-col bg-ink-900">
      {/* 顶部小标签栏:每会话一个 tab */}
      <div className="flex h-7 shrink-0 items-stretch overflow-x-auto border-b border-ink-700 bg-ink-850">
        {sessions.length === 0 ? (
          <div className="flex items-center px-2.5 text-xs text-ink-500">{t('device.noRunning')}</div>
        ) : (
          sessions.map((s) => <SessionTab key={s.key} session={s} active={s.key === activeKey} />)
        )}
      </div>
      {/* device-sim 挂载容器:SimHost 在此渲染激活会话的像素屏与虚拟外设 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={mountRef} id="device-sim-root" className="absolute inset-0" />
      </div>
    </div>
  )
}
