/**
 * 通用工具窗容器(JetBrains 风格):标题栏(图标+标题+附加动作+隐藏按钮)+ 内容区
 * 尺寸由外层布局(DragHandle 调整的 width/height)决定;隐藏=外层不渲染
 */
import { useTranslation } from 'react-i18next'
import { LuMinus } from 'react-icons/lu'

interface Props {
  title: string
  icon?: React.ReactNode
  /** 自定义标题区(覆盖 icon+title,底部工具窗放 tab 条用) */
  header?: React.ReactNode
  /** 标题栏右侧附加按钮 */
  actions?: React.ReactNode
  onHide: () => void
  children: React.ReactNode
}

export function ToolWindow(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-ink-900">
      <div className="flex h-8 shrink-0 items-center border-b border-ink-700 bg-ink-850 pl-2 pr-1">
        {props.header ?? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-jb-text">
            {props.icon && <span className="text-jb-muted">{props.icon}</span>}
            <span className="truncate">{props.title}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {props.actions}
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
    </div>
  )
}
