/**
 * 项目内容检索弹窗(IDEA ⇧⌘F Find in Files 同款交互)
 *
 * - 顶部查询框 + 三个选项开关(Cc 区分大小写 / W 整词 / .* 正则),300ms 去抖检索
 * - 结果按文件分组:文件行(相对路径 + 命中数)+ 命中行(行号 + 命中高亮的行文本)
 * - ↑↓ 在命中间移动,Enter / 点击 → 打开文件并定位到行列(经 onOpenAt 回 App:
 *   活动编辑器组打开 + revealAt);Esc 关闭
 * - 结果被截断(命中 >2000 或超时间预算)时提示收窄查询
 * - 视觉与 QuickOpen 对齐(居中弹层、ink 色板、等宽结果行)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VscLoading } from 'react-icons/vsc'
import type { ContentSearchMatch, ContentSearchOptions } from '../../../shared/ipc-types'

interface Props {
  visible: boolean
  onClose: () => void
  /** 打开文件并定位(App:活动组 openFile + revealAt) */
  onOpenAt: (path: string, line: number, column: number) => void
}

/** 选项开关(Cc / W / .*) */
function OptToggle(props: {
  label: string
  title: string
  on: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      onClick={props.onToggle}
      className={`flex h-6 min-w-6 items-center justify-center rounded px-1 font-mono text-[12px] ${
        props.on ? 'bg-jb-selection text-jb-text' : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
      }`}
    >
      {props.label}
    </button>
  )
}

/** 命中行文本:命中片段高亮(超长行居中裁剪到命中附近) */
function MatchLine({ m }: { m: ContentSearchMatch }): React.JSX.Element {
  const col = m.column - 1
  let text = m.lineText
  let start = col
  // 命中太靠后时把窗口滑到命中附近(前留 24 字符)
  if (start > 60) {
    const from = start - 24
    text = '…' + text.slice(from)
    start = start - from + 1
  }
  const before = text.slice(0, start)
  const hit = text.slice(start, start + m.matchLen)
  const after = text.slice(start + m.matchLen, start + m.matchLen + 200)
  return (
    <span className="truncate font-mono text-[12px]">
      <span className="text-jb-muted">{before}</span>
      <span className="rounded-sm bg-accent/30 text-jb-text">{hit}</span>
      <span className="text-jb-muted">{after}</span>
    </span>
  )
}

export function SearchInFiles({ visible, onClose, onOpenAt }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [matches, setMatches] = useState<ContentSearchMatch[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selIdx, setSelIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  // 打开时聚焦并全选上次查询(IDEA 同款);关闭时保留查询词
  useEffect(() => {
    if (visible) {
      window.setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    }
  }, [visible])

  // 300ms 去抖检索(选项变化立即重查;弹窗隐藏不查)
  useEffect(() => {
    if (!visible) return
    if (query.trim().length === 0) {
      setMatches([])
      setTruncated(false)
      setError(null)
      return
    }
    const seq = ++seqRef.current
    const timer = window.setTimeout(() => {
      setSearching(true)
      const opts: ContentSearchOptions = { caseSensitive, wholeWord, regex }
      window.api
        .searchContent(query, opts)
        .then((r) => {
          if (seqRef.current !== seq) return
          setMatches(r.matches)
          setTruncated(r.truncated)
          setError(null)
          setSelIdx(0)
        })
        .catch((err) => {
          if (seqRef.current !== seq) return
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg.includes('search:badPattern') ? t('search.badPattern') : msg)
          setMatches([])
        })
        .finally(() => {
          if (seqRef.current === seq) setSearching(false)
        })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [visible, query, caseSensitive, wholeWord, regex, t])

  /** 按文件分组的渲染序列(文件头行 + 命中行,展平供键盘导航用 matches 原序) */
  const grouped = useMemo(() => {
    const byFile = new Map<string, ContentSearchMatch[]>()
    for (const m of matches) {
      const list = byFile.get(m.relPath)
      if (list) list.push(m)
      else byFile.set(m.relPath, [m])
    }
    return [...byFile.entries()]
  }, [matches])

  if (!visible) return null

  const openSel = (m: ContentSearchMatch | undefined): void => {
    if (!m) return
    onOpenAt(m.path, m.line, m.column)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelIdx((i) => Math.min(i + 1, matches.length - 1))
      scrollSelIntoView()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelIdx((i) => Math.max(i - 1, 0))
      scrollSelIntoView()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openSel(matches[selIdx])
    }
  }

  const scrollSelIntoView = (): void => {
    window.setTimeout(() => {
      listRef.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    }, 0)
  }

  let flatIdx = -1
  return (
    <div
      className="fixed inset-0 z-[560] flex items-start justify-center bg-black/30 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[70vh] w-[720px] flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-850 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            className="h-7 min-w-0 flex-1 rounded border border-ink-600 bg-ink-900 px-2 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent"
          />
          {searching && <VscLoading className="shrink-0 animate-spin text-accent" />}
          <OptToggle label="Cc" title={t('search.caseSensitive')} on={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} />
          <OptToggle label="W" title={t('search.wholeWord')} on={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
          <OptToggle label=".*" title={t('search.regex')} on={regex} onToggle={() => setRegex((v) => !v)} />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {error && <div className="px-3 py-2 text-[12px] text-red-400">{error}</div>}
          {!error && matches.length === 0 && query.trim().length > 0 && !searching && (
            <div className="px-3 py-2 text-[12px] text-jb-muted">{t('search.empty')}</div>
          )}
          {grouped.map(([relPath, list]) => (
            <div key={relPath}>
              <div className="sticky top-0 flex items-center gap-2 bg-ink-850 px-3 py-1 text-[12px] text-jb-text">
                <span className="truncate">{relPath}</span>
                <span className="text-ink-500">{list.length}</span>
              </div>
              {list.map((m) => {
                flatIdx++
                const idx = flatIdx
                const selected = idx === selIdx
                return (
                  <div
                    key={`${m.line}:${m.column}:${idx}`}
                    data-selected={selected}
                    onMouseEnter={() => setSelIdx(idx)}
                    onClick={() => openSel(m)}
                    className={`flex cursor-pointer items-center gap-2 py-0.5 pl-7 pr-3 ${
                      selected ? 'bg-jb-selection' : 'hover:bg-ink-800'
                    }`}
                  >
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] text-ink-500">{m.line}</span>
                    <MatchLine m={m} />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-ink-700 px-3 py-1 text-[11px] text-ink-500">
          <span>{t('search.hint')}</span>
          <span>
            {truncated
              ? t('search.truncated', { count: matches.length })
              : t('search.count', { count: matches.length })}
          </span>
        </div>
      </div>
    </div>
  )
}
