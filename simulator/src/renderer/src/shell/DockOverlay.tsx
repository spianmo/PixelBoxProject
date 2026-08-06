/**
 * 覆盖式停靠层(视图模式 Dock Unpinned / Undock)
 *
 * - absolute 覆盖编辑区(挂在 App 中央内容容器,不挤压布局);z-[450]
 *   (低于 FloatPanel 600 / Dropdown 800 / ContextMenu 900 / 模态 950)
 * - 内缘 DragHandle 调整尺寸,增量语义与停靠槽位一致(宽/高状态与槽位共享)
 * - Unpinned 的「点外部自动收起」由 App 层全局 mousedown 监听实现
 *   (经 forwardRef 拿本层 DOM 做 contains 判定;轨道图标 [data-tw-rail] 豁免)
 */
import { forwardRef } from 'react'
import { DragHandle } from '../components/DragHandle'

interface Props {
  side: 'left' | 'right' | 'bottom'
  /** 面板尺寸(left/right = 宽,bottom = 高) */
  size: number
  /** 尺寸拖拽增量(原始像素;调用方沿用停靠槽位的同款钳制公式) */
  onResizeDelta: (deltaPx: number) => void
  children: React.ReactNode
}

export const DockOverlay = forwardRef<HTMLDivElement, Props>(function DockOverlay(
  props,
  ref
): React.JSX.Element {
  const { side } = props

  if (side === 'bottom') {
    return (
      <div
        ref={ref}
        style={{ height: props.size }}
        className="absolute inset-x-0 bottom-0 z-[450] flex flex-col border-t border-ink-700 bg-ink-900 shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
      >
        <DragHandle orientation="horizontal" onDelta={props.onResizeDelta} />
        <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
      </div>
    )
  }

  const isLeft = side === 'left'
  return (
    <div
      ref={ref}
      style={{ width: props.size }}
      className={`absolute inset-y-0 z-[450] flex ${
        isLeft
          ? 'left-0 border-r border-ink-700 shadow-[8px_0_24px_rgba(0,0,0,0.45)]'
          : 'right-0 border-l border-ink-700 shadow-[-8px_0_24px_rgba(0,0,0,0.45)]'
      } bg-ink-900`}
    >
      {!isLeft && <DragHandle orientation="vertical" onDelta={props.onResizeDelta} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
      {isLeft && <DragHandle orientation="vertical" onDelta={props.onResizeDelta} />}
    </div>
  )
})
