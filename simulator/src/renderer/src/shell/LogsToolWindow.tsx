/**
 * 底部工具窗(对齐 Android Studio Logcat)
 * - tab:日志 / 构建 / 问题
 * - 日志页工具行:设备下拉(与标题栏联动)+ 过滤输入(tag:xxx level:warn 自由文本)+ 清空 + 滚动锁定
 * - 日志行等宽字体,列:时间 | 级别徽标(V/D/I/W/E 彩色)| tag | 内容
 * - 构建页:esbuild/idf.py 输出流,ANSI 颜色解析
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuArrowDownToLine, LuCircleAlert, LuListX } from 'react-icons/lu'
import { parseAnsiLine } from './ansi'
import { deviceKey, shellDeviceStore, simDeviceKey, useDeviceProfiles, useShellDevices } from './store'

export interface LogLine {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  ts: number
  /** 来源设备 key('sim:<profileId>';未标记的行对全部设备可见) */
  deviceKey?: string
}

export type BottomTab = 'logs' | 'build' | 'problems'

interface Props {
  activeTab: BottomTab
  appLogs: LogLine[]
  buildLogs: LogLine[]
  /** 最近一次构建的错误列表(问题 tab) */
  problems: string[]
  onClear: (tab: 'logs' | 'build') => void
}

// ---------------------------------------------------------------
// 级别 / tag / 过滤
// ---------------------------------------------------------------

type Level = 'V' | 'D' | 'I' | 'W' | 'E'

const LEVEL_OF: Record<LogLine['level'], Level> = {
  debug: 'D',
  log: 'I',
  info: 'I',
  warn: 'W',
  error: 'E'
}

const LEVEL_ORDER: Record<Level, number> = { V: 0, D: 1, I: 2, W: 3, E: 4 }

/** Logcat 风格级别徽标配色(W=黄 E=红) */
const LEVEL_BADGE: Record<Level, string> = {
  V: 'bg-[#5A5D63] text-white',
  D: 'bg-[#548AF7] text-white',
  I: 'bg-[#6AAB73] text-white',
  W: 'bg-[#D9A343] text-black/80',
  E: 'bg-[#F26D78] text-black/80'
}

/** 行文本配色(级别弱着色,内容仍以徽标区分为主) */
const LEVEL_TEXT: Record<Level, string> = {
  V: 'text-ink-500',
  D: 'text-jb-muted',
  I: 'text-jb-text',
  W: 'text-yellow-300',
  E: 'text-red-400'
}

/** 从 “[tag] 内容” 提取 tag,无前缀归入 app */
function splitTag(text: string): { tag: string; content: string } {
  const m = /^\[([^\]\s]{1,24})\]\s?([\s\S]*)$/.exec(text)
  return m ? { tag: m[1], content: m[2] } : { tag: 'app', content: text }
}

interface Filter {
  tags: string[]
  minLevel: number | null
  words: string[]
}

const LEVEL_ALIAS: Record<string, Level> = {
  v: 'V',
  verbose: 'V',
  d: 'D',
  debug: 'D',
  i: 'I',
  info: 'I',
  w: 'W',
  warn: 'W',
  warning: 'W',
  e: 'E',
  error: 'E'
}

/** 解析过滤表达式:`tag:net level:warn 自由文本`(同 AS Logcat 语法感,级别为“该级及以上”) */
function parseFilter(query: string): Filter {
  const f: Filter = { tags: [], minLevel: null, words: [] }
  for (const token of query.trim().split(/\s+/)) {
    if (token.length === 0) continue
    const tag = /^tag:(.+)$/i.exec(token)
    if (tag) {
      f.tags.push(tag[1].toLowerCase())
      continue
    }
    const lv = /^level:(.+)$/i.exec(token)
    if (lv) {
      const mapped = LEVEL_ALIAS[lv[1].toLowerCase()]
      if (mapped) f.minLevel = LEVEL_ORDER[mapped]
      continue
    }
    f.words.push(token.toLowerCase())
  }
  return f
}

