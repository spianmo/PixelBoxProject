/**
 * 顶部工具栏:打开工作区 / 运行 / 停止 / 推送到设备 / 设备下拉 / 语言切换
 */
import { useTranslation } from 'react-i18next'
import {
  VscFolderOpened,
  VscPlay,
  VscDebugStop,
  VscRocket,
  VscRefresh,
  VscGlobe,
  VscLoading
} from 'react-icons/vsc'
import type { DevdDevice } from '../../../shared/ipc-types'
import { toggleLanguage } from '../i18n'

interface Props {
  workspaceName: string | null
  running: boolean
  pushBusy: boolean
  /** 推送进度 0-100,-1 表示无进行中的推送 */
  pushPercent: number
  devices: DevdDevice[]
  selectedDeviceKey: string
  scanning: boolean
  onOpenWorkspace: () => void
  onRun: () => void
  onStop: () => void
  onPush: () => void
  onSelectDevice: (key: string) => void
  onRefreshDevices: () => void
}

export function deviceKey(d: DevdDevice): string {
  return `${d.ip}:${d.port}`
}

function ToolButton({
  title,
  disabled,
  onClick,
  children,
  accent
}: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  accent?: boolean
}): React.JSX.Element {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-sm transition-colors ${
        disabled
          ? 'cursor-not-allowed text-gray-600'
          : accent
            ? 'text-accent hover:bg-ink-700'
            : 'text-gray-300 hover:bg-ink-700 hover:text-gray-100'
      }`}
    >
      {children}
    </button>
  )
}

export function Toolbar(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  const {
    workspaceName,
    running,
    pushBusy,
    pushPercent,
    devices,
    selectedDeviceKey,
    scanning,
    onOpenWorkspace,
    onRun,
    onStop,
    onPush,
    onSelectDevice,
    onRefreshDevices
  } = props

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-ink-700 bg-ink-850 px-2">
      {/* 应用标识 */}
      <div className="mr-2 flex items-center gap-2 pl-1">
        <span className="text-sm font-semibold tracking-wide text-accent">PixelBox</span>
        <span className="text-xs text-gray-500">{t('app.title')}</span>
      </div>

      <ToolButton title={t('toolbar.openWorkspace')} onClick={onOpenWorkspace}>
        <VscFolderOpened />
        <span className="hidden lg:inline">{t('toolbar.openWorkspace')}</span>
      </ToolButton>

      {workspaceName && (
        <span className="max-w-[200px] truncate rounded bg-ink-700/60 px-2 py-0.5 text-xs text-gray-300">
          {workspaceName}
        </span>
      )}

      <div className="mx-2 h-5 w-px bg-ink-600" />

      <ToolButton title={t('toolbar.run')} onClick={onRun} disabled={running} accent>
        <VscPlay />
        <span className="hidden lg:inline">{t('toolbar.run')}</span>
      </ToolButton>
      <ToolButton title={t('toolbar.stop')} onClick={onStop} disabled={!running}>
        <VscDebugStop />
        <span className="hidden lg:inline">{t('toolbar.stop')}</span>
      </ToolButton>

      <div className="mx-2 h-5 w-px bg-ink-600" />

      <ToolButton title={t('toolbar.push')} onClick={onPush} disabled={pushBusy}>
        {pushBusy ? <VscLoading className="animate-spin" /> : <VscRocket />}
        <span className="hidden lg:inline">
          {pushBusy && pushPercent >= 0 ? `${pushPercent}%` : t('toolbar.push')}
        </span>
      </ToolButton>

      {/* 设备下拉(mDNS 发现) */}
      <select
        value={selectedDeviceKey}
        onChange={(e) => onSelectDevice(e.target.value)}
        className="h-7 max-w-[220px] rounded border border-ink-600 bg-ink-800 px-1.5 text-xs text-gray-200 outline-none focus:border-accent"
      >
        {devices.length === 0 ? (
          <option value="">{scanning ? t('toolbar.scanning') : t('toolbar.noDevices')}</option>
        ) : (
          <>
            <option value="">{t('toolbar.devices')}</option>
            {devices.map((d) => (
              <option key={deviceKey(d)} value={deviceKey(d)}>
                {d.name} ({d.ip})
              </option>
            ))}
          </>
        )}
      </select>
      <ToolButton title={t('toolbar.refreshDevices')} onClick={onRefreshDevices} disabled={scanning}>
        <VscRefresh className={scanning ? 'animate-spin' : ''} />
      </ToolButton>

      {/* 语言切换 */}
      <div className="ml-auto">
        <ToolButton title={t('toolbar.language')} onClick={toggleLanguage}>
          <VscGlobe />
          <span className="text-xs">中 / EN</span>
        </ToolButton>
      </div>
    </div>
  )
}
