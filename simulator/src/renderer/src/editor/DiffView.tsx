/**
 * Git Diff 查看器(diff 页签主体;EditorHost hidden + 兄弟节点范式,同 MarkdownPreview)
 *
 * - monaco.editor.createDiffEditor,只读、side-by-side、automaticLayout
 * - 左侧 model URI 必须用自定义 scheme(pbgit://left/<rev>/<relPath>):
 *   用 monaco.Uri.file 会与 EditorHost ensureModel 的孤儿回收撞车,
 *   dispose 掉工作区同路径的活 model 丢失未保存编辑
 * - 右侧:working-tree diff(rightRev='worktree')优先复用工作区活 model
 *   (monaco.Uri.file(absPath),编辑实时联动 diff),没有则自建 pbgit://right
 *   只读 model;commit diff 两侧都自建
 * - 只 dispose 自己建的 model;语言用 monacoSetup 的 languageForPath
 */
import { useEffect, useRef } from 'react'
import { monaco, languageForPath, monacoThemeName } from './monacoSetup'

export interface DiffSpec {
  /** 页签标题(EditorTabs 展示,由打开方拼好) */
  title: string
  /** 左侧版本(commit hash / HEAD 等) */
  leftRev: string
  /** 右侧版本:'worktree' = 工作区当前内容;否则 commit hash */
  rightRev: string
  /** 相对工作区根路径('/' 分隔) */
  relPath: string
  /** 绝对路径(worktree diff 时复用活 model / 读盘) */
  absPath?: string
  /** 左侧取旧路径(重命名文件 diff;缺省同 relPath) */
  leftRelPath?: string
}

interface Props {
  root: string
  spec: DiffSpec
}

export function DiffView({ root, spec }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let alive = true
    const owned: monaco.editor.ITextModel[] = []
    /** 活 model 的 onWillDispose 等订阅(卸载时退订) */
    const subs: monaco.IDisposable[] = []
    const language = languageForPath(spec.relPath)

    const diffEditor = monaco.editor.createDiffEditor(el, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      theme: monacoThemeName(),
      // 与 EditorHost 一致的观感细节
      scrollBeyondLastLine: false,
      renderOverviewRuler: true
    })

    /** 自建只读 model(pbgit scheme,已存在同 uri 时直接复用不重复建) */
    const buildModel = (side: 'left' | 'right', rev: string, relPath: string, content: string): monaco.editor.ITextModel => {
      const uri = monaco.Uri.parse(`pbgit://${side}/${encodeURIComponent(rev)}/${relPath}`)
      const existing = monaco.editor.getModel(uri)
      if (existing) {
        existing.setValue(content)
        return existing
      }
      const m = monaco.editor.createModel(content, language, uri)
      owned.push(m)
      return m
    }

    void (async () => {
      const leftRel = spec.leftRelPath ?? spec.relPath
      // 左侧:指定版本内容(该版本无此文件 → 空串,新增文件 diff 左空右全)
      const leftContent = await window.api.gitShowFile(root, spec.leftRev, leftRel).catch(() => '')
      if (!alive) return
      const original = buildModel('left', spec.leftRev, leftRel, leftContent)

      let modified: monaco.editor.ITextModel
      if (spec.rightRev === 'worktree') {
        // 优先复用工作区活 model(编辑实时联动);没有则读盘自建只读 model
        const live = spec.absPath ? monaco.editor.getModel(monaco.Uri.file(spec.absPath)) : null
        if (live) {
          modified = live
          // 活 model 可能先于本页签被销毁(源文件页签关闭 → EditorHost closeFile
          // → dispose;monaco 对已挂载 model 被 dispose 会抛 BugIndicatingError
          // 并把 diff 两侧清空)。onWillDispose 时用其末态内容回退为自建只读 model
          subs.push(
            live.onWillDispose(() => {
              if (!alive) return
              const fallback = buildModel('right', 'worktree', spec.relPath, live.getValue())
              diffEditor.setModel({ original, modified: fallback })
            })
          )
        } else {
          const content = spec.absPath
            ? await window.api.readFile(spec.absPath).catch(() => '')
            : ''
          if (!alive) return
          modified = buildModel('right', 'worktree', spec.relPath, content)
        }
      } else {
        const content = await window.api.gitShowFile(root, spec.rightRev, spec.relPath).catch(() => '')
        if (!alive) return
        modified = buildModel('right', spec.rightRev, spec.relPath, content)
      }
      if (!alive) return
      diffEditor.setModel({ original, modified })
    })()

    return () => {
      alive = false
      diffEditor.dispose()
      // 只回收自己建的 model(工作区活 model 归 EditorHost 管)
      for (const s of subs) s.dispose()
      for (const m of owned) m.dispose()
    }
    // spec 为打开页签时固定的对象,root/关键字段变化时整体重建
    // eslint 无此工程:依赖按值展开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, spec.leftRev, spec.rightRev, spec.relPath, spec.absPath, spec.leftRelPath])

  return <div ref={containerRef} className="h-full w-full" />
}
