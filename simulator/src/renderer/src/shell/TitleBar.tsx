/**
 * 自绘标题栏(JetBrains/Android Studio New UI 风格,高 40px,可拖拽移动窗口)
 *
 * 布局:
 * - 左区:应用图标 + 项目名下拉(最近工作区 + 打开工作区…)+ git 分支(非 git 隐藏)
 *   macOS 预留 80px 红绿灯位(main 进程 titleBarStyle: hiddenInset)
 * - 中右区(运行工具组):设备下拉(虚拟 + mDNS 真机分组)| 目标芯片下拉 |
 *   ▶ 运行 | ⏹ 停止 | 🔨 构建固件 | 📤 推送 | ⋮ 更多
 *   (IDE v3 按工程类型门控:app=▶/⏹/📤,firmware=🔨 与 ⋮ 固件项 + 芯片下拉;
 *    芯片下拉只服务 idf.py 目标选择,app 模拟用设备档案的芯片、hardware 只在创建时记 manifest.chip,
 *    故仅 firmware 显示;隐藏而非禁用,fwBusy 时取消入口恒可达)
 * - 右区:🔍 搜索(Cmd+P)| ⚙ 设置(语言快捷切换 + IDE 设置独立窗口)| 🔔 通知 | Win/Linux 窗口控制
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import appIconUrl from '../assets/app-icon.png'
import {
  LuBell,
  LuChevronDown,
  LuCircuitBoard,
  LuCpu,
  LuEllipsisVertical,
  LuFolder,
  LuFolderOpen,
  LuGitBranch,
  LuHammer,
  LuLanguages,
  LuLayoutTemplate,
  LuMinus,
  LuMonitorSmartphone,
  LuPackage,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuSearch,
  LuSend,
  LuSettings,
  LuSlidersHorizontal,
  LuSmartphone,
  LuSquare,
  LuTrash2,
  LuUsb,
  LuX
} from 'react-icons/lu'
import { VscChromeMaximize, VscChromeRestore, VscLoading } from 'react-icons/vsc'
import type { FirmwareTaskKind, ProjectKind, RecentWorkspace } from '../../../shared/ipc-types'
import i18n from '../i18n'
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
  /** 工程类型(§5 门控矩阵;null = 传统目录,保留 ▶ 运行兼容旧行为) */
  projectKind: ProjectKind | null
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
  /** ⚙ 菜单「IDE 设置…」→ 打开设置独立窗口(旧页内 SettingsModal 已移除) */
  onOpenSettings: () => void
  onPush: () => void
  onRefreshDevices: () => void
  onQuickOpen: () => void
  /** 设备下拉「设备管理器」→ 打开左轨道设备管理器工具窗(AS Device Manager 入口) */
  onOpenDeviceManager: () => void
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 项目类型 → 图标(与新建项目向导同一套语义:app=模板 / firmware=芯片 / hardware=电路板) */
function projectKindIcon(kind: ProjectKind | null): React.JSX.Element {
  switch (kind) {
    case 'app':
      return <LuLayoutTemplate />
    case 'firmware':
      return <LuCpu />
    case 'hardware':
      return <LuCircuitBoard />
    default:
      return <LuFolder />
  }
}

/**
 * 路径中间省略:保留开头段与末尾目录名,中段折叠为 …(JetBrains 最近项目风格)。
 * 家目录先压缩为 ~;仍超长时按段折叠(~/Projects/…/esp32_devices);
 * 单段仍超长则对字符串做硬性中间截断,保证开头结尾都可见。
 */
