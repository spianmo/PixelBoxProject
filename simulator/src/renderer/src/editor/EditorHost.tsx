/**
 * Monaco 编辑器宿主
 * - 每个打开文件一个 ITextModel(Uri.file),切换标签复用 model 保留撤销栈
 * - 脏状态:model.getAlternativeVersionId() 与保存点比较
 * - Cmd/Ctrl+S 保存当前文件(经 IPC 写盘)
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { monaco, languageForPath } from './monacoSetup'
import { editorViewSettings, subscribeEditorSettings } from './editorSettings'

export interface EditorHostHandle {
  /** 打开文件(必要时读盘建 model)并激活 */
  openFile(path: string): Promise<void>
  /** 激活已打开的文件 */
  setActive(path: string): void
  /** 关闭文件并销毁 model */
  closeFile(path: string): void
  /** 保存指定文件,成功返回 true */
  saveFile(path: string): Promise<boolean>
  /** 保存全部脏文件 */
  saveAll(): Promise<void>
  /** 外部变更时:若该文件无未保存修改则从磁盘重载 */
  reloadIfClean(path: string): Promise<void>
  /** 定位到指定行列并居中(结构视图点击节点) */
  revealAt(line: number, column: number): void
  /** 底层 monaco 编辑器实例(结构视图 / Markdown 预览滚动同步用) */
  getEditor(): monaco.editor.IStandaloneCodeEditor | null
  /** 会话恢复:指定文件的 viewState(滚动/光标;激活文件取实时,其余取切换时暂存) */
  getViewState(path: string): unknown | null
  /** 会话恢复:恢复指定文件的 viewState(激活时立即应用,否则暂存待切换时应用) */
  restoreViewState(path: string, state: unknown): void
}

interface Props {
  /** 脏状态变化(驱动标签/文件树的修改点) */
  onDirtyChange: (path: string, dirty: boolean) => void
  /** 光标位置变化(驱动状态栏「行:列」) */
  onCursorChange?: (line: number, column: number) => void
  /** 视口变化(滚动;会话恢复的去抖落盘触发,光标变化经 onCursorChange 另行触发) */
  onViewStateChange?: () => void
}

interface ModelRecord {
  model: monaco.editor.ITextModel
  savedVersionId: number
  disposeListener: monaco.IDisposable
}