function matchLine(f: Filter, level: Level, tag: string, content: string): boolean {
  if (f.minLevel !== null && LEVEL_ORDER[level] < f.minLevel) return false
  if (f.tags.length > 0 && !f.tags.includes(tag.toLowerCase())) return false
  if (f.words.length > 0) {
    const hay = `${tag} ${content}`.toLowerCase()
    for (const w of f.words) if (!hay.includes(w)) return false
  }
  return true
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

// ---------------------------------------------------------------
// 滚动容器(自动滚底,可锁定)
// ---------------------------------------------------------------

function useAutoScroll(deps: unknown[], enabled: boolean): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (enabled && ref.current) ref.current.scrollTop = ref.current.scrollHeight
    // eslint 无此工程:deps 由调用方给定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return ref
}

// ---------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------

export function LogsToolWindow(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  const dev = useShellDevices()
  const { profiles } = useDeviceProfiles()
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)

  const filter = useMemo(() => parseFilter(query), [query])

  // 预处理日志行(设备路由 → tag 提取 → 过滤):
  // 多实例下每行带来源设备 key,按设备下拉选中项路由;未标记行(外壳消息)全设备可见
  const logRows = useMemo(() => {
    return props.appLogs
      .filter((line) => !line.deviceKey || line.deviceKey === dev.selectedKey)
      .map((line) => {
        const { tag, content } = splitTag(line.text)
        return { line, tag, content, level: LEVEL_OF[line.level] }
      })
      .filter((r) => matchLine(filter, r.level, r.tag, r.content))
  }, [props.appLogs, filter, dev.selectedKey])

  const logScrollRef = useAutoScroll([logRows], autoScroll && props.activeTab === 'logs')
  const buildScrollRef = useAutoScroll([props.buildLogs], autoScroll && props.activeTab === 'build')

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-900">
      {/* 日志页工具行 */}
      {props.activeTab === 'logs' && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850 px-2">
          {/* 设备下拉(与标题栏联动;虚拟设备日志按会话路由,真机日志阶段 3 接入) */}
          <select
            value={dev.selectedKey}
            onChange={(e) => shellDeviceStore.set({ selectedKey: e.target.value })}
            className="h-6 max-w-[200px] rounded border border-ink-600 bg-ink-900 px-1 text-xs text-jb-text outline-none focus:border-accent"
            title={t('logs.device')}
          >
            <optgroup label={t('titlebar.virtualDevices')}>
              {profiles.map((p) => (
                <option key={simDeviceKey(p.id)} value={simDeviceKey(p.id)}>
                  {p.name} ({p.screenW}×{p.screenH})
                </option>
              ))}
            </optgroup>
            {dev.devices.length > 0 && (
              <optgroup label={t('titlebar.realDevices')}>
                {dev.devices.map((d) => (
                  <option key={deviceKey(d)} value={deviceKey(d)}>
                    {d.name} ({d.ip})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('logs.filterPlaceholder')}
            spellCheck={false}
            className="h-6 min-w-0 flex-1 rounded border border-ink-600 bg-ink-900 px-2 font-mono text-xs text-jb-text outline-none placeholder:text-ink-500 focus:border-accent"
          />
          <button
            title={t('console.clear')}
            onClick={() => props.onClear('logs')}
            className="flex h-6 w-6 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
          >
            <LuListX />
          </button>
          <button
            title={t('logs.scrollLock')}
            onClick={() => setAutoScroll((v) => !v)}
            className={`flex h-6 w-6 items-center justify-center rounded ${
              autoScroll ? 'bg-jb-selection text-jb-text' : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
            }`}
          >
            <LuArrowDownToLine />
          </button>
        </div>
      )}
      {/* 构建页工具行 */}
      {props.activeTab === 'build' && (
        <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-b border-ink-700 bg-ink-850 px-2">
          <button
            title={t('console.clear')}
            onClick={() => props.onClear('build')}
            className="flex h-6 w-6 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
          >
            <LuListX />
          </button>
          <button
            title={t('logs.scrollLock')}
            onClick={() => setAutoScroll((v) => !v)}
            className={`flex h-6 w-6 items-center justify-center rounded ${
              autoScroll ? 'bg-jb-selection text-jb-text' : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
            }`}
          >
            <LuArrowDownToLine />
          </button>
        </div>
      )}

      {/* 内容区 */}
      {props.activeTab === 'logs' && (
        <div ref={logScrollRef} className="selectable min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-xs leading-5">
          {logRows.length === 0 ? (
            <div className="py-2 text-ink-500">{t('console.empty')}</div>
          ) : (
            logRows.map((r, i) => (
              <div key={i} className="flex items-start gap-2 whitespace-pre-wrap break-all">
                <span className="shrink-0 text-ink-500">{fmtTime(r.line.ts)}</span>
                <span
                  className={`mt-[3px] w-3.5 shrink-0 rounded-sm text-center text-[9px] font-bold leading-[14px] ${LEVEL_BADGE[r.level]}`}
                >
                  {r.level}
                </span>
                <span className="w-20 shrink-0 truncate text-jb-muted" title={r.tag}>
                  {r.tag}
                </span>
                <span className={`min-w-0 flex-1 ${LEVEL_TEXT[r.level]}`}>{r.content}</span>
              </div>
            ))
          )}
        </div>
      )}

      {props.activeTab === 'build' && (
        <div
          ref={buildScrollRef}
          className="selectable min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-xs leading-5"
        >
          {props.buildLogs.length === 0 ? (
            <div className="py-2 text-ink-500">{t('console.empty')}</div>
          ) : (
            props.buildLogs.map((line, i) => {
              const spans = parseAnsiLine(line.text)
              const plain = spans.every((s) => !s.color)
              const fallback =
                line.level === 'error' ? 'text-red-400' : line.level === 'warn' ? 'text-yellow-300' : 'text-jb-muted'
              return (
                <div key={i} className="whitespace-pre-wrap break-all">
                  <span className="mr-2 text-ink-500">{fmtTime(line.ts)}</span>
                  {spans.map((s, j) => (
                    <span
                      key={j}
                      className={plain ? fallback : undefined}
                      style={{ color: s.color, fontWeight: s.bold ? 600 : undefined }}
                    >
                      {s.text}
                    </span>
                  ))}
                </div>
              )
            })
          )}
        </div>
      )}

      {props.activeTab === 'problems' && (
        <div className="selectable min-h-0 flex-1 overflow-auto px-2 py-1 text-xs leading-6">
          {props.problems.length === 0 ? (
            <div className="py-2 text-ink-500">{t('problems.empty')}</div>
          ) : (
            props.problems.map((p, i) => (
              <div key={i} className="flex items-start gap-2 whitespace-pre-wrap break-all font-mono">
                <LuCircleAlert className="mt-1 shrink-0 text-red-400" />
                <span className="text-jb-text">{p}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** 底部工具窗标题区的 tab 条(嵌入 ToolWindow header) */
export function LogsTabStrip(props: {
  activeTab: BottomTab
  problems: number
  onTabChange: (tab: BottomTab) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tabs: Array<{ key: BottomTab; label: string; badge?: number }> = [
    { key: 'logs', label: t('console.appLog') },
    { key: 'build', label: t('console.buildOutput') },
    { key: 'problems', label: t('problems.title'), badge: props.problems }
  ]
  return (
    <div className="flex h-full items-stretch">
      {tabs.map((tab) => {
        const active = props.activeTab === tab.key
        return (
          <button
            key={tab.key}
            onClick={() => props.onTabChange(tab.key)}
            className={`relative flex items-center gap-1.5 px-3 text-xs ${
              active ? 'text-jb-text' : 'text-jb-muted hover:text-jb-text'
            }`}
          >
            {tab.label}
            {(tab.badge ?? 0) > 0 && (
              <span className="rounded-full bg-red-500/90 px-1.5 text-[9px] font-bold leading-[13px] text-white">
                {tab.badge}
              </span>
            )}
            {active && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />}
          </button>
        )
      })}
    </div>
  )
}
