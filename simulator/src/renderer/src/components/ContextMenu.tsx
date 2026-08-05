/**
 * 通用右键菜单:固定定位,点击任意处关闭
 */
import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  danger?: boolean
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
    // 延迟一帧注册,避免触发菜单的那次点击立即将其关闭
    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', close)
      window.addEventListener('blur', close)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose])

  // 防止菜单超出窗口右/下边缘
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - items.length * 32 - 16)
  }

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-[900] min-w-[160px] rounded border border-ink-600 bg-ink-800 py-1 shadow-xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-ink-700 ${
            it.danger ? 'text-red-400' : 'text-gray-200'
          }`}
          onClick={() => {
            onClose()
            it.onClick()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
