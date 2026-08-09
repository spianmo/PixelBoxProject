/**
 * 集成终端工具窗(JetBrains 式,阶段 1/2)
 *
 * 组成:
 * - TerminalHeader:嵌入 ToolWindow 头部 —— Terminal 文字 + 会话 tab 条
 *   (根未拆分时;每个 tab 带 ✕,双击重命名,右键拆分菜单)+ [+] 新建 + [˅] 会话下拉
 * - TerminalHeaderActions:头部右端 ⋮ 菜单(新建/向右拆分/向下拆分/清屏/关闭会话)
 * - TerminalPanel:内容区 —— pipe 兜底横幅 + 分栏树递归渲染 + ⌘F 搜索条
 *
 * 布局树渲染:split 节点 = flex 两分栏 + 分隔条拖拽(增量像素→占比);
 * group 节点 = (根已拆分时的组内 tab 条)+ 激活会话的 TermPane。
 * xterm 实例常驻 xtermRegistry,TermPane 只负责 attach/detach 与 ResizeObserver→fit,
 * 工具窗隐藏重开 / 日志⇄终端切换不丢会话与滚回缓冲。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LuChevronDown,
  LuChevronUp,
  LuEllipsisVertical,
  LuPlus,
  LuSquareTerminal,
  LuTriangleAlert,
  LuX
} from 'react-icons/lu'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { DragHandle } from '../components/DragHandle'
import { MenuButton, type DropdownItem } from '../shell/Dropdown'
import {
  allGroups,
  closeSession,
  ensureSession,
  findGroup,
  firstGroup,
  initTerminals,
  newSession,
  renameSession,
  adjustSplitRatio,
  setActiveTab,
  setFocusedGroup,
  setSearchSession,
  splitGroup,
  useTerminalStore,
  type TermGroup,
  type TermNode,
  type TermSplit,
  type TerminalState
} from './store'
import {
  attachTerm,
  detachTerm,
  fitTerm,
  focusTerm,
  getTermInstance,
  setSearchRequestHandler
} from './xtermRegistry'
import { useViewModeMenus } from '../shell/viewMode'
import type { TerminalSessionInfo } from '../../../shared/ipc-types'

// ⌘F(xterm 内捕获)→ 打开对应会话的搜索条(模块加载即接线,注册表回调常驻)
setSearchRequestHandler((sessionId) => setSearchSession(sessionId))

/** 焦点组的激活会话(header 动作目标;树空时 null) */
function focusedActiveSession(st: TerminalState): string | null {
  const g = findGroup(st.root, st.focusedGroup) ?? firstGroup(st.root)
  return g.active
}

/** 新建会话并聚焦(RAF 等 React 提交完 attach 后再 focus) */
function newSessionFocused(groupId?: string): void {
  void newSession(groupId).then((id) => {
    if (id) requestAnimationFrame(() => focusTerm(id))
  })
}

// ---------------------------------------------------------------
// 会话 tab 条(header 与组内共用)
// ---------------------------------------------------------------

interface TabMenuState {
  x: number
  y: number
  sessionId: string
}

function SessionTab(props: {
  info: TerminalSessionInfo
  active: boolean
  onSelect: () => void
  onMenu: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = (): void => {
    setRenaming(false)
    renameSession(props.info.id, draft)
  }

  return (
    <div
      role="tab"
      onClick={props.onSelect}
      onDoubleClick={() => {
        setDraft(props.info.name)
        setRenaming(true)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        // 不冒泡到 ToolWindow 头部(那里的右键是「视图模式」菜单)
        e.stopPropagation()
        props.onMenu(e)
      }}
      className={`relative flex shrink-0 cursor-pointer items-center gap-1 px-2.5 text-xs ${
        props.active ? 'text-jb-text' : 'text-jb-muted hover:text-jb-text'
      }`}
    >
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
              setRenaming(false)
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-5 w-24 rounded border border-accent bg-ink-900 px-1 text-xs text-jb-text outline-none"
        />
      ) : (
        <span className="max-w-[160px] truncate">{props.info.name}</span>
      )}
      <span
        title={t('terminal.close')}
        onClick={(e) => {
          e.stopPropagation()
          closeSession(props.info.id)
        }}
        className="flex h-4 w-4 items-center justify-center rounded text-jb-muted hover:bg-ink-700 hover:text-jb-text"
      >
        <LuX className="text-[11px]" />
      </span>
      {props.active && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />}
    </div>
  )
}

