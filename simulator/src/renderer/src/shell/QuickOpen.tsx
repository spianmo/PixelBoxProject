/**
 * 快速打开(Cmd+P):工作区文件名模糊匹配
 * - 打开时经 IPC 拉取工作区文件列表(相对路径)
 * - 子序列模糊匹配 + 评分(连续命中 / 词首命中 / 文件名命中加分)
 * - ↑↓ 选择,Enter 打开,Esc 关闭
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuSearch } from 'react-icons/lu'
import { fileIconFor } from '../components/fileIcons'

interface Props {
  /** 工作区根(未打开时列表为空) */
  workspaceRoot: string | null
  onOpen: (absPath: string) => void
  onClose: () => void
}

/**
 * 子序列模糊评分:query 逐字符在 target 中顺序出现则匹配。
 * 连续命中 +3,词首(分隔符后)命中 +2,普通命中 +1;不匹配返回 null
 */
function fuzzyScore(query: string, target: string): number | null {
  let score = 0
  let ti = 0
  let lastHit = -2
  for (let qi = 0; qi < query.length; qi++) {
    const qc = query[qi]
    let found = -1
    for (let i = ti; i < target.length; i++) {
      if (target[i] === qc) {
        found = i
        break
      }
    }
    if (found < 0) return null
    if (found === lastHit + 1) score += 3
    else if (found === 0 || '/\\-_. '.includes(target[found - 1])) score += 2
    else score += 1
    lastHit = found
    ti = found + 1
  }
  // 目标越短越靠前
  return score - target.length * 0.01
}

const MAX_RESULTS = 50

export function QuickOpen({ workspaceRoot, onOpen, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 打开时拉取文件列表
  useEffect(() => {
    inputRef.current?.focus()
    if (!workspaceRoot) return
    void window.api.listWorkspaceFiles().then(setFiles)
  }, [workspaceRoot])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return files.slice(0, MAX_RESULTS)
    const scored: Array<{ rel: string; score: number }> = []
    for (const rel of files) {
      const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
      // 文件名命中权重翻倍,其次全路径
      const byName = fuzzyScore(q, name)
      const byPath = fuzzyScore(q, rel.toLowerCase())
      const score = byName !== null ? byName * 2 + 10 : byPath
      if (score !== null) scored.push({ rel, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, MAX_RESULTS).map((s) => s.rel)
  }, [files, query])

  // 结果变化时重置选中并保证可见
  useEffect(() => setSelected(0), [results])
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const open = (rel: string): void => {
    if (!workspaceRoot) return
    onOpen(`${workspaceRoot}/${rel}`)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[940] bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="mx-auto mt-[10vh] w-[560px] max-w-[90vw] overflow-hidden rounded border border-ink-700 bg-ink-850 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-3">
          <LuSearch className="shrink-0 text-jb-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={workspaceRoot ? t('quickOpen.placeholder') : t('quickOpen.noWorkspace')}
            spellCheck={false}
            className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-jb-text outline-none placeholder:text-ink-500"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelected((s) => Math.min(results.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelected((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter' && results[selected]) {
                open(results[selected])
              }
            }}
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs text-ink-500">{t('quickOpen.empty')}</div>
          ) : (
            results.map((rel, i) => {
              const name = rel.slice(rel.lastIndexOf('/') + 1)
              const dir = rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
              return (
                <div
                  key={rel}
                  data-idx={i}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => open(rel)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1 text-[13px] ${
                    i === selected ? 'bg-jb-selection text-jb-text' : 'text-jb-text'
                  }`}
                >
                  {fileIconFor(name)}
                  <span className="shrink-0">{name}</span>
                  {dir && <span className="min-w-0 truncate text-xs text-ink-500">{dir}</span>}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
