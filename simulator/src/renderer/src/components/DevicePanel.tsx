/**
 * 右侧设备面板:device-sim 引擎挂载区
 * 引擎实现见 ../device-sim/README.md;未接入时显示占位提示
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VscVm } from 'react-icons/vsc'
import { setupDeviceSim } from '../device-sim'

export function DevicePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const mountRef = useRef<HTMLDivElement>(null)
  const [simReady, setSimReady] = useState<boolean>(() => Boolean(window.__pixelboxSim))

  useEffect(() => {
    // 引擎就绪事件(引擎自行派发)
    const onReady = (): void => setSimReady(true)
    window.addEventListener('pixelbox-sim:ready', onReady)

    // 调用引擎入口;占位实现返回 null
    if (mountRef.current) {
      const api = setupDeviceSim(mountRef.current)
      if (api) {
        window.__pixelboxSim = api
        setSimReady(true)
      }
    }
    return () => window.removeEventListener('pixelbox-sim:ready', onReady)
  }, [])

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850 px-3 text-xs text-gray-300">
        <VscVm className="text-accent" />
        {t('device.panelTitle')}
      </div>
      <div className="relative flex-1 overflow-hidden">
        {/* device-sim 挂载容器:引擎在此渲染像素屏与虚拟外设 */}
        <div ref={mountRef} id="device-sim-root" className="absolute inset-0" />
        {!simReady && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <VscVm className="text-4xl text-ink-500" />
            <div className="text-sm text-gray-400">{t('device.simNotReady')}</div>
            <div className="text-xs text-gray-600">{t('device.simNotReadyHint')}</div>
          </div>
        )}
      </div>
    </div>
  )
}
