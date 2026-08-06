/**
 * 代码结构视图(对齐 JetBrains Structure 工具窗,左侧面板下分栏)
 *
 * 数据源(按活动编辑器文件类型):
 * - ts/js:monaco TypeScript worker 的 getNavigationTree() 构建层级
 *   (函数/类/方法/常量…图标区分,层级缩进 + 可折叠)
 * - markdown:标题大纲(#/##/### …,跳过 fenced 代码块)
 * - json:顶层键(值类型图标区分)
 * - 其他:「此文件类型暂无结构」
 *
 * 交互:编辑防抖 500ms 刷新;点击节点 → 编辑器 revealRangeInCenter + 光标定位;
 *       光标所在符号高亮跟随(按光标行命中文档顺序上最近的节点)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuChevronDown, LuChevronRight } from 'react-icons/lu'
import {
  VscSymbolArray,
  VscSymbolBoolean,
  VscSymbolClass,
  VscSymbolConstant,
  VscSymbolEnum,
  VscSymbolEnumMember,
  VscSymbolField,
  VscSymbolInterface,
  VscSymbolKey,
  VscSymbolMethod,
  VscSymbolMisc,
  VscSymbolNamespace,
  VscSymbolNumeric,
  VscSymbolProperty,
  VscSymbolString,
  VscSymbolStructure,
  VscSymbolVariable
} from 'react-icons/vsc'
import { monaco, languageForPath } from './monacoSetup'

/** 结构树节点(语言无关的统一形态) */
export interface StructureNode {
  /** 稳定 id(索引链,折叠状态/高亮定位用) */
  id: string
  label: string
  /** 次级说明(JSON 值类型等) */
  detail?: string
  /** 图标类别(ts NavigationTree kind / 'h1'-'h6' / json 值类型) */
  kind: string
  /** 1-based 起始行列(点击定位目标) */
  line: number
  column: number
  children: StructureNode[]
}

/** monaco TS worker getNavigationTree 返回的条目(官方 d.ts 为 any,这里收窄) */
interface NavTreeItem {
  text: string
  kind: string
  spans: Array<{ start: number; length: number }>
  nameSpan?: { start: number; length: number }
  childItems?: NavTreeItem[]
}

/** TS worker 上实际存在的方法(monaco.d.ts 定义为 Promise<any>) */
interface NavTreeWorker {
  getNavigationTree(fileName: string): Promise<NavTreeItem | undefined>
}

// ---------------------------------------------------------------
// 各语言的结构提取
// ---------------------------------------------------------------

/** ts/js:NavigationTree → StructureNode(跳过 <global> 根,按 span 转行列) */
function convertNavTree(model: monaco.editor.ITextModel, items: NavTreeItem[], prefix: string): StructureNode[] {
  const out: StructureNode[] = []
  items.forEach((it, i) => {
    const span = it.nameSpan ?? it.spans[0]
    if (!span) return
    const pos = model.getPositionAt(span.start)
    out.push({
      id: `${prefix}${i}`,
      label: it.text,
      kind: it.kind,
      line: pos.lineNumber,
      column: pos.column,
      children: it.childItems ? convertNavTree(model, it.childItems, `${prefix}${i}.`) : []
    })
  })
  return out
}

async function buildTsTree(model: monaco.editor.ITextModel, language: string): Promise<StructureNode[]> {
  const getWorker =
    language === 'typescript'
      ? await monaco.languages.typescript.getTypeScriptWorker()
      : await monaco.languages.typescript.getJavaScriptWorker()
  const client = (await getWorker(model.uri)) as unknown as NavTreeWorker
  if (model.isDisposed()) return []
  const tree = await client.getNavigationTree(model.uri.toString())
  if (!tree || model.isDisposed()) return []
  // 根节点是 <global>/模块本身,直接取其子项
  return convertNavTree(model, tree.childItems ?? [], '')
}

/** markdown:标题大纲(跳过 ``` / ~~~ fenced 代码块),按层级堆栈组装 */
function buildMarkdownTree(text: string): StructureNode[] {
  const roots: StructureNode[] = []
  // 栈:比新标题层级低的父节点链
  const stack: Array<{ level: number; node: StructureNode }> = []
  let inFence = false
  let seq = 0
  text.split('\n').forEach((raw, idx) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw)
    if (!m) return
    const level = m[1].length
    const node: StructureNode = {
      id: `md-${seq++}`,
      label: m[2],
      kind: `h${level}`,
      line: idx + 1,
      column: 1,
      children: []
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ level, node })
  })
  return roots
}

