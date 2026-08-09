/**
 * 标题栏用下拉组件(JetBrains 风格,紧凑密度,4px 内圆角)
 * - MenuButton:按钮 + 菜单项列表(分组标题 / 选中勾 / 禁用 / 危险项)
 * - PopoverButton:按钮 + 任意自定义内容(通知列表等)
 * 均为轻量非受控:点击外部 / Esc 关闭
 */
import { useEffect, useRef, useState } from 'react'
import { LuCheck } from 'react-icons/lu'

export interface DropdownItem {
  key: string
  label: string
  icon?: React.ReactNode
  /** 组名变化时渲染一条分组标题 */
  group?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  /** 次级说明(右侧灰字) */
  hint?: string
  /** 悬停提示(禁用原因等) */
  title?: string
  onSelect: () => void
}

function usePopover(): {
  open: boolean
  setOpen: (v: boolean) => void
  rootRef: React.RefObject<HTMLDivElement>
} {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', () => setOpen(false))
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return { open, setOpen, rootRef }
}

/** 菜单面板外框样式(共享) */
const PANEL_CLASS =
  'absolute z-[800] mt-1 min-w-[200px] max-w-[360px] rounded border border-ink-700 bg-ink-850 py-1 shadow-2xl'

export function MenuButton(props: {
  /** 触发按钮内容 */
  children: React.ReactNode
  items: DropdownItem[]
  title?: string
  disabled?: boolean
  /** 菜单对齐:默认左对齐,'right' 右对齐(标题栏右端按钮用) */
  align?: 'left' | 'right'
  className?: string
  /** 菜单最大高度(内容多时滚动) */
  maxHeight?: number
}): React.JSX.Element {
  const { open, setOpen, rootRef } = usePopover()

  let lastGroup: string | undefined
  return (
    <div ref={rootRef} className="app-no-drag relative">
      <button
        title={props.title}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
        className={
          props.className ??
          `flex h-7 items-center gap-1 rounded px-2 text-[13px] ${
            props.disabled
              ? 'cursor-not-allowed text-ink-500'
              : open
                ? 'bg-ink-800 text-jb-text'
                : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
          }`
        }
      >
        {props.children}
      </button>
      {open && (
        <div
          className={`${PANEL_CLASS} ${props.align === 'right' ? 'right-0' : 'left-0'}`}
          style={{ maxHeight: props.maxHeight ?? 420, overflowY: 'auto' }}
        >
          {props.items.map((it) => {
            // 组名变化:非空组名渲染分组标题,空串仅作分隔线
            const changed = it.group !== undefined && it.group !== lastGroup
            const groupHeader = changed ? (
              it.group ? (
                <div
                  key={`g-${it.group}`}
                  className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500"
                >
                  {it.group}
                </div>
              ) : (
                <div key="g-sep" className="my-1 h-px bg-ink-700" />
              )
            ) : null
            lastGroup = it.group
            return (
              <div key={it.key}>
                {groupHeader}
                <button
                  disabled={it.disabled}
                  title={it.title}
                  onClick={() => {
                    setOpen(false)
                    it.onSelect()
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] ${
                    it.disabled
                      ? 'cursor-not-allowed text-ink-500'
                      : it.danger
                        ? 'text-red-400 hover:bg-ink-800'
                        : 'text-jb-text hover:bg-jb-selection'
                  }`}
                >
                  <span className="flex w-4 shrink-0 items-center justify-center text-jb-muted">
                    {it.checked ? <LuCheck className="text-accent" /> : it.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {/* max-w+truncate 兜底:即使传入超长 hint 也不撑破菜单宽度 */}
                  {it.hint && (
                    <span className="max-w-[300px] shrink-0 truncate text-xs text-ink-500">
                      {it.hint}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function PopoverButton(props: {
  children: React.ReactNode
  content: React.ReactNode
  title?: string
  align?: 'left' | 'right'
  /** 打开时回调(通知铃清除未读) */
  onOpen?: () => void
  width?: number
}): React.JSX.Element {
  const { open, setOpen, rootRef } = usePopover()
  const { onOpen } = props

  useEffect(() => {
    if (open) onOpen?.()
  }, [open, onOpen])

  return (
    <div ref={rootRef} className="app-no-drag relative">
      <button
        title={props.title}
        onClick={() => setOpen(!open)}
        className={`flex h-7 w-7 items-center justify-center rounded ${
          open ? 'bg-ink-800 text-jb-text' : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
        }`}
      >
        {props.children}
      </button>
      {open && (
        <div
          className={`${PANEL_CLASS} ${props.align === 'right' ? 'right-0' : 'left-0'}`}
          style={{ width: props.width ?? 320, maxHeight: 420, overflowY: 'auto' }}
        >
          {props.content}
        </div>
      )}
    </div>
  )
}
