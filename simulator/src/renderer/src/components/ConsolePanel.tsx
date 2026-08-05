/**
 * 底部控制台:Tab = 应用日志 / 构建输出,自动滚动到底,支持清空
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { VscClearAll } from 'react-icons/vsc'

export interface LogLine {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  ts: number
}

export type ConsoleTab = 'app' | 'build'

interface Props {
  activeTab: ConsoleTab
  onTabChange: (tab: ConsoleTab) => void
  appLogs: LogLine[]
  buildLogs: LogLine[]
  onClear: (tab: ConsoleTab) => void
}

const LEVEL_COLOR: Record<LogLine['level'], string> = {
  log: 'text-gray-300',
  info: 'text-sky-300',
  warn: 'text-yellow-300',
  error: 'text-red-400',
  debug: 'text-gray-500'
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function ConsolePanel({ activeTab, onTabChange, appLogs, buildLogs, onClear }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const logs = activeTab === 'app' ? appLogs : buildLogs

  // 新日志自动滚到底(用户上滚超过 40px 则不打扰)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40 + 24
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="flex h-8 shrink-0 items-center border-b border-ink-700 bg-ink-850 pr-2">
        {(['app', 'build'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={`h-full border-r border-ink-700 px-4 text-xs ${
              activeTab === tab
                ? 'bg-ink-900 text-gray-100 shadow-[inset_0_2px_0_0_theme(colors.accent.DEFAULT)]'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab === 'app' ? t('console.appLog') : t('console.buildOutput')}
          </button>
        ))}
        <button
          onClick={() => onClear(activeTab)}
          title={t('console.clear')}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-ink-700 hover:text-gray-200"
        >
          <VscClearAll />
        </button>
      </div>
      <div ref={scrollRef} className="selectable flex-1 overflow-auto px-3 py-1 font-mono text-xs leading-5">
        {logs.length === 0 ? (
          <div className="py-2 text-gray-600">{t('console.empty')}</div>
        ) : (
          logs.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              <span className="mr-2 text-gray-600">{fmtTime(line.ts)}</span>
              <span className={LEVEL_COLOR[line.level]}>{line.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
