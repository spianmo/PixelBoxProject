/**
 * IDE 设置独立窗口(renderer 壳)—— main.tsx 检测 ?window=settings 分流渲染
 *
 * 结构(对齐 JetBrains Settings 对话框):
 * - 顶部 36px 拖拽条(macOS 红绿灯让位;Windows/Linux 自绘最小化/关闭)
 * - 左栏 240px:圆角搜索框(输入即过滤分类树并高亮命中页,回车跳首个命中)
 *   + 可折叠分类树(chevron;选中行整行蓝底)
 * - 右侧:面包屑(外观与行为 › 外观)+ 返回/前进历史箭头(浏览过的页面栈)
 *   + 内容区(JetBrains 表单风)+ 底部右对齐 取消/应用/确定(确定主色蓝)
 *
 * 草稿语义(draft.tsx):页面读写草稿,Apply/OK 才 settings:set-many 落盘并广播,
 * Cancel/Esc 丢弃关窗;Apply 仅 dirty 可用;切页保留草稿;✕ 关窗且 dirty 时确认框
 * (main 侧 close 拦截 → settings:close-request → 本组件裁决)。
 * 界面语言草稿即时预览(setLanguagePreview),Apply 落盘后随广播全窗口生效。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LuArrowLeft,
  LuArrowRight,
  LuChevronDown,
  LuChevronRight,
  LuMinus,
  LuSearch,
  LuSettings,
  LuX
} from 'react-icons/lu'
import type { UiLanguage } from '../../../shared/ipc-types'
import { getAtPath, sanitizeSetting } from '../../../shared/settingsSchema'
import { ConfirmModal } from '../components/Modal'
import { useSettingsMirror, setLanguagePreview } from './store'
import { SettingsDraftContext, type SettingsDraftApi } from './draft'
import {
  SETTINGS_PAGES,
  buildCategoryTree,
  collectMatches,
  pageById,
  pageMatches,
  type CategoryTreeNode,
  type SettingsPage,
  type TreeNode
} from './registry'

const DEFAULT_PAGE = SETTINGS_PAGES[0]?.id ?? 'appearance'

// ---------------------------------------------------------------
// 左栏:分类树(可折叠 + 搜索过滤/高亮)
// ---------------------------------------------------------------

function TreeRows(props: {
  nodes: TreeNode[]
  depth: number
  query: string
  selected: string
  collapsed: Set<string>
  titleOf: (p: SettingsPage) => string
  onToggle: (id: string) => void
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { nodes, depth, query, titleOf } = props
  const filtering = query.trim().length > 0

  /** 子树内是否有命中页(过滤模式下决定分类是否显示) */
  const hasMatch = (n: TreeNode): boolean => {
    if (n.kind === 'page') return pageMatches(n.page, query, titleOf(n.page))
    return n.children.some(hasMatch)
  }

  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'category') {
          if (filtering && !hasMatch(node)) return null
          // 过滤模式强制展开命中分支;常态遵循折叠状态
          const collapsed = !filtering && props.collapsed.has(node.id)
          return (
            <CategoryRow
              key={node.id}
              node={node}
              depth={depth}
              collapsed={collapsed}
              onToggle={() => props.onToggle(node.id)}
            >
              {!collapsed && <TreeRows {...props} nodes={node.children} depth={depth + 1} />}
            </CategoryRow>
          )
        }
        const title = titleOf(node.page)
        const matched = pageMatches(node.page, query, title)
        if (filtering && !matched) return null
        return (
          <PageRow
            key={node.page.id}
            title={title}
            depth={depth}
            query={query}
            highlight={filtering && matched}
            selected={props.selected === node.page.id}
            onSelect={() => props.onSelect(node.page.id)}
          />
        )
      })}
    </>
  )
}

function CategoryRow(props: {
  node: CategoryTreeNode
  depth: number
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <button
        onClick={props.onToggle}
        className="flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[13px] text-jb-text hover:bg-ink-800"
        style={{ paddingLeft: 8 + props.depth * 14 }}
      >
        <span className="flex w-4 shrink-0 items-center justify-center text-jb-muted">
          {props.collapsed ? <LuChevronRight className="text-xs" /> : <LuChevronDown className="text-xs" />}
        </span>
        {t(props.node.labelKey)}
      </button>
      {props.children}
    </div>
  )
}

/** 命中片段高亮(标题子串匹配时加亮;仅关键词命中时整行提亮) */
function HighlightedTitle({ title, query }: { title: string; query: string }): React.JSX.Element {
  const q = query.trim().toLowerCase()
  const at = q.length > 0 ? title.toLowerCase().indexOf(q) : -1
  if (at < 0) return <>{title}</>
  return (
    <>
      {title.slice(0, at)}
      <span className="rounded-sm bg-accent/30 text-jb-text">{title.slice(at, at + q.length)}</span>
      {title.slice(at + q.length)}
    </>
  )
}

