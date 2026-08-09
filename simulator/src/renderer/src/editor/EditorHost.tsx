/**
 * Monaco 编辑器宿主(编辑器组)
 * - 分屏(IDE v3.x)后同时挂两个实例:模型生命周期已上收 modelRegistry
 *   (模块级 refCount,见 modelRegistry.ts),本组件只管自己的 monaco 实例、
 *   每文件 viewState、⌘S 保存当前激活文件与虚拟页签只读切换
 * - openFile/openVirtual/closeFile 全部经 registry acquire/release:同一文件
 *   可同时在两组打开,引用归零才 dispose(跨组互杀模型的事故由此杜绝)
 * - onFocused:实例获得焦点 → App 置本组为活动组(新文件进活动组的依据)
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { monaco, monacoThemeName } from './monacoSetup'
import { editorViewSettings, subscribeEditorSettings } from './editorSettings'
import { modelRegistry, type RegistryEntry } from './modelRegistry'

export interface EditorHostHandle {
  /** 打开文件(必要时经 registry 读盘建 model)并激活 */
  openFile(path: string): Promise<void>
  /** 打开虚拟库文件(extraLib 声明,内容随参数传入)为只读页签并激活 */
  openVirtual(path: string, content: string): Promise<void>
  /** 激活本组已打开的文件 */
  setActive(path: string): void
  /** 关闭文件并释放本组引用(registry 归零才销毁 model) */
  closeFile(path: string): void
  /** 保存指定文件,成功返回 true(全局语义,转 registry) */
  saveFile(path: string): Promise<boolean>
  /** 保存全部脏文件(全局语义,转 registry) */
  saveAll(): Promise<void>
  /** 外部变更时:若该文件无未保存修改则从磁盘重载(全局语义,转 registry) */
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
  /** 光标位置变化(驱动状态栏「行:列」;分屏时 App 按活动组过滤展示) */
  onCursorChange?: (line: number, column: number) => void
  /** 视口变化(滚动;会话恢复的去抖落盘触发,光标变化经 onCursorChange 另行触发) */
  onViewStateChange?: () => void
  /** 编辑器获得焦点(App 置本组为活动组) */
  onFocused?: () => void
}

type Entry = RegistryEntry<monaco.editor.ITextModel>

/** 本组对一条注册表条目的持有登记(ready 存 Promise:并发 open 只 acquire 一次) */
interface HeldRecord {
  path: string
  ready: Promise<Entry>
}

