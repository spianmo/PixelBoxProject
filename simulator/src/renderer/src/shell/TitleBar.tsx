/**
 * 自绘标题栏(JetBrains/Android Studio New UI 风格,高 40px,可拖拽移动窗口)
 *
 * 布局:
 * - 左区:应用图标 + 项目名下拉(最近工作区 + 打开工作区…)+ git 分支(非 git 隐藏)
 *   macOS 预留 80px 红绿灯位(main 进程 titleBarStyle: hiddenInset)
 * - 中右区(运行工具组):设备下拉(虚拟 + mDNS 真机分组)| 目标芯片下拉 |
 *   ▶ 运行 | ⏹ 停止 | 🔨 构建固件 | 📤 推送 | ⋮ 更多
 * - 右区:🔍 搜索(Cmd+P)| ⚙ 设置(语言切换)| 🔔 通知 | Win/Linux 窗口控制
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LuBell,
  LuChevronDown,
  LuCpu,
  LuEllipsisVertical,
  LuFolderOpen,
  LuGitBranch,
  LuHammer,
  LuLanguages,
  LuMinus,
  LuPackage,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuSearch,
  LuSettings,
  LuSlidersHorizontal,
  LuSmartphone,
  LuSquare,
  LuTrash2,
  LuUpload,
  LuUsb,
  LuX
} from 'react-icons/lu'
import { VscChromeMaximize, VscChromeRestore, VscLoading } from 'react-icons/vsc'
import type { FirmwareTaskKind } from '../../../shared/ipc-types'
import i18n, { setLanguage } from '../i18n'
import {
  CHIP_TARGETS,
  chipLabel,
  deviceKey,
  selectedDeviceName,
  setChip,
  simDeviceKey,
  useDeviceProfiles,
  useShellDevices,
  shellDeviceStore
} from './store'
import { openDeviceWizard } from './DeviceWizardModal'
import { MenuButton, PopoverButton, type DropdownItem } from './Dropdown'
import {
  notificationStore,
  markNotificationsRead,
  clearNotifications,
  type NotificationState
} from '../components/toast'

interface Props {
  workspaceRoot: string | null
  gitBranch: string | null
  running: boolean
  building: boolean
  pushBusy: boolean
  /** 推送进度 0-100,-1 表示无进行中的推送 */
  pushPercent: number
  /** 进行中的固件任务(阶段 3;null = 空闲) */
  fwTask: FirmwareTaskKind | null
  onOpenWorkspace: () => void
  onOpenWorkspacePath: (path: string) => void
  /** 「新建项目…」向导(项目下拉置顶入口) */
  onNewProject: () => void
  onRun: () => void
  onStop: () => void
  /** 🔨 构建当前目标芯片的固件 */
  onFirmwareBuild: () => void
  /** ⋮ 打包 merged.bin */
  onFirmwarePackage: () => void
  /** ⋮ 烧录…(打开端口选择对话框) */
  onFirmwareFlash: () => void
  /** ⋮ 清理构建目录 */
  onFirmwareClean: () => void
  /** 取消进行中的固件任务(杀进程树) */
  onFirmwareCancel: () => void
  /** ⚙ 打开 IDE 设置页 */
  onOpenSettings: () => void
  onPush: () => void
  onRefreshDevices: () => void
  onQuickOpen: () => void
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 运行工具组的图标按钮(紧凑,24px 图标热区 28px) */
function IconButton(props: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`app-no-drag flex h-7 w-7 items-center justify-center rounded text-[15px] ${
        props.disabled
          ? 'cursor-not-allowed text-ink-500'
          : `hover:bg-ink-800 ${props.className ?? 'text-jb-muted hover:text-jb-text'}`
      }`}
    >
      {props.children}
    </button>
  )
}