function TabStrip(props: {
  group: TermGroup
  sessions: Record<string, TerminalSessionInfo>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<TabMenuState | null>(null)

  const menuItems = (sessionId: string): MenuItem[] => [
    { label: t('terminal.splitRight'), onClick: () => void splitGroup(props.group.id, 'row') },
    { label: t('terminal.splitDown'), onClick: () => void splitGroup(props.group.id, 'column') },
    { label: t('terminal.close'), danger: true, onClick: () => closeSession(sessionId) }
  ]

  return (
    <div className="flex h-full min-w-0 items-stretch overflow-x-auto">
      {props.group.tabs.map((sid) => {
        const info = props.sessions[sid]
        if (!info) return null
        return (
          <SessionTab
            key={sid}
            info={info}
            active={props.group.active === sid}
            onSelect={() => {
              setActiveTab(props.group.id, sid)
              requestAnimationFrame(() => focusTerm(sid))
            }}
            onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, sessionId: sid })}
          />
        )
      })}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.sessionId)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------
// ToolWindow 头部(Terminal 文字 + tab 条 + [+] + [˅])与右端 ⋮
// ---------------------------------------------------------------

export function TerminalHeader(): React.JSX.Element {
  const { t } = useTranslation()
  const st = useTerminalStore()
  // 根未拆分:tab 条直接放头部(JetBrains 常态);已拆分时各组自带 tab 条
  const rootGroup = st.root.kind === 'group' ? st.root : null

  // [˅] 会话下拉:全部组的全部会话(选中 → 激活并聚焦)
  const sessionItems: DropdownItem[] = allGroups(st.root).flatMap((g) =>
    g.tabs.map((sid) => {
      const info = st.sessions[sid]
      return {
        key: sid,
        label: info?.name ?? sid,
        checked: g.active === sid && st.focusedGroup === g.id,
        onSelect: () => {
          setActiveTab(g.id, sid)
          requestAnimationFrame(() => focusTerm(sid))
        }
      }
    })
  )

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-0.5">
      <span className="mr-1 flex shrink-0 items-center gap-1.5 text-xs font-medium text-jb-text">
        <LuSquareTerminal className="text-jb-muted" />
        {t('terminal.title')}
      </span>
      {rootGroup && <TabStrip group={rootGroup} sessions={st.sessions} />}
      <button
        title={t('terminal.newSession')}
        onClick={() => newSessionFocused()}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
      >
        <LuPlus />
      </button>
      <MenuButton
        title={t('terminal.sessionList')}
        items={sessionItems}
        className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
      >
        <LuChevronDown className="text-[11px]" />
      </MenuButton>
    </div>
  )
}

/**
 * 头部右端 ⋮ 菜单(ToolWindow actions 槽;隐藏 — 按钮由 ToolWindow 提供)
 * viewMode=true 时在菜单尾部并入「视图模式」组(主窗停靠/浮动场景;
 * 独立窗口内不传,避免自我切换)—— ToolWindow 侧对应传 viewModeButton=false 防止双 ⋮
 */
