/**
 * 编辑器标签栏:多标签切换 / 关闭,未保存显示圆点
 */
import { VscClose, VscCircleFilled } from 'react-icons/vsc'

export interface TabInfo {
  path: string
  name: string
}

interface Props {
  tabs: TabInfo[]
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

export function EditorTabs({ tabs, activePath, dirtyPaths, onSelect, onClose }: Props): React.JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-ink-700 bg-ink-850">
      {tabs.map((tab) => {
        const active = tab.path === activePath
        const dirty = dirtyPaths.has(tab.path)
        return (
          <div
            key={tab.path}
            title={tab.path}
            onClick={() => onSelect(tab.path)}
            onMouseDown={(e) => {
              // 中键关闭
              if (e.button === 1) {
                e.preventDefault()
                onClose(tab.path)
              }
            }}
            className={`group flex cursor-pointer items-center gap-1.5 border-r border-ink-700 px-3 text-sm ${
              active
                ? 'bg-ink-900 text-gray-100 shadow-[inset_0_2px_0_0_theme(colors.accent.DEFAULT)]'
                : 'bg-ink-850 text-gray-400 hover:bg-ink-800 hover:text-gray-200'
            }`}
          >
            <span className="max-w-[180px] truncate">{tab.name}</span>
            <button
              className="flex h-4 w-4 items-center justify-center rounded hover:bg-ink-600"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.path)
              }}
            >
              {dirty ? (
                <VscCircleFilled className="text-accent group-hover:hidden" />
              ) : (
                <VscClose className="opacity-0 group-hover:opacity-100" />
              )}
              {dirty && <VscClose className="hidden group-hover:block" />}
            </button>
          </div>
        )
      })}
    </div>
  )
}