function middleEllipsisPath(p: string, max = 44): string {
  const sep = p.includes('\\') ? '\\' : '/'
  let s = p.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
  if (s.length <= max) return s
  const parts = s.split(sep).filter((seg, i) => seg !== '' || i === 0)
  if (parts.length > 3) {
    const head = parts.slice(0, 2).join(sep)
    const tail = parts[parts.length - 1]
    s = `${head}${sep}…${sep}${tail}`
  }
  if (s.length > max) {
    const keep = Math.max(6, Math.floor((max - 1) / 2))
    s = `${s.slice(0, keep)}…${s.slice(-keep)}`
  }
  return s
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

/**
 * 假红绿灯(仅 macOS 原生全屏时渲染)—— 与真件一比一(测量驱动,check:lights 验收):
 * 原生全屏下 AppKit 把真红绿灯收进顶部悬停工具条(常驻不可见,Electron 公开 API
 * 无法钉住,见 electron#21604),这里在自绘标题栏「真件原位」画一组窗控按钮:
 * - 红 = 关闭窗口;黄 = 全屏下最小化不可用(保留原色、点击 no-op,悬停仍显 − 符号,
 *   与窗口态真件视觉一致);绿 = 退出全屏(走原生 setFullScreen(false) 同一入口)
 * - 组悬停时三枚同时出符号(macOS 行为);鼠标移到屏幕顶部呼出系统工具条时,
 *   真红绿灯会短暂与本组同屏(系统行为,无害)
 *
 * 几何与配色全部来自真件截屏基准 crop 的实测(scripts/traffic-lights-diff-check.mjs
 * 同一管线采集,ICC→sRGB 后测量;macOS 26 @2x):
 * - 三枚 12pt 圆、圆心距精确 20pt;真件圆心实测在窗口内 (18.75,17.75) 起——即
 *   trafficLightPosition {x:12,y:10} 名义位再内缩 (0.75,1.75)pt(Tahoe 实测),
 *   故容器绝对定位 left:12.75 top:11.75(绝对定位不再挤动标题栏内容,titlebar
 *   全屏保持 paddingLeft:80 与窗口态版式完全一致);
 * - 圆面名义色 #FF5F57/#FEBC2E/#28C840(实测一致),外缘 0.5pt 饱和深色 rim
 *   (实测混合值反推:红 (249,59,48)/黄 (249,169,3)/绿 (7,181,22));
 * - ×:纯色 (115,0,0),臂宽 1.15pt 圆帽,端点 ±2.2pt(含帽 bbox ±2.75pt,与
 *   窗口态及全屏工具条真件双源实测一致);
 * - −:纯色 (152,86,1),7.5×1.5pt 圆帽横杠(真件窗口态悬停实测);
 * - 全屏绿键 = 相向双三角(全屏工具条真件实测):两枚直角三角形直角顶点在圆心
 *   两侧沿反对角线错开 ~0.5pt、斜边朝外(11pt 工具条钮按 12/11 换算),色 (0,98,0)。
 */
function FakeTrafficLights(): React.JSX.Element {
  const { t } = useTranslation()
  const glyph = 'opacity-0 transition-opacity duration-75 group-hover/ftl:opacity-100'
  const btnCls = 'block h-3 w-3 p-0'
  return (
    <div
      className="group/ftl app-no-drag absolute flex"
      style={{ left: 12.75, top: 11.75, gap: 8 }}
    >
      {/* 红:关闭(悬停 ×) */}
      <button title={t('titlebar.close')} onClick={() => window.api.windowClose()} className={btnCls}>
        <svg viewBox="0 0 12 12" className="h-3 w-3">
          <circle cx="6" cy="6" r="5.75" fill="#FF5F57" stroke="rgb(249,59,48)" strokeWidth="0.5" />
          <path
            d="M3.8 3.8 L8.2 8.2 M8.2 3.8 L3.8 8.2"
            stroke="rgb(115,0,0)"
            strokeWidth="1.15"
            strokeLinecap="round"
            fill="none"
            className={glyph}
          />
        </svg>
      </button>
      {/* 黄:全屏下最小化不可用(macOS 同语义:点击 no-op;悬停仍显 −,同窗口态真件) */}
      <button title={t('titlebar.minimizeUnavailableFs')} className={`${btnCls} cursor-default`}>
        <svg viewBox="0 0 12 12" className="h-3 w-3">
          <circle cx="6" cy="6" r="5.75" fill="#FEBC2E" stroke="rgb(249,169,3)" strokeWidth="0.5" />
          <path
            d="M3 6 L9 6"
            stroke="rgb(152,86,1)"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
            className={glyph}
          />
        </svg>
      </button>
      {/* 绿:退出全屏(全屏态真件符号 = 相向双三角,直角顶点圆心相接、斜边朝外) */}
      <button
        title={t('titlebar.exitFullscreen')}
        onClick={() => window.api.windowSetFullScreen(false)}
        className={btnCls}
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3">
          <circle cx="6" cy="6" r="5.75" fill="#28C840" stroke="rgb(7,181,22)" strokeWidth="0.5" />
          <path
            d="M6.3 1.6 L6.3 5.8 L1.6 5.8 Z M5.7 6.2 L10.4 6.2 L5.7 10.4 Z"
            fill="rgb(0,98,0)"
            className={glyph}
          />
        </svg>
      </button>
    </div>
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
  const [recents, setRecents] = useState<RecentWorkspace[]>([])
  // 全屏态(macOS 原生全屏 / Win-Linux F11):挂载对账一次 + 订阅变化
  const [fullscreen, setFullscreen] = useState(false)
  const isMac = window.api.platform === 'darwin'

  useEffect(() => {
    void window.api.windowIsFullScreen().then(setFullscreen)
    return window.api.onWindowFullScreen(setFullscreen)
  }, [])

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
      .filter((r) => r.path !== props.workspaceRoot)
      .map((r) => ({
        key: r.path,
        label: baseName(r.path),
        icon: projectKindIcon(r.kind), // 项目类型图标(app/firmware/hardware/普通目录)
        hint: middleEllipsisPath(r.path), // 中间省略防横向溢出
        title: r.path, // 悬停可见完整路径
        group: t('titlebar.recentWorkspaces'),
        onSelect: () => props.onOpenWorkspacePath(r.path)
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
      key: '__device-manager__',
      label: t('titlebar.deviceManager'), // AS 设备下拉底部的「Device Manager」同位入口
      icon: <LuMonitorSmartphone />,
      group: '',
      onSelect: props.onOpenDeviceManager
    },
    {
      key: '__rescan__',
      label: t('titlebar.rescanDevices'),
      icon: <LuRefreshCw className={dev.scanning ? 'animate-spin' : ''} />,
      disabled: dev.scanning,
      onSelect: props.onRefreshDevices
    }
  ]

  const selectedDeviceLabel = selectedDeviceName(dev, t('titlebar.simulatorDevice'))

  // ---- 芯片下拉(阶段 3 接真:🔨/打包/烧录 均按此目标传参 idf.py;仅 firmware 工程渲染) ----
  const chipItems: DropdownItem[] = CHIP_TARGETS.map((c) => ({
    key: c,
    label: chipLabel(c),
    checked: dev.chip === c,
    onSelect: () => setChip(c)
  }))

  // ---- 门控矩阵 §5(隐藏而非禁用,JetBrains 惯例;fwBusy 时取消入口始终保留) ----
  const fwBusy = props.fwTask !== null
  const kind = props.projectKind
  const showRun = kind === 'app' || kind === null // null = 传统目录,兼容旧行为
  const showPush = kind === 'app'
  const showFw = kind === 'firmware'

  // ---- ⋮ 更多(固件:打包 merged.bin / 烧录… / 清理构建,仅固件工程) ----
  const moreItems: DropdownItem[] = [
    ...(showFw
      ? [
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
          }
        ]
      : []),
    // 任务进行中追加「取消」(危险项;不看工程类型,运行中任务的取消入口必须可达)
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

  // ---- ⚙ 设置(语言快捷切换经 SettingsService 落盘;「IDE 设置…」开独立设置窗口) ----
  const settingsItems: DropdownItem[] = [
    {
      key: 'zh-CN',
      label: '简体中文',
      icon: <LuLanguages />,
      group: t('settings.language'),
      checked: i18n.language === 'zh-CN',
      onSelect: () => void window.api.settingsSetMany({ 'appearance.language': 'zh-CN' })
    },
    {
      key: 'en',
      label: 'English',
      icon: <LuLanguages />,
      group: t('settings.language'),
      checked: i18n.language === 'en',
      onSelect: () => void window.api.settingsSetMany({ 'appearance.language': 'en' })
    },
    {
      key: 'ide-settings',
      label: t('settings.open'),
      icon: <LuSlidersHorizontal />,
      group: '',
      onSelect: props.onOpenSettings
    }
  ]

  return (
    <div
      // macOS 原生全屏:真红绿灯被 AppKit 收进顶部悬停工具条(常驻不可见)→ 在真件
      // 原位绝对定位渲染假红绿灯(FakeTrafficLights,红=关/黄=禁/绿=退全屏,几何与
      // 真件实测一比一);80px 预留区窗口态/全屏态恒定,内容不因假件挤动,版式完全
      // 一致;退出全屏恢复真件;拖拽区保留(原生全屏 Space 下拖拽为系统级 no-op)
      className="app-drag relative flex h-10 shrink-0 items-center gap-1 border-b border-ink-700 bg-ink-850 pr-0"
      style={{ paddingLeft: isMac ? 80 : 8 }}
      onDoubleClick={(e) => {
        // Windows/Linux:双击空白区最大化/还原(macOS 由系统处理)
        if (!isMac && e.target === e.currentTarget) window.api.windowToggleMaximize()
      }}
    >
      {/* macOS 全屏:自绘假红绿灯(原生按钮被 AppKit 收走,见组件注释) */}
      {isMac && fullscreen && <FakeTrafficLights />}

      {/* 应用图标(像素夜空,build/icon.png 同源) */}
      <img
        src={appIconUrl}
        alt="PixelBox"
        title="PixelBox"
        className="mr-1 h-[18px] w-[18px] shrink-0 rounded-[4px] object-cover"
        style={{ imageRendering: 'pixelated' }}
        draggable={false}
      />

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

        {/* 目标芯片下拉:只决定 idf.py 的编译目标,app 模拟走设备档案芯片,
            hardware 只在创建时记录 manifest.chip → 仅固件工程显示(§5) */}
        {showFw && (
          <MenuButton items={chipItems} title={t('titlebar.chip')}>
            <LuCpu className="text-jb-muted" />
            <span>{chipLabel(dev.chip)}</span>
            <LuChevronDown className="text-xs" />
          </MenuButton>
        )}

        <div className="mx-1 h-5 w-px bg-ink-700" />

        {/* ▶/⏹ 仅 app 工程与传统目录(§5);多实例:运行中仍可再次 ▶ */}
        {showRun && (
          <>
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
          </>
        )}
        {/* 🔨 构建当前目标芯片固件(仅固件工程);任务进行中变为取消(spinner),
            取消入口不看工程类型 —— fwBusy 时该钮始终可达 */}
        {(showFw || fwBusy) && (
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
        )}
        {/* 📤 推送到设备(仅 app 工程;未选真机时 App 侧先扫描再推首台) */}
        {showPush && (
          <IconButton
            title={
              props.pushBusy && props.pushPercent >= 0
                ? `${t('titlebar.pushToDevice')} ${props.pushPercent}%`
                : t('titlebar.pushToDevice')
            }
            disabled={props.pushBusy}
            onClick={props.onPush}
          >
            {props.pushBusy ? <VscLoading className="animate-spin" /> : <LuSend />}
          </IconButton>
        )}
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
