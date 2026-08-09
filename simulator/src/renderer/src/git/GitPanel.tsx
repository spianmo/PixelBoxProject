/**
 * Git 工具窗主体(左侧槽位;面板骨架/按钮/列表样式照 DeviceManagerPanel 惯例)
 *
 * - 非 git 仓库:居中「初始化 Git 仓库」主按钮(git:init)
 * - 顶部分段切换「变更 / 历史 / 分支」三个子视图
 * - 变更视图:工具行(刷新/全部暂存/提交/拉取/推送)+ 四组变更列表(已暂存/未暂存/
 *   未跟踪/冲突,行 = 状态字母徽标 + 相对路径 + 悬停操作;冲突行额外提供
 *   采用我方/采用对方/标记已解决)+ 提交区(多行 textarea,⌘Enter 提交)
 *   + 底部折叠 push/pull 输出日志(等宽 selectable);冲突全部清零后在冲突分组
 *   位置提示「冲突已解决,请提交」
 * - 历史视图:commit 表格(短 hash mono / subject / 作者 / 相对时间)+ 左侧 SVG
 *   车道图(shared/gitParse.ts layoutCommitGraph 布局)+ 点击展开该 commit 的
 *   变更文件列表,点文件开「该 commit vs 第一父」diff 页签
 * - 分支视图:本地分支列表(当前分支高亮,行点击切换)+ 顶部「新建分支…」
 *   + 底部 Remotes 小节(列表 + 添加/删除/改 URL,InputModal 两步)
 * - 行着色统一走 git/fileStatusColors.ts(GitPanel 与 FileTree 一份映射)
 * - 原生 Git 菜单联动:监听 window 'pixelbox:git-ui'(menuBridge 派发)——
 *   commit 聚焦提交框 / newBranch 弹新建分支框 / remotes 切到分支视图
 * - 单击变更行打开 working-tree diff 页签(onOpenDiff 由 App 注入,接 EditorTabs)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LuArrowDownToLine,
  LuArrowLeft,
  LuArrowRight,
  LuArrowUpFromLine,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuGitBranch,
  LuListChecks,
  LuMinus,
  LuPencil,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuUndo2
} from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { GitCommitInfo, GitFileChange, GitResolveStrategy } from '../../../shared/ipc-types'
import { layoutCommitGraph } from '../../../shared/gitParse'
import { ConfirmModal, InputModal } from '../components/Modal'
import { showToast } from '../components/toast'
import type { DiffSpec } from '../editor/DiffView'
import { GIT_STATUS_CLS } from './fileStatusColors'
import {
  clearOpLog,
  gitErrCode,
  refreshGitAll,
  refreshGitStatus,
  setOpRunning,
  useGitState
} from './store'

/** Remotes 小节的两步 InputModal 状态(name → url;编辑时直接进 url 步) */
type RemoteModal =
  | { step: 'name' }
  | { step: 'url'; name: string; initial?: string; editing?: boolean }
  | null

/** 相对时间(历史列表;粗粒度即可) */
function relTime(tsSec: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - tsSec)
  if (diff < 60) return t('git.time.justNow')
  if (diff < 3600) return t('git.time.minutesAgo', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('git.time.hoursAgo', { count: Math.floor(diff / 3600) })
  if (diff < 86400 * 30) return t('git.time.daysAgo', { count: Math.floor(diff / 86400) })
  return new Date(tsSec * 1000).toLocaleDateString()
}

/** 行内小图标按钮(悬停操作;样式同 DeviceManagerPanel RowButton) */
function RowButton(props: {
  title: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      onClick={(e) => {
        e.stopPropagation() // 不触发行点击(开 diff)
        props.onClick()
      }}
      className={`flex h-5 w-5 items-center justify-center rounded text-[12px] ${
        props.danger
          ? 'text-jb-muted hover:bg-ink-700 hover:text-red-400'
          : 'text-jb-muted hover:bg-ink-700 hover:text-jb-text'
      }`}
    >
      {props.children}
    </button>
  )
}

