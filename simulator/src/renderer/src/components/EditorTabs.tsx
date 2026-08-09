/**
 * 编辑器标签栏(JetBrains 风格:标签栏 #2B2D30,激活标签下缘 2px 蓝条)
 * - 多标签切换 / 关闭,未保存显示圆点,中键关闭
 * - 右键菜单(IDE v3.x):关闭 / 关闭其他 / 关闭未修改 / 左右拆分 / 上下拆分
 *   (拆分 = 在另一编辑器组打开该文件;diff/虚拟页签无模型,不参与拆分)
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VscClose, VscCircleFilled, VscLock } from 'react-icons/vsc'
import { LuGitCompare } from 'react-icons/lu'
import { fileIconFor } from './fileIcons'
import type { DiffSpec } from '../editor/DiffView'

export interface TabInfo {
  path: string
  name: string
  /** 虚拟库页签(extraLib 声明,⌘+点击跳转打开):只读、不进会话 */
  virtual?: boolean
  /** 页签类型:'diff' = Git diff 页签(EditorHost hidden + DiffView 兄弟节点) */
  kind?: 'diff'
  /** diff 页签参数(kind='diff' 时有效;path 为合成键 pbdiff://…) */
  diff?: DiffSpec
}

interface Props {
  tabs: TabInfo[]
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /** 右键菜单:关闭本组其他页签(有未保存修改的保留) */
  onCloseOthers?: (path: string) => void
  /** 右键菜单:关闭本组全部未修改页签 */
  onCloseUnmodified?: () => void
  /** 右键菜单:左右/上下拆分(在另一组打开该文件;已分屏时方向沿用现有布局) */
  onSplit?: (dir: 'row' | 'col', path: string) => void
  /** 当前分屏方向(null = 未分屏;非 null 时两个拆分项合并为「在另一分组打开」) */
  splitDir?: 'row' | 'col' | null
  /** 标签栏右端附加控件(Markdown 编辑/分屏/预览切换等) */
  trailing?: React.ReactNode
}

/** 右键菜单状态(fixed 定位;点击外部/Esc/选择后关闭) */
interface CtxMenu {
  x: number
  y: number
  tab: TabInfo
}

export function EditorTabs({
  tabs,
  activePath,
  dirtyPaths,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseUnmodified,
  onSplit,
  splitDir,
  trailing
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击菜单外任意处 / Esc 关闭
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
        setMenu(null)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  const menuItem = (
    label: string,
    onPick: () => void,
    disabled = false
  ): React.JSX.Element => (
    <button
      key={label}
      disabled={disabled}
      onClick={() => {
        setMenu(null)
        onPick()
      }}
      className={`block w-full whitespace-nowrap px-3 py-1 text-left text-[13px] ${
        disabled ? 'cursor-not-allowed text-ink-600' : 'text-jb-text hover:bg-jb-selection'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-ink-700 bg-ink-850">
      {tabs.map((tab) => {
        const active = tab.path === activePath
        const dirty = dirtyPaths.has(tab.path)
        return (
          <div
            key={tab.path}
            title={tab.path}
            onClick={() => onSelect(tab.path)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, tab })
            }}
            onMouseDown={(e) => {
              // 中键关闭
              if (e.button === 1) {
                e.preventDefault()
                onClose(tab.path)
              }
            }}
            className={`group relative flex cursor-pointer items-center gap-1.5 px-3 text-[13px] ${
              active
                ? 'bg-ink-900 text-jb-text'
                : 'bg-ink-850 text-jb-muted hover:bg-ink-800 hover:text-jb-text'
            }`}
          >
            {/* 文件类型图标(fileIcons 图标集,与文件树/⌘P 一致);虚拟库页签用锁标识只读;diff 页签用对比图标 */}
            {tab.kind === 'diff' ? (
              <LuGitCompare className="shrink-0 text-jb-muted" />
            ) : tab.virtual ? (
              <VscLock className="shrink-0 text-jb-muted" />
            ) : (
              fileIconFor(tab.name)
            )}
            <span className="max-w-[180px] truncate">{tab.name}</span>
            <button
              className="flex h-4 w-4 items-center justify-center rounded hover:bg-ink-700"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.path)
              }}
            >
              {dirty ? (
                <VscCircleFilled className="text-accent group-hover:hidden" />
              ) : (
                <VscClose className="opacity-0 group-hover:opacity-100" />
              )}
              {dirty && <VscClose className="hidden group-hover:block" />}
            </button>
            {/* 激活标签下缘 2px 蓝条 */}
            {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          </div>
        )
      })}
      {trailing && (
        <div className="sticky right-0 ml-auto flex shrink-0 items-center bg-ink-850 px-1">{trailing}</div>
      )}
      {menu && (
        <div
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-[600] min-w-[160px] rounded border border-ink-600 bg-ink-850 py-1 shadow-lg"
        >
          {menuItem(t('editorTabs.close'), () => onClose(menu.tab.path))}
          {onCloseOthers &&
            menuItem(
              t('editorTabs.closeOthers'),
              () => onCloseOthers(menu.tab.path),
              tabs.length <= 1
            )}
          {onCloseUnmodified && menuItem(t('editorTabs.closeUnmodified'), () => onCloseUnmodified())}
          {onSplit && <div className="my-1 h-px bg-ink-700" />}
          {onSplit &&
            (splitDir == null ? (
              <>
                {menuItem(
                  t('editorTabs.splitRight'),
                  () => onSplit('row', menu.tab.path),
                  menu.tab.kind === 'diff' || menu.tab.virtual === true
                )}
                {menuItem(
                  t('editorTabs.splitDown'),
                  () => onSplit('col', menu.tab.path),
                  menu.tab.kind === 'diff' || menu.tab.virtual === true
                )}
              </>
            ) : (
              menuItem(
                t('editorTabs.openInOtherGroup'),
                () => onSplit(splitDir, menu.tab.path),
                menu.tab.kind === 'diff' || menu.tab.virtual === true
              )
            ))}
        </div>
      )}
    </div>
  )
}