/** Windows/Linux 自绘窗口控制(最小化 / 最大化|还原 / 关闭) */
function WindowControls(): React.JSX.Element {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.windowIsMaximized().then(setMaximized)
    return window.api.onWindowMaximized(setMaximized)
  }, [])

  const cls =
    'app-no-drag flex h-10 w-11 items-center justify-center text-jb-muted hover:bg-ink-800 hover:text-jb-text'
  return (
    <div className="ml-1 flex self-stretch">
      <button title={t('titlebar.minimize')} className={cls} onClick={() => window.api.windowMinimize()}>
        <LuMinus />
      </button>
      <button
        title={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
        className={cls}
        onClick={() => window.api.windowToggleMaximize()}
      >
        {maximized ? <VscChromeRestore /> : <VscChromeMaximize />}
      </button>
      <button
        title={t('titlebar.close')}
        className="app-no-drag flex h-10 w-11 items-center justify-center text-jb-muted hover:bg-red-600 hover:text-white"
        onClick={() => window.api.windowClose()}
      >
        <LuX />
      </button>
    </div>
  )
}

/** 通知面板内容(🔔) */
function NotificationList(): React.JSX.Element {
  const { t } = useTranslation()
  const state = useSyncExternalStore<NotificationState>(
    notificationStore.subscribe,
    notificationStore.get
  )
  const fmt = (ts: number): string => {
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  return (
    <div>
      <div className="flex items-center justify-between border-b border-ink-700 px-3 py-1.5">
        <span className="text-xs font-medium text-jb-text">{t('notifications.title')}</span>
        <button
          className="rounded px-1.5 py-0.5 text-xs text-jb-muted hover:bg-ink-800 hover:text-jb-text"
          onClick={clearNotifications}
        >
          {t('notifications.clear')}
        </button>
      </div>
      {state.items.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-ink-500">{t('notifications.empty')}</div>
      ) : (
        state.items.map((n) => (
          <div key={n.id} className="border-b border-ink-700/50 px-3 py-1.5 last:border-b-0">
            <div className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  n.kind === 'error'
                    ? 'bg-red-400'
                    : n.kind === 'warn'
                      ? 'bg-yellow-400'
                      : n.kind === 'success'
                        ? 'bg-green-400'
                        : 'bg-accent'
                }`}
              />
              <span className="text-[11px] text-ink-500">{fmt(n.ts)}</span>
            </div>
            <div className="selectable mt-0.5 break-all pl-3.5 text-xs text-jb-text">{n.text}</div>
          </div>
        ))
      )}
    </div>
  )
}

export function TitleBar(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  const dev = useShellDevices()
  const { profiles } = useDeviceProfiles()
  const notif = useSyncExternalStore(notificationStore.subscribe, notificationStore.get)
  const [recents, setRecents] = useState<string[]>([])
  const isMac = window.api.platform === 'darwin'

  // 最近工作区(打开新工作区后刷新)
  useEffect(() => {
    void window.api.recentWorkspaces().then(setRecents)
  }, [props.workspaceRoot])

  // ---- 项目下拉(「新建项目…」置顶) ----
  const projectItems: DropdownItem[] = [
    {
      key: '__new-project__',
      label: t('titlebar.newProject'),
      icon: <LuPlus />,
      onSelect: props.onNewProject
    },
    ...recents
      .filter((p) => p !== props.workspaceRoot)
      .map((p) => ({
        key: p,
        label: baseName(p),
        hint: p,
        group: t('titlebar.recentWorkspaces'),
        onSelect: () => props.onOpenWorkspacePath(p)
      })),
    {
      key: '__open__',
      label: t('titlebar.openWorkspace'),
      icon: <LuFolderOpen />,
      group: '',
      onSelect: props.onOpenWorkspace
    }
  ]

  // ---- 设备下拉(虚拟设备档案 + mDNS 真机分组,阶段 2 接真实数据源) ----
  const deviceItems: DropdownItem[] = [
    ...profiles.map((p) => ({
      key: simDeviceKey(p.id),
      label: `${p.name} (${p.screenW}×${p.screenH})`,
      hint: chipLabel(p.chip),
      group: t('titlebar.virtualDevices'),
      checked: dev.selectedKey === simDeviceKey(p.id),
      onSelect: () => shellDeviceStore.set({ selectedKey: simDeviceKey(p.id) })
    })),
    {
      key: '__new-sim__',
      label: t('deviceManager.newEllipsis'), // 「新建模拟器…」直达向导
      icon: <LuPlus />,
      group: t('titlebar.virtualDevices'),
      onSelect: () => openDeviceWizard()
    },
    ...(dev.devices.length === 0
      ? [
          {
            key: '__none__',
            label: dev.scanning ? t('titlebar.scanning') : t('titlebar.noDevices'),
            group: t('titlebar.realDevices'),
            disabled: true,
            onSelect: () => undefined
          }
        ]
      : dev.devices.map((d) => ({
          key: deviceKey(d),
          label: `${d.name} (${d.ip})`,
          group: t('titlebar.realDevices'),
          checked: dev.selectedKey === deviceKey(d),
          onSelect: () => shellDeviceStore.set({ selectedKey: deviceKey(d) })
        }))),
    {
      key: '__rescan__',
      label: t('titlebar.rescanDevices'),
      icon: <LuRefreshCw className={dev.scanning ? 'animate-spin' : ''} />,
      group: '',
      disabled: dev.scanning,
      onSelect: props.onRefreshDevices
    }
  ]

  const selectedDeviceLabel = selectedDeviceName(dev, t('titlebar.simulatorDevice'))

  // ---- 芯片下拉(阶段 3 接真:🔨/打包/烧录 均按此目标传参 idf.py) ----
  const chipItems: DropdownItem[] = CHIP_TARGETS.map((c) => ({
    key: c,
    label: chipLabel(c),
    checked: dev.chip === c,
    onSelect: () => setChip(c)
  }))

  // ---- ⋮ 更多(固件:打包 merged.bin / 烧录… / 清理构建) ----
  const fwBusy = props.fwTask !== null
  const moreItems: DropdownItem[] = [
    {
      key: 'fw-package',
      label: t('fw.menuPackage'),
      icon: <LuPackage />,
      group: t('fw.menuGroup', { chip: chipLabel(dev.chip) }),
      disabled: fwBusy,
      onSelect: props.onFirmwarePackage
    },
    {
      key: 'fw-flash',
      label: t('fw.menuFlash'),
      icon: <LuUsb />,
      group: t('fw.menuGroup', { chip: chipLabel(dev.chip) }),
      disabled: fwBusy,
      onSelect: props.onFirmwareFlash
    },
    {
      key: 'fw-clean',
      label: t('fw.menuClean'),
      icon: <LuTrash2 />,
      group: t('fw.menuGroup', { chip: chipLabel(dev.chip) }),
      disabled: fwBusy,
      onSelect: props.onFirmwareClean
    },
    // 任务进行中追加「取消」(危险项)
    ...(fwBusy
      ? [
          {
            key: 'fw-cancel',
            label: t('fw.cancelTask'),
            icon: <LuX />,
            group: t('fw.menuGroup', { chip: chipLabel(dev.chip) }),
            danger: true,
            onSelect: props.onFirmwareCancel
          }
        ]
      : []),
    {
      key: 'open',
      label: t('titlebar.openWorkspace'),
      icon: <LuFolderOpen />,
      group: '',
      onSelect: props.onOpenWorkspace
    },
    {
      key: 'rescan',
      label: t('titlebar.rescanDevices'),
      icon: <LuRefreshCw />,
      disabled: dev.scanning,
      onSelect: props.onRefreshDevices
    }
  ]

  // ---- ⚙ 设置(语言切换 + IDE 设置页) ----
  const settingsItems: DropdownItem[] = [
    {
      key: 'zh-CN',
      label: '简体中文',
      icon: <LuLanguages />,
      group: t('settings.language'),
      checked: i18n.language === 'zh-CN',
      onSelect: () => setLanguage('zh-CN')
    },
    {
      key: 'en',
      label: 'English',
      icon: <LuLanguages />,
      group: t('settings.language'),
      checked: i18n.language === 'en',
      onSelect: () => setLanguage('en')
    },
    {
      key: 'ide-settings',
      label: t('fw.settings.open'),
      icon: <LuSlidersHorizontal />,
      group: '',
      onSelect: props.onOpenSettings
    }
  ]

  return (
    <div
      className="app-drag flex h-10 shrink-0 items-center gap-1 border-b border-ink-700 bg-ink-850 pr-0"
      style={{ paddingLeft: isMac ? 80 : 8 }}
      onDoubleClick={(e) => {
        // Windows/Linux:双击空白区最大化/还原(macOS 由系统处理)
        if (!isMac && e.target === e.currentTarget) window.api.windowToggleMaximize()
      }}
    >
      {/* 应用图标 */}
      <div
        className="mr-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-accent text-[11px] font-bold text-white"
        title="PixelBox"
      >
        P
      </div>

      {/* 项目名下拉 */}
      <MenuButton items={projectItems} title={t('titlebar.project')}>
        <span className="max-w-[180px] truncate font-medium text-jb-text">
          {props.workspaceRoot ? baseName(props.workspaceRoot) : t('titlebar.noProject')}
        </span>
        <LuChevronDown className="text-xs" />
      </MenuButton>

      {/* git 分支(非 git 仓库隐藏) */}
      {props.gitBranch && (
        <div
          className="flex h-7 items-center gap-1 rounded px-2 text-[13px] text-jb-muted"
          title={t('titlebar.branch')}
        >
          <LuGitBranch />
          <span className="max-w-[140px] truncate">{props.gitBranch}</span>
        </div>
      )}

      {/* 中右区:运行工具组 */}
      <div className="ml-auto flex items-center gap-0.5">
        <MenuButton items={deviceItems} title={t('titlebar.runOn')} maxHeight={360}>
          <LuSmartphone className="text-jb-muted" />
          <span className="max-w-[150px] truncate">{selectedDeviceLabel}</span>
          <LuChevronDown className="text-xs" />
        </MenuButton>

        <MenuButton items={chipItems} title={t('titlebar.chip')}>
          <LuCpu className="text-jb-muted" />
          <span>{chipLabel(dev.chip)}</span>
          <LuChevronDown className="text-xs" />
        </MenuButton>

        <div className="mx-1 h-5 w-px bg-ink-700" />

        {/* 多实例:运行中仍可再次 ▶(对另一档案启动新会话 / 对同档案热重载) */}
        <IconButton
          title={t('titlebar.run')}
          disabled={props.building}
          onClick={props.onRun}
          className="text-green-500 hover:text-green-400"
        >
          <LuPlay className="fill-current" />
        </IconButton>
        <IconButton
          title={t('titlebar.stop')}
          disabled={!props.running}
          onClick={props.onStop}
          className="text-red-400 hover:text-red-300"
        >
          <LuSquare className="fill-current text-[13px]" />
        </IconButton>
        {/* 🔨 构建当前目标芯片固件;任务进行中变为取消(spinner) */}
        <IconButton
          title={
            fwBusy
              ? `${t(`fw.status.${props.fwTask}`)} — ${t('fw.cancelTask')}`
              : `${t('titlebar.buildFirmware')} (${chipLabel(dev.chip)})`
          }
          onClick={fwBusy ? props.onFirmwareCancel : props.onFirmwareBuild}
        >
          {fwBusy ? <VscLoading className="animate-spin" /> : <LuHammer />}
        </IconButton>
        <IconButton
          title={
            props.pushBusy && props.pushPercent >= 0
              ? `${t('titlebar.push')} ${props.pushPercent}%`
              : t('titlebar.push')
          }
          disabled={props.pushBusy}
          onClick={props.onPush}
        >
          {props.pushBusy ? <VscLoading className="animate-spin" /> : <LuUpload />}
        </IconButton>
        <MenuButton
          items={moreItems}
          title={t('titlebar.more')}
          align="right"
          className="app-no-drag flex h-7 w-7 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
        >
          <LuEllipsisVertical />
        </MenuButton>
      </div>

      {/* 右区:搜索 / 设置 / 通知 */}
      <div className="mx-1 h-5 w-px bg-ink-700" />
      <div className="flex items-center gap-0.5 pr-1">
        <IconButton title={`${t('titlebar.search')} (⌘P)`} onClick={props.onQuickOpen}>
          <LuSearch />
        </IconButton>
        <MenuButton
          items={settingsItems}
          title={t('titlebar.settings')}
          align="right"
          className="app-no-drag flex h-7 w-7 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
        >
          <LuSettings />
        </MenuButton>
        <PopoverButton
          title={t('titlebar.notifications')}
          align="right"
          onOpen={markNotificationsRead}
          content={<NotificationList />}
        >
          <span className="relative">
            <LuBell />
            {notif.unread > 0 && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent" />
            )}
          </span>
        </PopoverButton>
      </div>

      {/* Windows/Linux 窗口控制 */}
      {!isMac && <WindowControls />}
    </div>
  )
}
