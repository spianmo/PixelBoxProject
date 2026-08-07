/**
 * clangd LSP 桥(renderer)—— Monaco ⇄ main/clangd.ts
 *
 * - attachClangdModel():EditorHost 建 C/C++ model 时调用,惰性启动 clangd
 *   (main 侧按当前工作区拉起)并接入文档同步:didOpen / didChange(250ms 去抖,
 *   全文)/ didClose(model 销毁时)
 * - Monaco 语言提供方注册一次('c' + 'cpp'):补全 / 悬停 / 签名帮助
 *   (定义跳转刻意不做 —— 补全+悬停+诊断是本轮验收线)
 * - 诊断:clangd:event 的 publishDiagnostics → setModelMarkers(owner 'clangd')
 * - 状态 UX:noClangd / noCompileCommands 各弹一次性 toast;
 *   崩溃自动重启成功(clangd:status running)后重发全部 didOpen
 */
import { monaco } from './monacoSetup'
import { showToast } from '../components/toast'
import i18n from '../i18n'

// ---------------------------------------------------------------
// LSP 线缆类型(最小子集,够本桥使用)
// ---------------------------------------------------------------

interface LspPosition {
  line: number
  character: number
}
interface LspRange {
  start: LspPosition
  end: LspPosition
}
interface LspTextEdit {
  range: LspRange
  newText: string
}
interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | { value?: string }
  filterText?: string
  sortText?: string
  insertText?: string
  textEdit?: LspTextEdit
}
interface LspCompletionList {
  isIncomplete?: boolean
  items: LspCompletionItem[]
}
type LspMarkedString = string | { language: string; value: string }
interface LspHover {
  contents: { kind?: string; value: string } | LspMarkedString | LspMarkedString[]
  range?: LspRange
}
interface LspSignatureHelp {
  signatures: Array<{
    label: string
    documentation?: string | { value?: string }
    parameters?: Array<{ label: string | [number, number]; documentation?: string | { value?: string } }>
  }>
  activeSignature?: number
  activeParameter?: number
}
interface LspDiagnostic {
  range: LspRange
  severity?: number
  message: string
  source?: string
  code?: string | number
}

// ---------------------------------------------------------------
// 文档登记表
// ---------------------------------------------------------------

interface DocRecord {
  model: monaco.editor.ITextModel
  languageId: 'c' | 'cpp'
  /** LSP 文档版本(didChange 递增) */
  version: number
  /** 250ms 去抖定时器 */
  debounce: number | null
}

/** uri(model.uri.toString())→ 文档记录 */
const docs = new Map<string, DocRecord>()

let bridgeInited = false
/** clangd 会话已确认 running(didOpen 只在会话就绪后发) */
let sessionRunning = false
/** 一次性 toast 去重 */
const toastShown = new Set<string>()

/** 按扩展名判定 clangd 语言(.h 在固件工程语境按 C 处理) */
export function clangdLanguageIdForPath(path: string): 'c' | 'cpp' | null {
  const ext = path.toLowerCase().slice(path.lastIndexOf('.') + 1)
  if (ext === 'c' || ext === 'h') return 'c'
  if (['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'].includes(ext)) return 'cpp'
  return null
}

function oneTimeToast(key: string, kind: 'info' | 'warn'): void {
  if (toastShown.has(key)) return
  toastShown.add(key)
  showToast(i18n.t(key), kind)
}

// ---------------------------------------------------------------
// LSP ⇄ Monaco 坐标与结构映射
// ---------------------------------------------------------------

/** LSP 0-based Range → Monaco 1-based IRange */
function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1
  }
}

function toLspPosition(p: monaco.Position): LspPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 }
}

/** LSP CompletionItemKind(1-25)→ Monaco CompletionItemKind */
function toMonacoCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  switch (kind) {
    case 1: return K.Text
    case 2: return K.Method
    case 3: return K.Function
    case 4: return K.Constructor
    case 5: return K.Field
    case 6: return K.Variable
    case 7: return K.Class
    case 8: return K.Interface
    case 9: return K.Module
    case 10: return K.Property
    case 11: return K.Unit
    case 12: return K.Value
    case 13: return K.Enum
    case 14: return K.Keyword
    case 15: return K.Snippet
    case 16: return K.Color
    case 17: return K.File
    case 18: return K.Reference
    case 19: return K.Folder
    case 20: return K.EnumMember
    case 21: return K.Constant
    case 22: return K.Struct
    case 23: return K.Event
    case 24: return K.Operator
    case 25: return K.TypeParameter
    default: return K.Text
  }
}

/** LSP 诊断严重级(1-4)→ Monaco MarkerSeverity */
function toMonacoSeverity(severity: number | undefined): monaco.MarkerSeverity {
  switch (severity) {
    case 1: return monaco.MarkerSeverity.Error
    case 2: return monaco.MarkerSeverity.Warning
    case 3: return monaco.MarkerSeverity.Info
    case 4: return monaco.MarkerSeverity.Hint
    default: return monaco.MarkerSeverity.Error
  }
}