export function TerminalHeaderActions(props: { viewMode?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const st = useTerminalStore()
  const active = focusedActiveSession(st)
  const vmMenus = useViewModeMenus(props.viewMode ? 'terminal' : null)

  const items: DropdownItem[] = [
    { key: 'new', label: t('terminal.newSession'), onSelect: () => newSessionFocused() },
    {
      key: 'split-right',
      label: t('terminal.splitRight'),
      group: '',
      disabled: active === null,
      onSelect: () => void splitGroup(st.focusedGroup, 'row')
    },
    {
      key: 'split-down',
      label: t('terminal.splitDown'),
      disabled: active === null,
      onSelect: () => void splitGroup(st.focusedGroup, 'column')
    },
    {
      key: 'clear',
      label: t('terminal.clear'),
      group: '',
      disabled: active === null,
      onSelect: () => {
        if (active) getTermInstance(active)?.term.clear()
      }
    },
    {
      key: 'close',
      label: t('terminal.close'),
      danger: true,
      disabled: active === null,
      onSelect: () => {
        if (active) closeSession(active)
      }
    },
    // 视图模式组(五态;主窗场景并入终端自身 ⋮,避免头部出现两个 ⋮)
    ...vmMenus.dropdown
  ]

  return (
    <MenuButton
      title={t('terminal.more')}
      items={items}
      align="right"
      className="flex h-6 w-6 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
    >
      <LuEllipsisVertical />
    </MenuButton>
  )
}

// ---------------------------------------------------------------
// ⌘F 搜索条(激活会话上覆盖,Enter 下一个 / Shift+Enter 上一个 / Esc 关闭)
// ---------------------------------------------------------------

function SearchBar({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const find = (dir: 'next' | 'prev', q = query): void => {
    const inst = getTermInstance(sessionId)
    if (!inst || q.length === 0) return
    if (dir === 'next') inst.search.findNext(q)
    else inst.search.findPrevious(q)
  }

  const close = (): void => {
    setSearchSession(null)
    focusTerm(sessionId)
  }

  return (
    <div className="absolute right-3 top-1 z-10 flex items-center gap-0.5 rounded border border-ink-600 bg-ink-850 px-1 py-0.5 shadow-xl">
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          // 增量搜索:输入即定位第一个匹配
          const inst = getTermInstance(sessionId)
          if (inst && e.target.value.length > 0) inst.search.findNext(e.target.value, { incremental: true })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? 'prev' : 'next')
          if (e.key === 'Escape') {
            e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
            close()
          }
        }}
        placeholder={t('terminal.searchPlaceholder')}
        spellCheck={false}
        className="h-5 w-44 rounded border border-ink-600 bg-ink-900 px-1.5 font-mono text-xs text-jb-text outline-none placeholder:text-ink-500 focus:border-accent"
      />
      <button
        title={t('terminal.searchPrev')}
        onClick={() => find('prev')}
        className="flex h-5 w-5 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
      >
        <LuChevronUp className="text-[11px]" />
      </button>
      <button
        title={t('terminal.searchNext')}
        onClick={() => find('next')}
        className="flex h-5 w-5 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
      >
        <LuChevronDown className="text-[11px]" />
      </button>
      <button
        title={t('terminal.searchClose')}
        onClick={close}
        className="flex h-5 w-5 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
      >
        <LuX className="text-[11px]" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------
// 终端渲染面(常驻 holder 的 attach/detach + ResizeObserver → fit → pty resize)
// ---------------------------------------------------------------

function TermPane({ sessionId }: { sessionId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    attachTerm(sessionId, host)
    fitTerm(sessionId)
    // 尺寸变化(分隔条拖拽/底部区高度调整/隐藏重开)→ fit → term.onResize → pty resize
    const ro = new ResizeObserver(() => fitTerm(sessionId))
    ro.observe(host)
    return () => {
      ro.disconnect()
      detachTerm(sessionId, host)
    }
  }, [sessionId])

  return <div ref={hostRef} className="h-full min-h-0 w-full min-w-0 overflow-hidden pl-1.5 pt-1" />
}

// ---------------------------------------------------------------
// 分栏树递归渲染
// ---------------------------------------------------------------

