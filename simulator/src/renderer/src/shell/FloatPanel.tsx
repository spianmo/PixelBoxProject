/**
 * 浮动工具窗面板(视图模式 Float)
 *
 * - fixed 定位 z-[600]:高于覆盖式停靠层 450,低于 Dropdown 800 / ContextMenu 900 / 模态 950
 * - 标题栏空白区拖动(children 为 render-prop,把 startDrag 接到 ToolWindow 的
 *   onHeaderMouseDown;移动超过 3px 才判定拖拽,不影响头部按钮 / tab 点击;
 *   交互控件 button/input/select/[role=tab] 不触发拖动)
 * - 八向 resize(边 4 + 角 4 的透明把手);#393B40 边框 + 阴影
 * - 位置尺寸经 viewMode.setFloatRect 记忆(300ms 去抖落盘,重开/重启恢复)
 * - 内部终端 / Monaco 尺寸自适应由各自 ResizeObserver / automaticLayout 负责
 */
import { useRef, useState } from 'react'
import { getFloatRect, setFloatRect, type FloatRect, type ToolWindowId } from './viewMode'

const MIN_W = 320
const MIN_H = 180

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** 视口内钳制(至少留出可抓取余量,避免拖出屏幕找不回) */
function clampRect(r: FloatRect): FloatRect {
  const w = Math.max(r.w, MIN_W)
  const h = Math.max(r.h, MIN_H)
  return {
    x: Math.min(Math.max(r.x, 80 - w), Math.max(0, window.innerWidth - 80)),
    y: Math.min(Math.max(r.y, 0), Math.max(0, window.innerHeight - 60)),
    w,
    h
  }
}

/** 八向把手定位与光标(透明,悬停按方向变光标) */
const HANDLES: Array<{ dir: Dir; cls: string }> = [
  { dir: 'n', cls: 'left-2 right-2 top-0 h-1 cursor-ns-resize' },
  { dir: 's', cls: 'left-2 right-2 bottom-0 h-1 cursor-ns-resize' },
  { dir: 'w', cls: 'top-2 bottom-2 left-0 w-1 cursor-ew-resize' },
  { dir: 'e', cls: 'top-2 bottom-2 right-0 w-1 cursor-ew-resize' },
  { dir: 'nw', cls: 'left-0 top-0 h-2.5 w-2.5 cursor-nwse-resize' },
  { dir: 'se', cls: 'right-0 bottom-0 h-2.5 w-2.5 cursor-nwse-resize' },
  { dir: 'ne', cls: 'right-0 top-0 h-2.5 w-2.5 cursor-nesw-resize' },
  { dir: 'sw', cls: 'left-0 bottom-0 h-2.5 w-2.5 cursor-nesw-resize' }
]

interface Props {
  toolId: ToolWindowId
  /** render-prop:把 startDrag 接到 ToolWindow 的 onHeaderMouseDown */
  children: (startDrag: (e: React.MouseEvent) => void) => React.ReactNode
}

export function FloatPanel(props: Props): React.JSX.Element {
  const [rect, setRect] = useState<FloatRect>(() => clampRect(getFloatRect(props.toolId)))
  const rectRef = useRef(rect)
  rectRef.current = rect

  const apply = (r: FloatRect): void => {
    const c = clampRect(r)
    setRect(c)
    setFloatRect(props.toolId, c) // store 即时 + localStorage 去抖
  }

  /** 标题栏拖动(3px 阈值;交互控件豁免) */
  const startDrag = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, input, select, [role="tab"]')) return
    const sx = e.clientX
    const sy = e.clientY
    const origin = rectRef.current
    let moved = false
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      moved = true
      ev.preventDefault()
      apply({ ...origin, x: origin.x + dx, y: origin.y + dy })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 八向 resize:对侧边缘保持不动(west/north 拖拽时右/下边固定) */
  const startResize =
    (dir: Dir) =>
    (e: React.MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const sx = e.clientX
      const sy = e.clientY
      const o = rectRef.current
      const right = o.x + o.w
      const bottom = o.y + o.h
      const onMove = (ev: MouseEvent): void => {
        const dx = ev.clientX - sx
        const dy = ev.clientY - sy
        let { x, y, w, h } = o
        if (dir.includes('e')) w = Math.max(MIN_W, o.w + dx)
        if (dir.includes('s')) h = Math.max(MIN_H, o.h + dy)
        if (dir.includes('w')) {
          w = Math.max(MIN_W, o.w - dx)
          x = right - w
        }
        if (dir.includes('n')) {
          h = Math.max(MIN_H, o.h - dy)
          y = bottom - h
        }
        apply({ x, y, w, h })
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

  return (
    <div
      className="fixed z-[600] flex flex-col overflow-hidden rounded-md border border-ink-700 bg-ink-900 shadow-2xl"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div className="min-h-0 flex-1">{props.children(startDrag)}</div>
      {HANDLES.map((hd) => (
        <div key={hd.dir} className={`absolute z-10 ${hd.cls}`} onMouseDown={startResize(hd.dir)} />
      ))}
    </div>
  )
}