function docString(d: string | { value?: string } | undefined): string | undefined {
  if (d === undefined) return undefined
  return typeof d === 'string' ? d : d.value
}

// ---------------------------------------------------------------
// 文档同步
// ---------------------------------------------------------------

function sendDidOpen(uri: string, rec: DocRecord): void {
  window.api.clangdNotify('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: rec.languageId,
      version: rec.version,
      text: rec.model.getValue()
    }
  })
}

function flushDidChange(uri: string): void {
  const rec = docs.get(uri)
  if (!rec || rec.model.isDisposed()) return
  rec.version++
  window.api.clangdNotify('textDocument/didChange', {
    textDocument: { uri, version: rec.version },
    // 全文同步(initialize 声明 textDocumentSync full):桥两端最简单且不会漂移
    contentChanges: [{ text: rec.model.getValue() }]
  })
}

/**
 * EditorHost 建 model 时调用:C/C++ 文件接入 clangd。
 * 非 C/C++ 扩展名直接忽略;桥初始化与 clangd 启动都是惰性且幂等的。
 */
export function attachClangdModel(path: string, model: monaco.editor.ITextModel): void {
  const languageId = clangdLanguageIdForPath(path)
  if (!languageId) return
  initClangdBridge()
  // 语言提供方按语言 id 生效:model 若仍是 plaintext(languageForPath 未覆盖 C)则纠正
  if (model.getLanguageId() !== languageId) monaco.editor.setModelLanguage(model, languageId)

  void (async () => {
    let status: Awaited<ReturnType<typeof window.api.clangdStart>>
    try {
      status = await window.api.clangdStart()
    } catch {
      return // 无工作区等边界:静默(clangd:badRoot)
    }
    if (status.state === 'noClangd') {
      oneTimeToast('clangd.notFound', 'warn')
      return
    }
    if (status.state === 'noCompileCommands') {
      oneTimeToast('clangd.needBuild', 'info')
      return
    }
    if (status.state !== 'running') return
    const wasRunning = sessionRunning
    sessionRunning = true
    // 会话从停止/切换工作区中恢复:先把已登记文档全部重新 didOpen(新会话不识旧文档)
    if (!wasRunning) {
      for (const [u, r] of docs) {
        if (!r.model.isDisposed()) sendDidOpen(u, r)
      }
    }
    if (model.isDisposed()) return

    const uri = model.uri.toString()
    if (docs.has(uri)) return // 防御:重复 attach
    const rec: DocRecord = { model, languageId, version: 1, debounce: null }
    docs.set(uri, rec)
    sendDidOpen(uri, rec)

    const contentSub = model.onDidChangeContent(() => {
      if (rec.debounce !== null) window.clearTimeout(rec.debounce)
      rec.debounce = window.setTimeout(() => {
        rec.debounce = null
        flushDidChange(uri)
      }, 250)
    })
    model.onWillDispose(() => {
      contentSub.dispose()
      if (rec.debounce !== null) window.clearTimeout(rec.debounce)
      docs.delete(uri)
      window.api.clangdNotify('textDocument/didClose', { textDocument: { uri } })
    })
  })()
}

// ---------------------------------------------------------------
// 语言提供方(注册一次,'c' + 'cpp')
// ---------------------------------------------------------------

/** 附着中的文档才发起 LSP 请求;去抖中的修改先冲刷,保证服务端文本一致 */
function preflight(model: monaco.editor.ITextModel): string | null {
  const uri = model.uri.toString()
  const rec = docs.get(uri)
  if (!rec || !sessionRunning) return null
  if (rec.debounce !== null) {
    window.clearTimeout(rec.debounce)
    rec.debounce = null
    flushDidChange(uri)
  }
  return uri
}