export const EditorHost = forwardRef<EditorHostHandle, Props>(function EditorHost(
  { onDirtyChange, onCursorChange, onViewStateChange },
  ref
): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef<Map<string, ModelRecord>>(new Map())
  const activePathRef = useRef<string | null>(null)
  // 每文件 viewState(滚动/光标):切标签时暂存并回放;会话恢复的快照/回放亦经此表
  const viewStatesRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map())
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange
  const onCursorChangeRef = useRef(onCursorChange)
  onCursorChangeRef.current = onCursorChange
  const onViewStateChangeRef = useRef(onViewStateChange)
  onViewStateChangeRef.current = onViewStateChange

  /** 暂存当前激活文件的 viewState(切标签 / 会话快照前调用) */
  function stashActiveViewState(): void {
    const p = activePathRef.current
    if (p && editorRef.current) viewStatesRef.current.set(p, editorRef.current.saveViewState())
  }

  /** 切到 path 后回放其暂存 viewState(无暂存则保持 Monaco 默认定位) */
  function applyStoredViewState(path: string): void {
    const vs = viewStatesRef.current.get(path)
    if (vs) editorRef.current?.restoreViewState(vs)
  }

  useEffect(() => {
    if (!containerRef.current) return
    const view = editorViewSettings()
    const editor = monaco.editor.create(containerRef.current, {
      theme: 'pixelbox-dark', // 自定义主题,对齐 IDE 色板(monacoSetup.ts)
      automaticLayout: true,
      // 字号/字体族/Tab 宽度/minimap 走 IDE 设置(settings.json editor 段)
      fontSize: view.fontSize,
      fontFamily: view.fontFamily,
      // minimap:色块模式(不渲染字符)更贴 JetBrains
      minimap: { enabled: view.minimap, renderCharacters: false, maxColumn: 100 },
      scrollBeyondLastLine: false,
      tabSize: view.tabSize,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      fixedOverflowWidgets: true
    })
    editorRef.current = editor

    // 光标位置 → 状态栏
    editor.onDidChangeCursorPosition((e) => {
      onCursorChangeRef.current?.(e.position.lineNumber, e.position.column)
    })

    // 滚动 → 会话恢复的去抖落盘触发(viewState 含滚动位置)
    editor.onDidScrollChange(() => {
      onViewStateChangeRef.current?.()
    })

    // Cmd/Ctrl + S 保存当前文件
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const p = activePathRef.current
      if (p) void saveFileInternal(p)
    })

    // 设置变化(settings:changed 镜像)即时生效:minimap/字号/字体族 + 全部模型 Tab 宽度
    const unsubSettings = subscribeEditorSettings(() => {
      const next = editorViewSettings()
      editor.updateOptions({
        fontSize: next.fontSize,
        fontFamily: next.fontFamily,
        minimap: { enabled: next.minimap, renderCharacters: false, maxColumn: 100 }
      })
      for (const rec of modelsRef.current.values()) {
        rec.model.updateOptions({ tabSize: next.tabSize })
      }
    })

    const models = modelsRef.current
    return () => {
      unsubSettings()
      editor.dispose()
      for (const rec of models.values()) {
        rec.disposeListener.dispose()
        rec.model.dispose()
      }
      models.clear()
    }
    // eslint 无此工程,依赖数组刻意为空:仅挂载/卸载一次
  }, [])

  async function saveFileInternal(path: string): Promise<boolean> {
    const rec = modelsRef.current.get(path)
    if (!rec) return false
    try {
      await window.api.writeFile(path, rec.model.getValue())
      rec.savedVersionId = rec.model.getAlternativeVersionId()
      onDirtyChangeRef.current(path, false)
      return true
    } catch (err) {
      // 写盘失败保持脏状态,交由上层 toast
      console.error('保存失败', err)
      return false
    }
  }

  async function ensureModel(path: string): Promise<ModelRecord> {
    const existing = modelsRef.current.get(path)
    if (existing) return existing
    const content = await window.api.readFile(path)
    const uri = monaco.Uri.file(path)
    // 防御:同 uri 的孤儿 model(异常关闭)先回收
    monaco.editor.getModel(uri)?.dispose()
    const model = monaco.editor.createModel(content, languageForPath(path), uri)
    // Tab 宽度是 model 级选项(新建 model 应用当前设置值)
    model.updateOptions({ tabSize: editorViewSettings().tabSize })
    const rec: ModelRecord = {
      model,
      savedVersionId: model.getAlternativeVersionId(),
      disposeListener: model.onDidChangeContent(() => {
        const r = modelsRef.current.get(path)
        if (r) onDirtyChangeRef.current(path, r.model.getAlternativeVersionId() !== r.savedVersionId)
      })
    }
    modelsRef.current.set(path, rec)
    return rec
  }

  useImperativeHandle(ref, () => ({
    async openFile(path: string): Promise<void> {
      const rec = await ensureModel(path)
      stashActiveViewState() // 暂存离开文件的滚动/光标
      activePathRef.current = path
      editorRef.current?.setModel(rec.model)
      applyStoredViewState(path)
      editorRef.current?.focus()
    },
    setActive(path: string): void {
      const rec = modelsRef.current.get(path)
      if (rec) {
        stashActiveViewState()
        activePathRef.current = path
        editorRef.current?.setModel(rec.model)
        applyStoredViewState(path)
        editorRef.current?.focus()
      }
    },
    closeFile(path: string): void {
      const rec = modelsRef.current.get(path)
      viewStatesRef.current.delete(path)
      if (!rec) return
      if (activePathRef.current === path) {
        activePathRef.current = null
        editorRef.current?.setModel(null)
      }
      rec.disposeListener.dispose()
      rec.model.dispose()
      modelsRef.current.delete(path)
    },
    saveFile(path: string): Promise<boolean> {
      return saveFileInternal(path)
    },
    async saveAll(): Promise<void> {
      for (const [path, rec] of modelsRef.current) {
        if (rec.model.getAlternativeVersionId() !== rec.savedVersionId) {
          await saveFileInternal(path)
        }
      }
    },
    async reloadIfClean(path: string): Promise<void> {
      const rec = modelsRef.current.get(path)
      if (!rec) return
      if (rec.model.getAlternativeVersionId() !== rec.savedVersionId) return // 有本地修改,不覆盖
      try {
        const content = await window.api.readFile(path)
        if (content !== rec.model.getValue()) {
          rec.model.setValue(content)
          rec.savedVersionId = rec.model.getAlternativeVersionId()
          onDirtyChangeRef.current(path, false)
        }
      } catch {
        // 文件可能已被删除,由文件树的 unlink 流程关闭标签
      }
    },
    revealAt(line: number, column: number): void {
      const editor = editorRef.current
      if (!editor) return
      editor.revealRangeInCenter(new monaco.Range(line, 1, line, 1), monaco.editor.ScrollType.Smooth)
      editor.setPosition({ lineNumber: line, column })
      editor.focus()
    },
    getEditor(): monaco.editor.IStandaloneCodeEditor | null {
      return editorRef.current
    },
    getViewState(path: string): unknown | null {
      // 激活文件取实时(暂存表只在切换时更新);其余取暂存
      if (path === activePathRef.current && editorRef.current) {
        return editorRef.current.saveViewState()
      }
      return viewStatesRef.current.get(path) ?? null
    },
    restoreViewState(path: string, state: unknown): void {
      const vs = (state ?? null) as monaco.editor.ICodeEditorViewState | null
      if (!vs) return
      viewStatesRef.current.set(path, vs) // 暂存:非激活文件切换到时回放
      if (path === activePathRef.current) editorRef.current?.restoreViewState(vs)
    }
  }))

  return <div ref={containerRef} className="h-full w-full" />
})
