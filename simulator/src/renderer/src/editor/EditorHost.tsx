/**
 * Monaco 编辑器宿主
 * - 每个打开文件一个 ITextModel(Uri.file),切换标签复用 model 保留撤销栈
 * - 脏状态:model.getAlternativeVersionId() 与保存点比较
 * - Cmd/Ctrl+S 保存当前文件(经 IPC 写盘)
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { monaco, languageForPath } from './monacoSetup'

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
}

interface Props {
  /** 脏状态变化(驱动标签/文件树的修改点) */
  onDirtyChange: (path: string, dirty: boolean) => void
}

interface ModelRecord {
  model: monaco.editor.ITextModel
  savedVersionId: number
  disposeListener: monaco.IDisposable
}

export const EditorHost = forwardRef<EditorHostHandle, Props>(function EditorHost(
  { onDirtyChange },
  ref
): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef<Map<string, ModelRecord>>(new Map())
  const activePathRef = useRef<string | null>(null)
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      fixedOverflowWidgets: true
    })
    editorRef.current = editor

    // Cmd/Ctrl + S 保存当前文件
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const p = activePathRef.current
      if (p) void saveFileInternal(p)
    })

    const models = modelsRef.current
    return () => {
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
      activePathRef.current = path
      editorRef.current?.setModel(rec.model)
      editorRef.current?.focus()
    },
    setActive(path: string): void {
      const rec = modelsRef.current.get(path)
      if (rec) {
        activePathRef.current = path
        editorRef.current?.setModel(rec.model)
        editorRef.current?.focus()
      }
    },
    closeFile(path: string): void {
      const rec = modelsRef.current.get(path)
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
    }
  }))

  return <div ref={containerRef} className="h-full w-full" />
})