function registerProviders(): void {
  const languages: Array<'c' | 'cpp'> = ['c', 'cpp']
  for (const lang of languages) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', '>', ':', '/', '"', '<'],
      async provideCompletionItems(model, position) {
        const uri = preflight(model)
        if (!uri) return { suggestions: [] }
        let result: LspCompletionList | LspCompletionItem[] | null
        try {
          result = (await window.api.clangdRequest('textDocument/completion', {
            textDocument: { uri },
            position: toLspPosition(position)
          })) as LspCompletionList | LspCompletionItem[] | null
        } catch {
          return { suggestions: [] }
        }
        const items = Array.isArray(result) ? result : (result?.items ?? [])
        // 无 textEdit 的条目回退到当前单词范围(Monaco 要求显式 range)
        const word = model.getWordUntilPosition(position)
        const fallbackRange: monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn
        }
        const suggestions = items.map((it): monaco.languages.CompletionItem => {
          const doc = docString(it.documentation)
          return {
            label: it.label,
            kind: toMonacoCompletionKind(it.kind),
            detail: it.detail,
            documentation: doc ? { value: doc } : undefined,
            filterText: it.filterText,
            sortText: it.sortText,
            insertText: it.textEdit?.newText ?? it.insertText ?? it.label,
            range: it.textEdit ? toMonacoRange(it.textEdit.range) : fallbackRange
          }
        })
        return {
          suggestions,
          incomplete: !Array.isArray(result) && result?.isIncomplete === true
        }
      }
    })

    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const uri = preflight(model)
        if (!uri) return null
        let hover: LspHover | null
        try {
          hover = (await window.api.clangdRequest('textDocument/hover', {
            textDocument: { uri },
            position: toLspPosition(position)
          })) as LspHover | null
        } catch {
          return null
        }
        if (!hover) return null
        // contents 三种形态:MarkupContent {kind,value} / MarkedString / MarkedString[]
        const parts: Array<{ kind?: string; value: string } | LspMarkedString> = Array.isArray(
          hover.contents
        )
          ? hover.contents
          : [hover.contents]
        const contents = parts
          .map((p): monaco.IMarkdownString | null => {
            if (typeof p === 'string') return { value: p }
            if ('language' in p && typeof p.language === 'string') {
              return { value: '```' + p.language + '\n' + p.value + '\n```' }
            }
            return typeof p.value === 'string' ? { value: p.value } : null
          })
          .filter((p): p is monaco.IMarkdownString => p !== null)
        if (contents.length === 0) return null
        return { contents, range: hover.range ? toMonacoRange(hover.range) : undefined }
      }
    })

    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [','],
      async provideSignatureHelp(model, position) {
        const uri = preflight(model)
        if (!uri) return null
        let help: LspSignatureHelp | null
        try {
          help = (await window.api.clangdRequest('textDocument/signatureHelp', {
            textDocument: { uri },
            position: toLspPosition(position)
          })) as LspSignatureHelp | null
        } catch {
          return null
        }
        if (!help || help.signatures.length === 0) return null
        const value: monaco.languages.SignatureHelp = {
          signatures: help.signatures.map((s) => {
            const doc = docString(s.documentation)
            return {
              label: s.label,
              documentation: doc ? { value: doc } : undefined,
              parameters: (s.parameters ?? []).map((p) => {
                const pdoc = docString(p.documentation)
                return { label: p.label, documentation: pdoc ? { value: pdoc } : undefined }
              })
            }
          }),
          activeSignature: help.activeSignature ?? 0,
          activeParameter: help.activeParameter ?? 0
        }
        return { value, dispose: () => undefined }
      }
    })
  }
}

// ---------------------------------------------------------------
// 服务器事件(诊断 + 状态)
// ---------------------------------------------------------------

function wireServerEvents(): void {
  window.api.onClangdEvent((ev) => {
    if (ev.method !== 'textDocument/publishDiagnostics') return
    const params = ev.params as { uri?: string; diagnostics?: LspDiagnostic[] } | null
    if (!params?.uri) return
    // uri 经 monaco.Uri 归一化后匹配 model(编码差异对齐)
    let model: monaco.editor.ITextModel | null = null
    try {
      model = monaco.editor.getModel(monaco.Uri.parse(params.uri))
    } catch {
      return
    }
    if (!model || model.isDisposed()) return
    const markers = (params.diagnostics ?? []).map((d): monaco.editor.IMarkerData => ({
      severity: toMonacoSeverity(d.severity),
      message: d.message,
      source: d.source ?? 'clangd',
      code: d.code !== undefined ? String(d.code) : undefined,
      ...toMonacoRange(d.range)
    }))
    monaco.editor.setModelMarkers(model, 'clangd', markers)
  })

  window.api.onClangdStatus((status) => {
    if (status.state === 'running') {
      // 崩溃自动重启成功:重发全部已打开文档(版本续用,全文同步无漂移)
      sessionRunning = true
      for (const [uri, rec] of docs) {
        if (!rec.model.isDisposed()) sendDidOpen(uri, rec)
      }
      return
    }
    sessionRunning = false
    if (status.state === 'failed') oneTimeToast('clangd.failed', 'warn')
    // stopped / failed:清掉全部 clangd 标记(避免陈旧诊断残留)
    for (const rec of docs.values()) {
      if (!rec.model.isDisposed()) monaco.editor.setModelMarkers(rec.model, 'clangd', [])
    }
  })
}

/** 幂等初始化:语言提供方注册 + 服务器事件订阅(首个 C/C++ 文件打开时触发) */
export function initClangdBridge(): void {
  if (bridgeInited) return
  bridgeInited = true
  registerProviders()
  wireServerEvents()
}
