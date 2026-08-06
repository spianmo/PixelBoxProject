/**
 * 通用工具窗容器(JetBrains 风格):标题栏(图标+标题+附加动作+视图模式 ⋮+隐藏)+ 内容区
 * 尺寸由外层布局(DragHandle 调整的 width/height / 覆盖层 / FloatPanel)决定;隐藏=外层不渲染
 *
 * 视图模式(五态,阶段 2/2):传 toolId 后头部出现 ⋮「视图模式」菜单,
 * 头部空白区右键弹出同款菜单(当前模式打勾;「独立窗口」仅白名单可用,置灰带 tooltip)。
 * 终端窗自身 ⋮ 已并入视图模式组,传 viewModeButton=false 只保留右键入口。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuEllipsisVertical, LuMinus } from 'react-icons/lu'
import { ContextMenu } from '../components/ContextMenu'
import { MenuButton } from './Dropdown'
import { useViewModeMenus, type ToolWindowId } from './viewMode'

interface Props {
  title: string
  icon?: React.ReactNode
  /** 自定义标题区(覆盖 icon+title,底部工具窗放 tab 条用) */
  header?: React.ReactNode
  /** 标题栏右侧附加按钮 */
  actions?: React.ReactNode
  /** 视图模式菜单的工具窗 id(缺省不渲染视图模式菜单 —— 独立窗口壳等场景) */
  toolId?: ToolWindowId
  /** 「独立窗口」项作用的 id(底部日志窗 构建 tab → 'build';缺省同 toolId) */
  windowToolId?: ToolWindowId
  /** 「独立窗口」项可用性覆盖(日志窗仅 构建 tab 激活时可用) */
  windowEnabled?: boolean
  /** 是否渲染头部 ⋮ 视图模式按钮(默认 true;终端窗自身 ⋮ 已含视图模式组时传 false) */
  viewModeButton?: boolean
  /** 头部空白区按下(FloatPanel 拖动接线;交互控件由 FloatPanel 侧过滤) */
  onHeaderMouseDown?: (e: React.MouseEvent) => void
  onHide: () => void
  children: React.ReactNode
}

export function ToolWindow(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const menus = useViewModeMenus(props.toolId ?? null, {
    windowToolId: props.windowToolId,
    windowEnabled: props.windowEnabled
  })

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-ink-900">
      <div
        className="flex h-8 shrink-0 items-center border-b border-ink-700 bg-ink-850 pl-2 pr-1"
        onMouseDown={props.onHeaderMouseDown}
        onContextMenu={
          props.toolId
            ? (e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY })
              }
            : undefined
        }
      >
        {props.header ?? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-jb-text">
            {props.icon && <span className="text-jb-muted">{props.icon}</span>}
            <span className="truncate">{props.title}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {props.actions}
          {props.toolId && (props.viewModeButton ?? true) && (
            <MenuButton
              title={t('toolwindow.options')}
              items={menus.dropdown}
              align="right"
              className="flex h-6 w-6 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
            >
              <LuEllipsisVertical />
            </MenuButton>
          )}
          <button
            title={t('toolwindow.hide')}
            onClick={props.onHide}
            className="flex h-6 w-6 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
          >
            <LuMinus />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{props.children}</div>
      {/* 头部右键:视图模式菜单(与 ⋮ 同款,当前模式打勾) */}
      {ctxMenu && props.toolId && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={menus.context} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  )
}