/** JSON 值 → 图标类别 */
function jsonKindOf(v: unknown): string {
  if (Array.isArray(v)) return 'json-array'
  if (v === null) return 'json-null'
  switch (typeof v) {
    case 'string':
      return 'json-string'
    case 'number':
      return 'json-number'
    case 'boolean':
      return 'json-boolean'
    case 'object':
      return 'json-object'
    default:
      return 'json-misc'
  }
}

/** JSON 值 → 次级说明 */
function jsonDetailOf(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`
  if (v === null) return 'null'
  if (typeof v === 'object') return '{…}'
  if (typeof v === 'string') return v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`
  return String(v)
}

/** json:顶层键(逐行查 "key": 定位;解析失败返回空) */
function buildJsonTree(text: string): StructureNode[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const lines = text.split('\n')
  const out: StructureNode[] = []
  let searchFrom = 0
  Object.entries(parsed as Record<string, unknown>).forEach(([key, value], i) => {
    // 从上一命中处向下找 "key" :(足够覆盖格式化 JSON;找不到退化为第 1 行)
    const needle = `${JSON.stringify(key)}`
    let line = 1
    for (let li = searchFrom; li < lines.length; li++) {
      const col = lines[li].indexOf(needle)
      if (col >= 0 && /^\s*:/.test(lines[li].slice(col + needle.length))) {
        line = li + 1
        searchFrom = li
        break
      }
    }
    out.push({
      id: `json-${i}`,
      label: key,
      detail: jsonDetailOf(value),
      kind: jsonKindOf(value),
      line,
      column: 1,
      children: []
    })
  })
  return out
}

// ---------------------------------------------------------------
// 图标映射(kind → 图标 + JetBrains 语义色)
// ---------------------------------------------------------------

function iconFor(kind: string): React.JSX.Element {
  switch (kind) {
    case 'class':
      return <VscSymbolClass className="text-orange-400/90" />
    case 'interface':
      return <VscSymbolInterface className="text-green-400/90" />
    case 'enum':
      return <VscSymbolEnum className="text-orange-300/90" />
    case 'enum member':
      return <VscSymbolEnumMember className="text-cyan-400/80" />
    case 'function':
    case 'local function':
    case 'method':
    case 'constructor':
      return <VscSymbolMethod className="text-accent" />
    case 'const':
      return <VscSymbolConstant className="text-purple-400/90" />
    case 'let':
    case 'var':
      return <VscSymbolVariable className="text-purple-400/80" />
    case 'property':
    case 'getter':
    case 'setter':
      return <VscSymbolProperty className="text-cyan-400/80" />
    case 'type':
    case 'alias':
      return <VscSymbolStructure className="text-green-300/80" />
    case 'module':
    case 'namespace':
      return <VscSymbolNamespace className="text-jb-muted" />
    case 'json-string':
      return <VscSymbolString className="text-green-400/80" />
    case 'json-number':
      return <VscSymbolNumeric className="text-cyan-400/80" />
    case 'json-boolean':
      return <VscSymbolBoolean className="text-orange-300/80" />
    case 'json-array':
      return <VscSymbolArray className="text-purple-400/80" />
    case 'json-object':
      return <VscSymbolStructure className="text-orange-400/80" />
    case 'json-null':
      return <VscSymbolMisc className="text-jb-muted" />
    case 'json-misc':
      return <VscSymbolKey className="text-jb-muted" />
    default:
      if (/^h[1-6]$/.test(kind)) return <VscSymbolField className="text-accent" />
      return <VscSymbolField className="text-jb-muted" />
  }
}

// ---------------------------------------------------------------
// 组件
// ---------------------------------------------------------------

/** 文档顺序展平(光标跟随:取起始行 <= 光标行的最后一个节点) */
function flatten(nodes: StructureNode[], out: StructureNode[] = []): StructureNode[] {
  for (const n of nodes) {
    out.push(n)
    flatten(n.children, out)
  }
  return out
}

interface Props {
  /** 活动编辑器文件(null = 无打开文件) */
  path: string | null
  /** 编辑器光标行(高亮跟随) */
  cursorLine: number | null
  /** 点击节点 → 上层调用 EditorHost.revealAt */
  onNavigate: (line: number, column: number) => void
}