export const EditorHost = forwardRef<EditorHostHandle, Props>(function EditorHost(
  { onCursorChange, onViewStateChange, onFocused },
  ref
): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // 本组持有的注册表引用(键 = registry 归一化键):open 时 acquire 登记,
  // close/卸载时 release。同键幂等 —— 重复 openFile 不会多计引用
  const heldRef = useRef<Map<string, HeldRecord>>(new Map())
  const activePathRef = useRef<string | null>(null)
  // 每文件 viewState(滚动/光标):切标签时暂存并回放;会话恢复的快照/回放亦经此表
  const viewStatesRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map())
  const onCursorChangeRef = useRef(onCursorChange)
  onCursorChangeRef.current = onCursorChange
  const onViewStateChangeRef = useRef(onViewStateChange)
  onViewStateChangeRef.current = onViewStateChange
  const onFocusedRef = useRef(onFocused)
  onFocusedRef.current = onFocused

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

  /** 激活条目:换 model + 按虚拟标记切只读(库声明页签防误编辑)+ 回放 viewState */
  function activateModel(path: string, entry: Entry): void {
    stashActiveViewState()
    activePathRef.current = path
    editorRef.current?.setModel(entry.model)
    editorRef.current?.updateOptions(
      entry.virtual
        ? { readOnly: true, readOnlyMessage: { value: '只读页签(库声明 / 外部头文件)' } }
        : { readOnly: false }
    )
    applyStoredViewState(path)
    editorRef.current?.focus()
  }

  /** acquire 并登记持有(同键幂等;acquire 失败回滚登记,不留死引用) */
  function holdFile(path: string): Promise<Entry> {
    const key = modelRegistry.keyFor(path)
    const held = heldRef.current.get(key)
    if (held) return held.ready
    const record: HeldRecord = { path, ready: modelRegistry.acquireFile(path) }
    heldRef.current.set(key, record)
    record.ready.catch(() => {
      // 读盘失败:仅当表里还是这条登记才删(避免误删后续重试的新登记)
      if (heldRef.current.get(key) === record) heldRef.current.delete(key)
    })
    return record.ready
  }

  /** 释放本组对 path 的引用(open 尚在读盘时:等建模完成对上引用再减) */
  function releaseHeld(path: string): void {
    const key = modelRegistry.keyFor(path)
    const held = heldRef.current.get(key)
    if (!held) return
    heldRef.current.delete(key)
    void held.ready.then(() => modelRegistry.release(held.path)).catch(() => undefined)
  }

  useEffect(() => {
    if (!containerRef.current) return
    const view = editorViewSettings()
    const editor = monaco.editor.create(containerRef.current, {
      theme: monacoThemeName(), // 自定义深浅主题成对,随有效主题热切(monacoSetup.ts)
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
      fixedOverflowWidgets: true,
      // 联想状态栏(底部「⌘I 查看文档」提示)+ 多定义直接跳第一个(peek 面板在
      // 单编辑器布局里易迷失,统一为页签跳转,与 registerEditorOpener 链路一致)
      suggest: { showStatusBar: true },
      gotoLocation: {
        multipleDefinitions: 'goto',
        multipleTypeDefinitions: 'goto',
        multipleDeclarations: 'goto',
        multipleImplementations: 'goto'
      }
    })
    editorRef.current = editor

    // 联想详情(TSDoc)默认展开:standalone 的 storage 是内存实现,
    // 'expandSuggestionDocs' 每次启动都回落 false,用户只能看到单行 detail 而
    // 看不到文档。经 suggestController 内部 API 预置 true;API 形状变动时静默
    // 降级(suggest 状态栏的 ⌘I 仍可手动展开)
    try {
      const sc = editor.getContribution('editor.contrib.suggestController') as unknown as {
        widget?: { value?: { _setDetailsVisible?: (v: boolean) => void } }
      } | null
      sc?.widget?.value?._setDetailsVisible?.(true)
    } catch {
      // 保持默认折叠
    }

    // 光标位置 → 状态栏
    editor.onDidChangeCursorPosition((e) => {
      onCursorChangeRef.current?.(e.position.lineNumber, e.position.column)
    })

    // 滚动 → 会话恢复的去抖落盘触发(viewState 含滚动位置)
    editor.onDidScrollChange(() => {
      onViewStateChangeRef.current?.()
    })

    // 焦点 → 活动组跟随(分屏时点击/键入哪组,新文件就进哪组)
    editor.onDidFocusEditorWidget(() => {
      onFocusedRef.current?.()
    })

    // Cmd/Ctrl + S 保存当前文件(模型与保存点在 registry)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const p = activePathRef.current
      if (p) void modelRegistry.saveFile(p)
    })

    // 设置变化(settings:changed 镜像)即时生效:minimap/字号/字体族 +
    // 全部模型 Tab 宽度(registry 全局,两实例重复调用幂等)
    const unsubSettings = subscribeEditorSettings(() => {
      const next = editorViewSettings()
      editor.updateOptions({
        fontSize: next.fontSize,
        fontFamily: next.fontFamily,
        minimap: { enabled: next.minimap, renderCharacters: false, maxColumn: 100 }
      })
      modelRegistry.setTabSize(next.tabSize)
    })

    const held = heldRef.current
    return () => {
      unsubSettings()
      editor.dispose()
      // 卸载:释放本组全部引用(归零的模型由 registry dispose;
      // 另一组仍持有的模型继续存活 —— 绝不越权销毁)
      for (const rec of [...held.values()]) {
        void rec.ready.then(() => modelRegistry.release(rec.path)).catch(() => undefined)
      }
      held.clear()
    }
    // eslint 无此工程,依赖数组刻意为空:仅挂载/卸载一次
  }, [])

  useImperativeHandle(ref, () => ({
    async openFile(path: string): Promise<void> {
      const entry = await holdFile(path)
      activateModel(path, entry)
    },
    async openVirtual(path: string, content: string): Promise<void> {
      const key = modelRegistry.keyFor(path)
      let held = heldRef.current.get(key)
      if (!held) {
        held = { path, ready: Promise.resolve(modelRegistry.acquireVirtual(path, content)) }
        heldRef.current.set(key, held)
      }
      activateModel(path, await held.ready)
    },
    setActive(path: string): void {
      const held = heldRef.current.get(modelRegistry.keyFor(path))
      if (!held) return
      void held.ready.then((entry) => activateModel(path, entry)).catch(() => undefined)
    },
    closeFile(path: string): void {
      viewStatesRef.current.delete(path)
      const key = modelRegistry.keyFor(path)
      if (activePathRef.current !== null && modelRegistry.keyFor(activePathRef.current) === key) {
        activePathRef.current = null
        editorRef.current?.setModel(null)
      }
      releaseHeld(path)
    },
    saveFile(path: string): Promise<boolean> {
      return modelRegistry.saveFile(path)
    },
    saveAll(): Promise<void> {
      return modelRegistry.saveAll()
    },
    reloadIfClean(path: string): Promise<void> {
      return modelRegistry.reloadIfClean(path)
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