function PageRow(props: {
  title: string
  depth: number
  query: string
  highlight: boolean
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={props.onSelect}
      className={`flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[13px] ${
        props.selected
          ? 'bg-jb-selection text-jb-text' // 选中行整行蓝底
          : props.highlight
            ? 'text-jb-text hover:bg-ink-800'
            : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
      }`}
      style={{ paddingLeft: 8 + props.depth * 14 + 20 }}
    >
      <span className="truncate">
        <HighlightedTitle title={props.title} query={props.query} />
      </span>
    </button>
  )
}

// ---------------------------------------------------------------
// 设置窗口主体
// ---------------------------------------------------------------

export function SettingsWindow(): React.JSX.Element {
  const { t } = useTranslation()
  const isMac = window.api.platform === 'darwin'
  const mirror = useSettingsMirror()
  const saved = mirror.settings

  // ---- 草稿(dot-path → 值;仅存与 saved 不同的键) ----
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const dirty = Object.keys(draft).length > 0

  // ---- 页面选中 + 浏览历史(返回/前进) ----
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({
    stack: [DEFAULT_PAGE],
    index: 0
  })
  const currentId = history.stack[history.index] ?? DEFAULT_PAGE
  const currentPage = pageById(currentId)

  const navigate = useCallback((pageId: string): void => {
    setHistory((h) => {
      if (h.stack[h.index] === pageId) return h
      const stack = [...h.stack.slice(0, h.index + 1), pageId]
      return { stack, index: stack.length - 1 }
    })
  }, [])
  const goBack = (): void => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }))
  const goForward = (): void =>
    setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }))

  // ---- 搜索 + 树折叠 ----
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildCategoryTree(SETTINGS_PAGES), [])
  const titleOf = useCallback((p: SettingsPage): string => t(p.titleKey), [t])

  const toggleCategory = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 回车跳首个命中页 */
  const jumpFirstMatch = (): void => {
    const first = collectMatches(tree, query, titleOf)[0]
    if (first) navigate(first.id)
  }

  // ---- 草稿 API(页面组件经 context 读写) ----
  const draftApi = useMemo<SettingsDraftApi>(
    () => ({
      saved,
      draft,
      dirty,
      get: (path) => (path in draft ? draft[path] : getAtPath(saved, path)),
      set: (path, value) => {
        // 先过 schema 校验(坏值不进草稿,Apply 永远是干净补丁)
        const clean = sanitizeSetting(path, value)
        if (clean === undefined) return
        setDraft((d) => {
          if (getAtPath(saved, path) === clean) {
            if (!(path in d)) return d
            const next = { ...d }
            delete next[path] // 改回原值:出栈
            return next
          }
          return { ...d, [path]: clean }
        })
      }
    }),
    [saved, draft, dirty]
  )

  // 镜像更新(Apply 落盘 / 其他窗口改设置)后:草稿中与新基线相同的键自动出栈
  useEffect(() => {
    setDraft((d) => {
      const next: Record<string, unknown> = {}
      let changed = false
      for (const [path, value] of Object.entries(d)) {
        if (getAtPath(saved, path) === value) changed = true
        else next[path] = value
      }
      return changed ? next : d
    })
  }, [saved])

  // ---- 界面语言立即预览(草稿值驱动;丢弃/落盘后回落) ----
  const draftLanguage = (draft['appearance.language'] as UiLanguage | undefined) ?? null
  useEffect(() => {
    setLanguagePreview(draftLanguage)
    return () => setLanguagePreview(null) // 卸载兜底还原
  }, [draftLanguage])

  // ---- Apply / Cancel / OK / 关窗 ----
  const [confirmClose, setConfirmClose] = useState(false)

  const apply = useCallback(async (): Promise<void> => {
    const patch = draft
    if (Object.keys(patch).length === 0) return
    await window.api.settingsSetMany(patch)
    setDraft({}) // 广播回流会同步镜像;此处立即清草稿保证按钮态即时
  }, [draft])

  /** Cancel/Esc:丢弃草稿并关窗(JetBrains Cancel 不弹确认) */
  const cancel = useCallback((): void => {
    setDraft({})
    setLanguagePreview(null)
    void window.api.settingsWindowClose()
  }, [])

  const okAndClose = useCallback(async (): Promise<void> => {
    await apply()
    void window.api.settingsWindowClose()
  }, [apply])

  // ✕ 关窗请求(main 拦截转发):dirty 时确认框,否则直接关
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    return window.api.onSettingsCloseRequest(() => {
      if (dirtyRef.current) setConfirmClose(true)
      else void window.api.settingsWindowClose()
    })
    // dirty 经 ref 读取,订阅仅挂载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc = Cancel 语义(确认框打开时交给确认框自身处理)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (confirmClose) return
      // 输入框内 Esc 先失焦,再次 Esc 才关窗(贴近 JetBrains 行为)
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
        el.blur()
        return
      }
      cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel, confirmClose])

  // ---- 面包屑(分类路径 › 页面标题) ----
  const breadcrumb = currentPage
    ? [...currentPage.category.map((c) => t(c.labelKey)), t(currentPage.titleKey)]
    : []

  const PageComponent = currentPage?.Component

  return (
    <div className="flex h-full flex-col bg-ink-900 text-jb-text">
      {/* 顶部拖拽条(深色壳;macOS 红绿灯让位) */}
      <div
        className="app-drag flex h-9 shrink-0 items-center gap-1.5 border-b border-ink-700 bg-ink-850"
        style={{ paddingLeft: isMac ? 80 : 10 }}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-jb-text">
          <LuSettings className="text-jb-muted" />
          {t('settings.title')}
          <span className="text-jb-muted">— PixelBox</span>
        </span>
        {!isMac && (
          <div className="app-no-drag ml-auto flex h-full items-stretch">
            <button
              title={t('titlebar.minimize')}
              onClick={() => window.api.windowMinimize()}
              className="flex w-11 items-center justify-center text-jb-muted hover:bg-ink-800 hover:text-jb-text"
            >
              <LuMinus />
            </button>
            <button
              title={t('titlebar.close')}
              onClick={() => window.api.windowClose()}
              className="flex w-11 items-center justify-center text-jb-muted hover:bg-red-600 hover:text-white"
            >
              <LuX />
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左栏:搜索 + 分类树 */}
        <div className="flex w-[240px] shrink-0 flex-col border-r border-ink-700 bg-ink-850">
          <div className="relative m-2">
            <LuSearch className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[13px] text-ink-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jumpFirstMatch()
              }}
              placeholder={t('settings.searchPlaceholder')}
              spellCheck={false}
              className="h-7 w-full rounded-md border border-ink-600 bg-ink-900 pl-7 pr-2 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            <TreeRows
              nodes={tree}
              depth={0}
              query={query}
              selected={currentId}
              collapsed={collapsed}
              titleOf={titleOf}
              onToggle={toggleCategory}
              onSelect={navigate}
            />
          </div>
        </div>

        {/* 右侧:面包屑 + 内容 + 底部按钮 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-ink-700 px-2">
            <button
              title={t('settings.back')}
              disabled={history.index === 0}
              onClick={goBack}
              className="flex h-6 w-6 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:cursor-not-allowed disabled:text-ink-600 disabled:hover:bg-transparent"
            >
              <LuArrowLeft />
            </button>
            <button
              title={t('settings.forward')}
              disabled={history.index >= history.stack.length - 1}
              onClick={goForward}
              className="flex h-6 w-6 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:cursor-not-allowed disabled:text-ink-600 disabled:hover:bg-transparent"
            >
              <LuArrowRight />
            </button>
            <div className="ml-1 flex min-w-0 items-center gap-1 text-[13px]">
              {breadcrumb.map((label, i) => (
                <span key={`${label}-${i}`} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <span className="text-ink-500">›</span>}
                  <span
                    className={
                      i === breadcrumb.length - 1
                        ? 'truncate font-medium text-jb-text'
                        : 'truncate text-jb-muted'
                    }
                  >
                    {label}
                  </span>
                </span>
              ))}
            </div>
          </div>

          {/* 内容区(草稿 context 内渲染当前页) */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <SettingsDraftContext.Provider value={draftApi}>
              {PageComponent ? (
                <PageComponent />
              ) : (
                <div className="text-[13px] text-ink-500">{t('settings.pageMissing')}</div>
              )}
            </SettingsDraftContext.Provider>
          </div>

          {/* 底部按钮:取消 / 应用 / 确定(确定主色蓝;应用仅 dirty 可用) */}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-700 px-4 py-2.5">
            <button
              onClick={cancel}
              className="rounded border border-ink-500 px-3.5 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={!dirty}
              onClick={() => void apply()}
              className="rounded border border-ink-500 px-3.5 py-1 text-[13px] text-gray-300 hover:bg-ink-700 disabled:cursor-not-allowed disabled:border-ink-700 disabled:text-ink-500 disabled:hover:bg-transparent"
            >
              {t('settings.apply')}
            </button>
            <button
              onClick={() => void okAndClose()}
              className="rounded bg-accent-dim px-3.5 py-1 text-[13px] text-white hover:bg-accent"
            >
              {t('common.ok')}
            </button>
          </div>
        </div>
      </div>

      {/* ✕ 关窗且有未应用修改:确认丢弃 */}
      {confirmClose && (
        <ConfirmModal
          message={t('settings.discardConfirm')}
          onConfirm={() => {
            setConfirmClose(false)
            cancel()
          }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </div>
  )
}
