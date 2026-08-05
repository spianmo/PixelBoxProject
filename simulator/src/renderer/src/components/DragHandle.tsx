/**
 * 面板分割拖拽条:onDelta 回调增量像素,方向由 orientation 决定
 */
import { useCallback, useRef } from 'react'

interface Props {
  orientation: 'vertical' | 'horizontal'
  onDelta: (deltaPx: number) => void
}

export function DragHandle({ orientation, onDelta }: Props): React.JSX.Element {
  const dragging = useRef(false)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      let last = orientation === 'vertical' ? e.clientX : e.clientY
      const prevCursor = document.body.style.cursor
      document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'

      const onMove = (ev: MouseEvent): void => {
        if (!dragging.current) return
        const cur = orientation === 'vertical' ? ev.clientX : ev.clientY
        onDelta(cur - last)
        last = cur
      }
      const onUp = (): void => {
        dragging.current = false
        document.body.style.cursor = prevCursor
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [orientation, onDelta]
  )

  return (
    <div
      onMouseDown={onMouseDown}
      className={
        orientation === 'vertical'
          ? 'w-1 shrink-0 cursor-col-resize bg-ink-700/40 transition-colors hover:bg-accent/60'
          : 'h-1 shrink-0 cursor-row-resize bg-ink-700/40 transition-colors hover:bg-accent/60'
      }
    />
  )
}
