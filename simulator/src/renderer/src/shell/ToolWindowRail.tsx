/**
 * 工具窗图标轨道(JetBrains New UI:宽 44px,左右两侧各一条)
 * - 点击图标开关对应工具窗;激活态外缘 2px 蓝条 + 图标高亮
 * - 上部/下部两组(左轨:项目、设备管理器 / 构建、日志、问题)
 */

export interface RailItem {
  key: string
  icon: React.ReactNode
  /** 悬停提示(i18n 文案) */
  label: string
  active: boolean
  /** 角标数(问题数等,0 不显示) */
  badge?: number
  onClick: () => void
}

interface Props {
  side: 'left' | 'right'
  topItems: RailItem[]
  bottomItems?: RailItem[]
}

function RailButton({ item, side }: { item: RailItem; side: 'left' | 'right' }): React.JSX.Element {
  return (
    <button
      title={item.label}
      onClick={item.onClick}
      className={`relative flex h-10 w-full items-center justify-center text-[17px] transition-colors ${
        item.active ? 'bg-ink-800 text-jb-text' : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
      }`}
    >
      {/* 激活态外缘 2px 蓝条 */}
      {item.active && (
        <span
          className={`absolute top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent ${
            side === 'left' ? 'left-0' : 'right-0'
          }`}
        />
      )}
      {item.icon}
      {(item.badge ?? 0) > 0 && (
        <span className="absolute right-1.5 top-1 min-w-[14px] rounded-full bg-red-500 px-1 text-center text-[9px] font-bold leading-[14px] text-white">
          {item.badge}
        </span>
      )}
    </button>
  )
}

export function ToolWindowRail({ side, topItems, bottomItems }: Props): React.JSX.Element {
  return (
    <div
      className={`flex w-11 shrink-0 flex-col bg-ink-850 ${
        side === 'left' ? 'border-r border-ink-700' : 'border-l border-ink-700'
      }`}
    >
      <div className="flex flex-col">
        {topItems.map((it) => (
          <RailButton key={it.key} item={it} side={side} />
        ))}
      </div>
      {bottomItems && bottomItems.length > 0 && (
        <div className="mt-auto flex flex-col pb-1">
          {bottomItems.map((it) => (
            <RailButton key={it.key} item={it} side={side} />
          ))}
        </div>
      )}
    </div>
  )
}
