/**
 * 状态栏(高 26px,#2B2D30,顶边框 #393B40)
 * 左:工作区路径 › 当前文件面包屑 + 后台任务进度(构建/推送 spinner)
 * 右:行:列 | UTF-8 | 空格数 | git 分支下拉(列分支/切换/新建)| 当前设备名
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuGitBranch, LuPlus, LuSmartphone } from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { FirmwareTaskKind, GitBranchInfo } from '../../../shared/ipc-types'
import { chipLabel, selectedDeviceName, useDeviceProfiles, useShellDevices } from './store'
import { MenuButton, type DropdownItem } from './Dropdown'
import { InputModal } from '../components/Modal'
import { showToast } from '../components/toast'

interface Props {
  workspaceRoot: string | null
  /** 当前激活文件绝对路径 */
  activePath: string | null
  gitBranch: string | null
  /** 光标位置(无打开文件时为 null) */
  cursor: { line: number; column: number } | null
  /** 后台任务:null 无任务 */
  busy: 'build' | 'push' | null
  /** 推送进度 0-100(-1 无) */
  pushPercent: number
  /** 进行中的固件任务(阶段 3) */
  fwTask: FirmwareTaskKind | null
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 工作区名 › 相对路径分段 面包屑 */
function breadcrumb(root: string | null, file: string | null): string[] {
  if (!root) return []
  const parts = [baseName(root)]
  if (file && (file.startsWith(root + '/') || file.startsWith(root + '\\'))) {
    parts.push(...file.slice(root.length + 1).split(/[/\\]/))
  }
  return parts
}

/** git 分支块:MenuButton 列分支(点击 checkout)+ 顶部「新建分支…」 */
function GitBranchMenu({ root, branch }: { root: string; branch: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [creating, setCreating] = useState(false)

  // 分支列表刷新:分支名变化(checkout/commit 后 App 侧已刷新)+ git:changed 即时
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.api
        .gitBranches(root)
        .then((list) => {
          if (alive) setBranches(list)
        })
        .catch(() => undefined)
    }
    refresh()
    const unsub = window.api.onGitChanged((ev) => {
      if (ev.root === root) refresh()
    })
    return () => {
      alive = false
      unsub()
    }
  }, [root, branch])

  const checkout = (name: string, create: boolean): void => {
    void window.api
      .gitCheckout(root, name, create)
      .then(() => showToast(t('git.checkedOut', { name }), 'success'))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        const code = [...msg.matchAll(/git:(\w+)/g)].pop()?.[1] ?? 'failed'
        showToast(t(`git.errors.${code}`, { defaultValue: t('git.errors.failed') }), 'error')
      })
  }

  const items: DropdownItem[] = [
    {
      key: 'new-branch',
      label: t('git.newBranch'),
      icon: <LuPlus />,
      onSelect: () => setCreating(true)
    },
    ...branches.map(
      (b): DropdownItem => ({
        key: `br-${b.name}`,
        label: b.name,
        group: t('git.branches'),
        checked: b.current,
        onSelect: () => {
          if (!b.current) checkout(b.name, false)
        }
      })
    )
  ]

  return (
    <>
      <MenuButton
        items={items}
        title={t('git.switchBranch')}
        align="right"
        className="flex h-5 items-center gap-1 rounded px-1 text-xs text-jb-muted hover:bg-ink-800 hover:text-jb-text"
      >
        <LuGitBranch />
        {branch}
      </MenuButton>
      {creating && (
        <InputModal
          title={t('git.newBranchTitle')}
          placeholder={t('git.newBranchPlaceholder')}
          onConfirm={(name) => {
            setCreating(false)
            checkout(name, true)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </>
  )
}

export function StatusBar(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  const dev = useShellDevices()
  useDeviceProfiles() // 档案变化(重命名/删除)时刷新右侧设备名
  const crumbs = breadcrumb(props.workspaceRoot, props.activePath)

  return (
    <div className="flex h-[26px] shrink-0 items-center gap-3 border-t border-ink-700 bg-ink-850 px-3 text-xs text-jb-muted">
      {/* 左:面包屑 + 后台任务 */}
      <div className="flex min-w-0 items-center gap-1 truncate" title={props.activePath ?? props.workspaceRoot ?? ''}>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-ink-500">›</span>}
            <span className={i === crumbs.length - 1 ? 'text-jb-text' : undefined}>{c}</span>
          </span>
        ))}
      </div>
      {props.busy && (
        <span className="flex shrink-0 items-center gap-1.5 text-accent">
          <VscLoading className="animate-spin" />
          {props.busy === 'build'
            ? t('statusbar.building')
            : props.pushPercent >= 0
              ? t('statusbar.pushingPercent', { percent: props.pushPercent })
              : t('statusbar.pushing')}
        </span>
      )}
      {/* 固件任务(构建/打包/烧录/清理)进行中 */}
      {props.fwTask && (
        <span className="flex shrink-0 items-center gap-1.5 text-accent">
          <VscLoading className="animate-spin" />
          {t(`fw.status.${props.fwTask}`)} · {chipLabel(dev.chip)}
        </span>
      )}

      {/* 右:行列 / 编码 / 缩进 / 分支 / 设备 */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {props.cursor && (
          <span>
            {props.cursor.line}:{props.cursor.column}
          </span>
        )}
        <span>UTF-8</span>
        <span>{t('statusbar.spaces', { count: 2 })}</span>
        {props.gitBranch && props.workspaceRoot && (
          <GitBranchMenu root={props.workspaceRoot} branch={props.gitBranch} />
        )}
        <span className="flex items-center gap-1">
          <LuSmartphone />
          {selectedDeviceName(dev, t('titlebar.simulatorDevice'))}
        </span>
      </div>
    </div>
  )
}