export function StructureView({ path, cursorLine, onNavigate }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [nodes, setNodes] = useState<StructureNode[]>([])
  /** 该文件类型是否支持结构(false 显示「暂无结构」) */
  const [supported, setSupported] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // 活动文件变化 / 内容编辑(防抖 500ms)→ 重建结构树
  useEffect(() => {
    setNodes([])
    setCollapsed(new Set())
    if (!path) {
      setSupported(false)
      return
    }
    const language = languageForPath(path)
    const isTs = language === 'typescript' || language === 'javascript'
    const isMd = language === 'markdown'
    const isJson = language === 'json'
    setSupported(isTs || isMd || isJson)
    if (!isTs && !isMd && !isJson) return

    let alive = true
    let debounce = 0
    let contentSub: monaco.IDisposable | null = null
    let createSub: monaco.IDisposable | null = null
    const uri = monaco.Uri.file(path)

    const rebuild = async (model: monaco.editor.ITextModel): Promise<void> => {
      try {
        let next: StructureNode[] = []
        if (isTs) next = await buildTsTree(model, language)
        else if (isMd) next = buildMarkdownTree(model.getValue())
        else next = buildJsonTree(model.getValue())
        if (alive) setNodes(next)
      } catch {
        // worker 未就绪/模型销毁等瞬态失败:保留旧树,等下次防抖刷新
      }
    }

    const attach = (model: monaco.editor.ITextModel): void => {
      void rebuild(model)
      contentSub = model.onDidChangeContent(() => {
        window.clearTimeout(debounce)
        debounce = window.setTimeout(() => void rebuild(model), 500)
      })
    }

    // model 可能尚未创建(openFile 异步读盘):onDidCreateModel 兜底
    const existing = monaco.editor.getModel(uri)
    if (existing) attach(existing)
    else {
      createSub = monaco.editor.onDidCreateModel((m) => {
        if (m.uri.toString() === uri.toString()) {
          createSub?.dispose()
          createSub = null
          attach(m)
        }
      })
    }

    return () => {
      alive = false
      window.clearTimeout(debounce)
      contentSub?.dispose()
      createSub?.dispose()
    }
  }, [path])

  // 光标跟随:文档顺序上「起始行 <= 光标行」的最近节点
  const flat = useMemo(() => flatten(nodes), [nodes])
  const activeId = useMemo(() => {
    if (cursorLine === null) return null
    let hit: StructureNode | null = null
    for (const n of flat) {
      if (n.line <= cursorLine) hit = n
      else break
    }
    return hit?.id ?? null
  }, [flat, cursorLine])

  // 高亮节点滚入可视区
  useEffect(() => {
    if (!activeId) return
    rowRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderNode = (node: StructureNode, depth: number): React.JSX.Element => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsed.has(node.id)
    const active = node.id === activeId
    return (
      <div key={node.id}>
        <div
          ref={(el) => {
            if (el) rowRefs.current.set(node.id, el)
            else rowRefs.current.delete(node.id)
          }}
          title={`${node.label} :${node.line}`}
          onClick={() => onNavigate(node.line, node.column)}
          className={`flex h-[22px] cursor-pointer items-center gap-1 pr-2 text-[13px] ${
            active ? 'bg-jb-selection text-jb-text' : 'text-jb-text hover:bg-ink-800'
          }`}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {/* 折叠箭头(无子节点占位对齐) */}
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center text-[11px] text-jb-muted"
            onClick={(e) => {
              if (!hasChildren) return
              e.stopPropagation()
              toggle(node.id)
            }}
          >
            {hasChildren ? (isCollapsed ? <LuChevronRight /> : <LuChevronDown />) : null}
          </span>
          <span className="shrink-0 text-[14px]">{iconFor(node.kind)}</span>
          <span className="min-w-0 truncate">{node.label}</span>
          {node.detail && <span className="ml-1 shrink-0 text-[11px] text-ink-500">{node.detail}</span>}
        </div>
        {hasChildren && !isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  if (!path) {
    return <div className="px-3 py-4 text-center text-xs text-ink-500">{t('structure.noFile')}</div>
  }
  if (!supported) {
    return <div className="px-3 py-4 text-center text-xs text-ink-500">{t('structure.notSupported')}</div>
  }
  if (nodes.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-ink-500">{t('structure.empty')}</div>
  }
  return <div className="h-full overflow-y-auto py-1">{nodes.map((n) => renderNode(n, 0))}</div>
}
