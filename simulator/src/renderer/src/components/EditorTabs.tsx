/**
 * 编辑器标签栏(JetBrains 风格:标签栏 #2B2D30,激活标签下缘 2px 蓝条)
 * 多标签切换 / 关闭,未保存显示圆点,中键关闭
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
            className={`group relative flex cursor-pointer items-center gap-1.5 px-3 text-[13px] ${
              active
                ? 'bg-ink-900 text-jb-text'
                : 'bg-ink-850 text-jb-muted hover:bg-ink-800 hover:text-jb-text'
            }`}
          >
            <span className="max-w-[180px] truncate">{tab.name}</span>
            <button
              className="flex h-4 w-4 items-center justify-center rounded hover:bg-ink-700"
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
            {/* 激活标签下缘 2px 蓝条 */}
            {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          </div>
        )
      })}
    </div>
  )
}
