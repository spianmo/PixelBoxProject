/**
 * SimHost —— 「运行的设备」内容区宿主(阶段 2:多实例)
 *
 * 订阅 simSessionsStore,渲染激活 tab 对应会话的 SimPanel(屏幕分辨率取该会话
 * 档案的 screenW×screenH,稳定引用经 useMemo 保证 SimPanel effect 不抖动);
 * 无会话时渲染空态提示(与 AS Running Devices 的 “No devices” 空态一致)。
 * tab 条本身由外壳 RunningDevicesPanel 渲染(同样订阅 simSessionsStore)。
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { LuMonitorSmartphone } from 'react-icons/lu'
import { useSimSessions } from '../sessions'
import { SimPanel } from './SimPanel'

export function SimHost(): React.JSX.Element {
  const { t } = useTranslation()
  const { sessions, activeKey } = useSimSessions()
  const active = sessions.find((s) => s.key === activeKey) ?? null

  // 屏幕尺寸对象保持稳定引用(SimPanel 内 effect 依赖 width/height)
  const screen = useMemo(
    () => (active ? { width: active.profile.screenW, height: active.profile.screenH } : null),
    [active]
  )

  if (!active || !screen) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-ink-900 px-4 text-center">
        <LuMonitorSmartphone className="text-3xl text-ink-500" />
        <div className="text-[13px] text-jb-muted">{t('sim.noSession')}</div>
        <div className="text-xs text-ink-500">{t('sim.noSessionHint')}</div>
      </div>
    )
  }

  // key=会话 key:切换 tab 时强制重挂 SimPanel,保证画布 attach 到正确引擎
  return <SimPanel key={active.key} engine={active.engine} screen={screen} />
}
