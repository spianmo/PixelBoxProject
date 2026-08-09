/**
 * 通用右键菜单:固定定位,点击任意处关闭
 * 支持分组标题 / 选中勾 / 禁用(带 tooltip)—— 与 shell/Dropdown 菜单项能力对齐
 */
import { useEffect, useRef } from 'react'
import { LuCheck } from 'react-icons/lu'

export interface MenuItem {
  label: string
  danger?: boolean
  /** 组名变化时渲染一条分组标题(空串仅作分隔线;与 Dropdown 一致) */
  group?: string
  /** 当前选中项打勾(视图模式菜单) */
  checked?: boolean
  disabled?: boolean
  /** 悬停提示(禁用原因等) */
  title?: string
  onClick: () => void
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
        onClose()
      }
    }
    // 延迟一帧注册,避免触发菜单的那次点击立即将其关闭
    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', close)
      window.addEventListener('blur', close)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // 防止菜单超出窗口右/下边缘(分组标题按额外行粗略计入)
  const groupCount = new Set(items.map((it) => it.group).filter((g) => g !== undefined)).size
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - (items.length + groupCount) * 30 - 16)
  }

  // 任一项声明 checked 时整列留出勾选位(对齐 Dropdown)
  const hasCheckColumn = items.some((m) => m.checked !== undefined)

  let lastGroup: string | undefined
  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-[900] min-w-[160px] rounded border border-ink-600 bg-ink-800 py-1 shadow-xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => {
        // 组名变化:非空组名渲染分组标题,空串仅作分隔线
        const changed = it.group !== undefined && it.group !== lastGroup
        const groupHeader = changed ? (
          it.group ? (
            <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
              {it.group}
            </div>
          ) : (
            <div className="my-1 h-px bg-ink-700" />
          )
        ) : null
        lastGroup = it.group
        return (
          <div key={`${i}-${it.label}`}>
            {groupHeader}
            <button
              disabled={it.disabled}
              title={it.title}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                it.disabled
                  ? 'cursor-not-allowed text-ink-500'
                  : it.danger
                    ? 'text-red-400 hover:bg-ink-700'
                    : 'text-gray-200 hover:bg-ink-700'
              }`}
              onClick={() => {
                onClose()
                it.onClick()
              }}
            >
              {hasCheckColumn && (
                <span className="flex w-4 shrink-0 items-center justify-center">
                  {it.checked && <LuCheck className="text-accent" />}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