/** 工具行图标按钮 */
function ToolButton(props: {
  title: string
  disabled?: boolean
  spinning?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-6 w-6 items-center justify-center rounded text-[13px] ${
        props.disabled
          ? 'cursor-not-allowed text-ink-600'
          : 'text-jb-muted hover:bg-ink-700 hover:text-jb-text'
      }`}
    >
      {props.spinning ? <VscLoading className="animate-spin" /> : props.children}
    </button>
  )
}

interface Props {
  workspaceRoot: string | null
  /** 打开 diff 页签(App 注入,接 EditorTabs 的 kind='diff' 页签) */
  onOpenDiff: (spec: DiffSpec) => void
}

export function GitPanel({ workspaceRoot, onOpenDiff }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const git = useGitState()
  const [view, setView] = useState<'changes' | 'history' | 'branches'>('changes')
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [discarding, setDiscarding] = useState<GitFileChange | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<Map<string, GitFileChange[]>>(new Map())
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [remoteModal, setRemoteModal] = useState<RemoteModal>(null)
  const [removingRemote, setRemovingRemote] = useState<string | null>(null)
  // 「冲突已解决,请提交」提示:出现过冲突且当前已清零时显示(提交/换工作区后清除)
  const [resolvedHint, setResolvedHint] = useState(false)
  const hadConflictsRef = useRef(false)
  const commitBoxRef = useRef<HTMLTextAreaElement>(null)

  const root = workspaceRoot

  // 冲突组从「有」到「空」的迁移检测(git:changed 刷新驱动)
  useEffect(() => {
    const n = git.status?.conflicted.length ?? 0
    if (n > 0) {
      hadConflictsRef.current = true
      setResolvedHint(false)
    } else if (hadConflictsRef.current) {
      hadConflictsRef.current = false
      setResolvedHint(true)
    }
  }, [git.status])
  useEffect(() => {
    hadConflictsRef.current = false
    setResolvedHint(false)
  }, [root])

  // 原生 Git 菜单联动(menuBridge 派发的 pixelbox:git-ui;App 负责打开工具窗,
  // 这里只处理已挂载时的视图切换/聚焦)
  useEffect(() => {
    const onUi = (e: Event): void => {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action
      if (action === 'commit') {
        setView('changes')
        // 等视图切换渲染完成再聚焦
        window.setTimeout(() => commitBoxRef.current?.focus(), 0)
      } else if (action === 'newBranch') {
        setView('branches')
        setCreatingBranch(true)
      } else if (action === 'remotes') {
        setView('branches')
      }
    }
    window.addEventListener('pixelbox:git-ui', onUi)
    return () => window.removeEventListener('pixelbox:git-ui', onUi)
  }, [])

  // ---- 动作 ----

  const withErrToast = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      const code = gitErrCode(err)
      showToast(t(`git.errors.${code}`, { defaultValue: t('git.errors.failed') }), 'error')
    }
  }

  const doRefresh = (): void => {
    if (root) void refreshGitAll(root)
  }

  const doInit = (): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitInit(root)
      showToast(t('git.initDone'), 'success')
      await refreshGitAll(root)
    })
  }

  const doStage = (f: GitFileChange): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitStage(root, [f.path])
      await refreshGitStatus(root)
    })
  }

  /** 全部暂存(git add -A 语义:git:stage 传 [root] → main 归一化为 '.') */
  const doStageAll = (): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitStage(root, [root])
      showToast(t('git.stageAllDone'), 'success')
      await refreshGitStatus(root)
    })
  }

  /** 冲突解决(ours/theirs/mark;成功后 main 广播 git:changed 自动刷新) */
  const doResolve = (f: GitFileChange, strategy: GitResolveStrategy): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitResolve(root, [f.path], strategy)
      showToast(t('git.resolveDone', { name: f.relPath }), 'success')
      await refreshGitStatus(root)
    })
  }

  /** 切分支 / 新建分支(分支视图行点击与「新建分支…」共用) */
  const doCheckout = (branch: string, create: boolean): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitCheckout(root, branch, create)
      showToast(t('git.checkedOut', { name: branch }), 'success')
      await refreshGitAll(root)
    })
  }

  // ---- Remotes 操作(添加两步 InputModal:name → url;编辑直接进 url 步) ----

  const doRemoteAdd = (name: string, url: string): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitRemoteAdd(root, name, url)
      showToast(t('git.remotes.addDone', { name }), 'success')
      await refreshGitAll(root)
    })
  }

  const doRemoteSetUrl = (name: string, url: string): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitRemoteSetUrl(root, name, url)
      showToast(t('git.remotes.urlDone', { name }), 'success')
      await refreshGitAll(root)
    })
  }

  const doRemoteRemove = (name: string): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitRemoteRemove(root, name)
      showToast(t('git.remotes.removeDone', { name }), 'success')
      await refreshGitAll(root)
    })
  }

  const doUnstage = (f: GitFileChange): void => {
    if (!root) return
    void withErrToast(async () => {
      // 暂存的重命名(R)是「旧路径删除 + 新路径添加」两条 index 记录:
      // 只 reset 新路径会留下半撤销态(已暂存 D 旧路径 + 未跟踪新路径),旧路径一并 reset
      const paths = f.origRelPath ? [f.path, `${root}/${f.origRelPath}`] : [f.path]
      await window.api.gitUnstage(root, paths)
      await refreshGitStatus(root)
    })
  }

  const doDiscard = (f: GitFileChange): void => {
    if (!root) return
    void withErrToast(async () => {
      await window.api.gitDiscard(root, [f.path], f.status === 'U')
      showToast(t('git.discarded', { name: f.relPath }), 'success')
      await refreshGitStatus(root)
    })
  }

  const doCommit = (): void => {
    if (!root || committing) return
    const msg = message.trim()
    if (msg.length === 0) return
    setCommitting(true)
    void withErrToast(async () => {
      await window.api.gitCommit(root, msg)
      setMessage('')
      setResolvedHint(false) // 冲突解决后的提示随提交完成消失
      showToast(t('git.commitDone'), 'success')
      await refreshGitAll(root)
    }).finally(() => setCommitting(false))
  }

  const doOp = (op: 'push' | 'pull'): void => {
    if (!root || git.opRunning) return
    clearOpLog()
    setLogOpen(true)
    setOpRunning(op)
    void withErrToast(async () => {
      if (op === 'push') await window.api.gitPush(root)
      else await window.api.gitPull(root)
      showToast(t(op === 'push' ? 'git.pushDone' : 'git.pullDone'), 'success')
      await refreshGitAll(root)
    }).finally(() => setOpRunning(null))
  }

  /** 变更行点击:working-tree diff(staged 行对 HEAD,同样直观) */
  const openWorktreeDiff = (f: GitFileChange): void => {
    onOpenDiff({
      title: `${f.relPath.split('/').pop() ?? f.relPath} (${t('git.diffVsHead')})`,
      leftRev: 'HEAD',
      rightRev: 'worktree',
      relPath: f.relPath,
      absPath: f.path,
      ...(f.origRelPath !== undefined ? { leftRelPath: f.origRelPath } : {})
    })
  }

  /** 历史文件点击:该 commit vs 第一父 diff */
  const openCommitDiff = (c: GitCommitInfo, f: GitFileChange): void => {
    onOpenDiff({
      title: `${f.relPath.split('/').pop() ?? f.relPath} (${c.shortHash})`,
      leftRev: c.parents[0] ?? c.hash + '^', // 根提交无父:show 失败回空串,呈现「全新增」
      rightRev: c.hash,
      relPath: f.relPath,
      ...(f.origRelPath !== undefined ? { leftRelPath: f.origRelPath } : {})
    })
  }

  const toggleCommit = (c: GitCommitInfo): void => {
    if (!root) return
    if (expandedCommit === c.hash) {
      setExpandedCommit(null)
      return
    }
    setExpandedCommit(c.hash)
    if (!commitFiles.has(c.hash)) {
      void window.api
        .gitCommitFiles(root, c.hash)
        .then((files) => setCommitFiles((prev) => new Map(prev).set(c.hash, files)))
        .catch(() => undefined)
    }
  }

  // ---- 车道图布局(log 变化才重算) ----
  const graphRows = useMemo(() => layoutCommitGraph(git.log), [git.log])

  // ---- 空态 / 非仓库态 ----

  if (!root) {
    return (
      <div className="flex h-full items-center justify-center bg-ink-900 px-4 text-center text-[13px] text-jb-muted">
        {t('git.noWorkspace')}
      </div>
    )
  }
  if (git.info && !git.info.gitFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-ink-900 px-4 text-center">
        <div className="text-[13px] text-jb-muted">{t('git.noGit')}</div>
      </div>
    )
  }
  if (git.loaded && git.info && !git.info.isRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-900 px-4 text-center">
        <LuGitBranch className="text-3xl text-ink-500" />
        <div className="text-[13px] text-jb-muted">{t('git.notRepo')}</div>
        <button
          onClick={doInit}
          className="rounded bg-accent px-3 py-1 text-xs text-white hover:bg-accent-dim"
        >
          {t('git.init')}
        </button>
      </div>
    )
  }

  const st = git.status
  const groups: Array<{ key: string; label: string; files: GitFileChange[]; staged: boolean }> = st
    ? [
        { key: 'conflicted', label: t('git.group.conflicted'), files: st.conflicted, staged: false },
        { key: 'staged', label: t('git.group.staged'), files: st.staged, staged: true },
        { key: 'unstaged', label: t('git.group.unstaged'), files: st.unstaged, staged: false },
        { key: 'untracked', label: t('git.group.untracked'), files: st.untracked, staged: false }
      ].filter((g) => g.files.length > 0)
    : []

  const opBusy = git.opRunning !== null

  return (
    <div className="flex h-full flex-col bg-ink-900">
      {/* 工具行:分段切换 + 操作按钮 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-ink-700 bg-ink-850 px-2">
        <div className="flex shrink-0 items-center gap-0.5 rounded border border-ink-700 p-0.5">
          {(['changes', 'history', 'branches'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`flex h-5 items-center whitespace-nowrap rounded px-2 text-[11px] ${
                view === v
                  ? 'bg-jb-selection text-jb-text'
                  : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
              }`}
            >
              {t(
                v === 'changes'
                  ? 'git.viewChanges'
                  : v === 'history'
                    ? 'git.viewHistory'
                    : 'git.viewBranches'
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <ToolButton title={t('git.refresh')} onClick={doRefresh}>
            <LuRefreshCw />
          </ToolButton>
          <ToolButton title={t('git.stageAll')} disabled={opBusy} onClick={doStageAll}>
            <LuListChecks />
          </ToolButton>
          <ToolButton
            title={t('git.commit')}
            disabled={committing || opBusy}
            spinning={committing}
            onClick={doCommit}
          >
            <LuCheck />
          </ToolButton>
          <ToolButton
            title={t('git.pull')}
            disabled={opBusy}
            spinning={git.opRunning === 'pull'}
            onClick={() => doOp('pull')}
          >
            <LuArrowDownToLine />
          </ToolButton>
          <ToolButton
            title={t('git.push')}
            disabled={opBusy}
            spinning={git.opRunning === 'push'}
            onClick={() => doOp('push')}
          >
            <LuArrowUpFromLine />
          </ToolButton>
        </div>
      </div>

      {view === 'changes' && (
        <>
          {/* 变更列表 */}
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {/* 冲突全部清零提示(冲突分组原位置,列表顶部) */}
            {resolvedHint && (
              <div className="mx-2 my-1 flex items-center gap-1.5 rounded border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-green-400">
                <LuCheck className="shrink-0" />
                {t('git.conflictsResolved')}
              </div>
            )}
            {groups.length === 0 && git.loaded && !resolvedHint && (
              <div className="px-3 py-2 text-[12px] text-ink-500">{t('git.noChanges')}</div>
            )}
            {groups.map((g) => (
              <div key={g.key}>
                <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
                  {g.label}({g.files.length})
                </div>
                {g.files.map((f) => (
                  <div
                    key={`${g.key}:${f.path}`}
                    title={f.relPath}
                    onClick={() => openWorktreeDiff(f)}
                    className="group flex h-6 cursor-pointer items-center gap-1.5 pl-3 pr-2 text-[13px] hover:bg-ink-800"
                  >
                    <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${GIT_STATUS_CLS[f.status] ?? 'text-jb-muted'}`}>
                      {f.status}
                    </span>
                    {/* 文件名与徽标同色(IDEA 式;映射见 fileStatusColors.ts) */}
                    <span className={`min-w-0 flex-1 truncate ${GIT_STATUS_CLS[f.status] ?? 'text-jb-text'}`}>
                      {f.relPath}
                    </span>
                    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      {g.key === 'conflicted' ? (
                        <>
                          {/* 冲突行:采用我方 / 采用对方 / 标记已解决 */}
                          <RowButton title={t('git.resolveOurs')} onClick={() => doResolve(f, 'ours')}>
                            <LuArrowLeft />
                          </RowButton>
                          <RowButton title={t('git.resolveTheirs')} onClick={() => doResolve(f, 'theirs')}>
                            <LuArrowRight />
                          </RowButton>
                          <RowButton title={t('git.resolveMark')} onClick={() => doResolve(f, 'mark')}>
                            <LuCheck />
                          </RowButton>
                        </>
                      ) : g.staged ? (
                        <RowButton title={t('git.unstage')} onClick={() => doUnstage(f)}>
                          <LuMinus />
                        </RowButton>
                      ) : (
                        <RowButton title={t('git.stage')} onClick={() => doStage(f)}>
                          <LuPlus />
                        </RowButton>
                      )}
                      {!g.staged && g.key !== 'conflicted' && (
                        <RowButton title={t('git.discard')} danger onClick={() => setDiscarding(f)}>
                          <LuUndo2 />
                        </RowButton>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* 提交区 */}
          <div className="shrink-0 border-t border-ink-700 p-2">
            <textarea
              ref={commitBoxRef}
              value={message}
              placeholder={t('git.commitPlaceholder')}
              spellCheck={false}
              rows={3}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  doCommit()
                }
              }}
              className="w-full resize-none rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-[12px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button
                disabled={committing || message.trim().length === 0}
                onClick={doCommit}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs text-white ${
                  committing || message.trim().length === 0
                    ? 'cursor-not-allowed bg-ink-600'
                    : 'bg-accent hover:bg-accent-dim'
                }`}
              >
                {committing ? <VscLoading className="animate-spin" /> : <LuCheck />}
                {t('git.commit')}
              </button>
              {git.info && (
                <span className="ml-auto flex items-center gap-1 truncate text-[11px] text-ink-500">
                  <LuGitBranch className="shrink-0" />
                  {git.info.branch ?? '?'}
                  {(git.info.ahead > 0 || git.info.behind > 0) && (
                    <span>
                      {git.info.ahead > 0 ? ` ↑${git.info.ahead}` : ''}
                      {git.info.behind > 0 ? ` ↓${git.info.behind}` : ''}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* push/pull 输出日志(折叠) */}
          {git.opLog.length > 0 && (
            <div className="shrink-0 border-t border-ink-700">
              <button
                onClick={() => setLogOpen((v) => !v)}
                className="flex h-6 w-full items-center gap-1 px-2 text-[11px] text-jb-muted hover:bg-ink-800"
              >
                {logOpen ? <LuChevronDown /> : <LuChevronRight />}
                {t('git.opLog')}
                {opBusy && <VscLoading className="animate-spin text-accent" />}
              </button>
              {logOpen && (
                <div className="selectable max-h-40 overflow-auto px-2 pb-1 font-mono text-[11px] leading-4 text-jb-muted">
                  {git.opLog.map((l, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">
                      {l}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {view === 'history' && (
        /* 历史视图:车道图 + commit 列表 */
        <div className="min-h-0 flex-1 overflow-auto">
          {git.log.length === 0 && git.loaded && (
            <div className="px-3 py-2 text-[12px] text-ink-500">{t('git.noCommits')}</div>
          )}
          {git.log.map((c, i) => {
            const row = graphRows[i]
            const laneW = 12
            const h = 24
            const cx = (l: number): number => l * laneW + laneW / 2
            const svgW = Math.max(1, row?.laneCount ?? 1) * laneW
            const expanded = expandedCommit === c.hash
            return (
              <div key={c.hash}>
                <div
                  onClick={() => toggleCommit(c)}
                  title={`${c.subject}\n${c.author} <${c.email}>`}
                  className={`flex h-6 cursor-pointer items-center gap-1.5 pr-2 text-[12px] ${
                    expanded ? 'bg-jb-selection/70 text-jb-text' : 'text-jb-text hover:bg-ink-800'
                  }`}
                >
                  {/* SVG 车道图列(泳道折线;简洁实现) */}
                  <svg width={svgW} height={h} className="shrink-0">
                    {row && (
                      <>
                        {row.passLanes.map((l) => (
                          <line key={`p${l}`} x1={cx(l)} y1={0} x2={cx(l)} y2={h} className="stroke-ink-500" strokeWidth={1.5} />
                        ))}
                        {row.inLanes.map((l) => (
                          <line key={`i${l}`} x1={cx(l)} y1={0} x2={cx(row.lane)} y2={h / 2} className="stroke-ink-500" strokeWidth={1.5} />
                        ))}
                        {row.outLanes.map((l) => (
                          <line key={`o${l}`} x1={cx(row.lane)} y1={h / 2} x2={cx(l)} y2={h} className="stroke-ink-500" strokeWidth={1.5} />
                        ))}
                        <circle cx={cx(row.lane)} cy={h / 2} r={3} className="fill-accent" />
                      </>
                    )}
                  </svg>
                  <span className="shrink-0 font-mono text-[11px] text-jb-muted">{c.shortHash}</span>
                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                  <span className="shrink-0 truncate text-[11px] text-ink-500">{c.author}</span>
                  <span className="shrink-0 text-[11px] text-ink-500">{relTime(c.timestamp, t)}</span>
                </div>
                {/* 展开:该 commit 的变更文件列表 */}
                {expanded && (
                  <div className="border-b border-ink-700/50 py-0.5">
                    {(commitFiles.get(c.hash) ?? []).map((f) => (
                      <div
                        key={f.path}
                        title={f.relPath}
                        onClick={() => openCommitDiff(c, f)}
                        className="flex h-6 cursor-pointer items-center gap-1.5 pl-6 pr-2 text-[12px] text-jb-text hover:bg-ink-800"
                      >
                        <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${GIT_STATUS_CLS[f.status] ?? 'text-jb-muted'}`}>
                          {f.status}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{f.relPath}</span>
                      </div>
                    ))}
                    {!commitFiles.has(c.hash) && (
                      <div className="flex h-6 items-center pl-6 text-[11px] text-ink-500">
                        <VscLoading className="animate-spin" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {view === 'branches' && (
        /* 分支视图:本地分支列表(当前高亮,点击切换)+ 底部 Remotes 小节 */
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <div className="flex items-center px-2 pb-0.5 pt-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
              {t('git.branches')}({git.branches.length})
            </span>
            <button
              onClick={() => setCreatingBranch(true)}
              className="ml-auto flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-jb-muted hover:bg-ink-800 hover:text-jb-text"
            >
              <LuPlus />
              {t('git.newBranch')}
            </button>
          </div>
          {git.branches.map((b) => (
            <div
              key={b.name}
              title={b.current ? t('git.currentBranch') : t('git.switchBranch')}
              onClick={() => {
                if (!b.current) doCheckout(b.name, false)
              }}
              className={`flex h-6 items-center gap-1.5 pl-3 pr-2 text-[13px] ${
                b.current
                  ? 'bg-jb-selection text-jb-text'
                  : 'cursor-pointer text-jb-text hover:bg-ink-800'
              }`}
            >
              <LuGitBranch className="shrink-0 text-jb-muted" />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              {b.current && <LuCheck className="shrink-0 text-accent" />}
            </div>
          ))}
          {git.branches.length === 0 && git.loaded && (
            <div className="px-3 py-2 text-[12px] text-ink-500">{t('git.noCommits')}</div>
          )}

          {/* Remotes 小节 */}
          <div className="mt-2 border-t border-ink-700 pt-1">
            <div className="flex items-center px-2 pb-0.5 pt-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
                {t('git.remotes.title')}({git.remotes.length})
              </span>
              <button
                onClick={() => setRemoteModal({ step: 'name' })}
                className="ml-auto flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-jb-muted hover:bg-ink-800 hover:text-jb-text"
              >
                <LuPlus />
                {t('git.remotes.add')}
              </button>
            </div>
            {git.remotes.map((r) => (
              <div
                key={r.name}
                title={`${r.name}\nfetch: ${r.fetchUrl}\npush: ${r.pushUrl}`}
                className="group flex h-6 items-center gap-1.5 pl-3 pr-2 text-[13px] text-jb-text hover:bg-ink-800"
              >
                <span className="shrink-0 font-medium">{r.name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-jb-muted">{r.fetchUrl}</span>
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <RowButton
                    title={t('git.remotes.editUrl')}
                    onClick={() => setRemoteModal({ step: 'url', name: r.name, initial: r.fetchUrl, editing: true })}
                  >
                    <LuPencil />
                  </RowButton>
                  <RowButton title={t('git.remotes.remove')} danger onClick={() => setRemovingRemote(r.name)}>
                    <LuTrash2 />
                  </RowButton>
                </span>
              </div>
            ))}
            {git.remotes.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-ink-500">{t('git.remotes.empty')}</div>
            )}
          </div>
        </div>
      )}

      {/* 丢弃确认(破坏性操作) */}
      {discarding && (
        <ConfirmModal
          message={t('git.discardConfirm', { name: discarding.relPath })}
          onConfirm={() => {
            doDiscard(discarding)
            setDiscarding(null)
          }}
          onCancel={() => setDiscarding(null)}
        />
      )}

      {/* 新建分支(分支视图按钮 / 原生菜单 newBranch 共用) */}
      {creatingBranch && (
        <InputModal
          title={t('git.newBranchTitle')}
          placeholder={t('git.newBranchPlaceholder')}
          onConfirm={(name) => {
            setCreatingBranch(false)
            doCheckout(name, true)
          }}
          onCancel={() => setCreatingBranch(false)}
        />
      )}

      {/* Remotes:添加(两步 name → url)/ 改 URL(直接 url 步) */}
      {remoteModal?.step === 'name' && (
        <InputModal
          title={t('git.remotes.nameTitle')}
          placeholder={t('git.remotes.namePlaceholder')}
          onConfirm={(name) => setRemoteModal({ step: 'url', name })}
          onCancel={() => setRemoteModal(null)}
        />
      )}
      {remoteModal?.step === 'url' && (
        <InputModal
          title={t('git.remotes.urlTitle', { name: remoteModal.name })}
          placeholder={t('git.remotes.urlPlaceholder')}
          initialValue={remoteModal.initial ?? ''}
          onConfirm={(url) => {
            const { name, editing } = remoteModal
            setRemoteModal(null)
            if (editing) doRemoteSetUrl(name, url)
            else doRemoteAdd(name, url)
          }}
          onCancel={() => setRemoteModal(null)}
        />
      )}

      {/* 删除 remote 确认 */}
      {removingRemote && (
        <ConfirmModal
          message={t('git.remotes.removeConfirm', { name: removingRemote })}
          onConfirm={() => {
            doRemoteRemove(removingRemote)
            setRemovingRemote(null)
          }}
          onCancel={() => setRemovingRemote(null)}
        />
      )}
    </div>
  )
}