function GroupPane(props: {
  group: TermGroup
  sessions: Record<string, TerminalSessionInfo>
  /** 根已拆分时组内自带 tab 条 */
  showTabs: boolean
  focused: boolean
  searchSession: string | null
}): React.JSX.Element {
  const { group } = props

  return (
    <div
      className={`relative flex h-full min-h-0 w-full min-w-0 flex-col ${
        // 多分栏时以边框弱标识焦点组(拆分/新建会话的目标)
        props.showTabs && props.focused ? 'ring-1 ring-inset ring-ink-600' : ''
      }`}
      onMouseDownCapture={() => setFocusedGroup(group.id)}
    >
      {props.showTabs && (
        <div className="flex h-7 shrink-0 items-stretch border-b border-ink-700 bg-ink-850 pl-1">
          <TabStrip group={group} sessions={props.sessions} />
          <button
            onClick={() => newSessionFocused(group.id)}
            className="flex w-6 shrink-0 items-center justify-center text-jb-muted hover:text-jb-text"
          >
            <LuPlus className="text-[12px]" />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {group.active && <TermPane key={group.active} sessionId={group.active} />}
        {group.active && props.searchSession === group.active && <SearchBar sessionId={group.active} />}
      </div>
    </div>
  )
}

function SplitPane(props: {
  split: TermSplit
  sessions: Record<string, TerminalSessionInfo>
  focusedGroup: string
  searchSession: string | null
}): React.JSX.Element {
  const { split } = props
  const boxRef = useRef<HTMLDivElement>(null)
  const row = split.dir === 'row'

  const childProps = {
    sessions: props.sessions,
    focusedGroup: props.focusedGroup,
    searchSession: props.searchSession
  }
  return (
    <div ref={boxRef} className={`flex h-full min-h-0 w-full min-w-0 ${row ? 'flex-row' : 'flex-col'}`}>
      <div style={{ flexGrow: split.ratio, flexBasis: 0 }} className="min-h-0 min-w-0 overflow-hidden">
        <TreeNode node={split.a} {...childProps} />
      </div>
      <DragHandle
        orientation={row ? 'vertical' : 'horizontal'}
        onDelta={(px) => {
          // 增量像素 → 占比增量(容器实时尺寸,窗口缩放亦正确)
          const el = boxRef.current
          if (!el) return
          const size = row ? el.clientWidth : el.clientHeight
          if (size > 0) adjustSplitRatio(split.id, px / size)
        }}
      />
      <div style={{ flexGrow: 1 - split.ratio, flexBasis: 0 }} className="min-h-0 min-w-0 overflow-hidden">
        <TreeNode node={split.b} {...childProps} />
      </div>
    </div>
  )
}

function TreeNode(props: {
  node: TermNode
  sessions: Record<string, TerminalSessionInfo>
  focusedGroup: string
  searchSession: string | null
}): React.JSX.Element {
  const node = props.node
  if (node.kind === 'split') {
    return (
      <SplitPane
        split={node}
        sessions={props.sessions}
        focusedGroup={props.focusedGroup}
        searchSession={props.searchSession}
      />
    )
  }
  return (
    <GroupPane
      group={node}
      sessions={props.sessions}
      showTabs
      focused={props.focusedGroup === node.id}
      searchSession={props.searchSession}
    />
  )
}

// ---------------------------------------------------------------
// 内容区主组件
// ---------------------------------------------------------------

export function TerminalPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const st = useTerminalStore()

  // 打开即初始化(事件订阅幂等)并保证至少一个会话
  useEffect(() => {
    initTerminals()
    ensureSession()
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-900">
      {/* pipe 兜底模式横幅(node-pty 加载失败时明示体验受限;底色/文字随主题) */}
      {st.backend === 'pipe' && (
        <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-ink-700 bg-[rgb(var(--pb-banner-warn-bg))] px-2 text-xs text-yellow-300">
          <LuTriangleAlert className="shrink-0" />
          <span className="truncate">{t('terminal.pipeBanner')}</span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {st.root.kind === 'group' ? (
          <GroupPane
            group={st.root}
            sessions={st.sessions}
            showTabs={false}
            focused
            searchSession={st.searchSession}
          />
        ) : (
          <TreeNode
            node={st.root}
            sessions={st.sessions}
            focusedGroup={st.focusedGroup}
            searchSession={st.searchSession}
          />
        )}
      </div>
    </div>
  )
}
