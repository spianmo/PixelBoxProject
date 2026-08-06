/**
 * Markdown 预览面板(分屏/预览模式的右侧渲染区)
 *
 * - markdown-it 渲染 + DOMPurify 消毒(样式见 main.css 的 .md-preview,暗色 GitHub 风)
 * - 相对路径图片:经 fs IPC 读二进制 → blob URL(限工作区内,越界由 main 拒绝)
 * - 外链 a:拦截默认跳转,交给 shell.openExternal(仅 http(s)/mailto)
 * - 滚动同步:编辑器滚动比例单向驱动预览滚动
 * - mermaid 代码块暂不渲染(保持代码块展示,不引重依赖)
 */
import { useEffect, useRef } from 'react'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { monaco } from './monacoSetup'
import type { EditorHostHandle } from './EditorHost'

const md = new MarkdownIt({
  html: true, // 原始 HTML 交由 DOMPurify 消毒
  linkify: true
})

/** 父目录(兼容 / 与 \) */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : p
}

/** 相对路径拼接(处理 ./ 与 ../,分隔符跟随所在平台的绝对路径) */
function joinRel(dir: string, rel: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  const parts = dir.split(/[/\\]/)
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join(sep)
}

/** 图片扩展名 → MIME(blob URL 用) */
function mimeFor(name: string): string {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.') + 1)
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

interface Props {
  /** 当前预览的 md 文件绝对路径 */
  path: string
  /** EditorHost 句柄(取 monaco 实例做滚动同步) */
  editorRef: React.RefObject<EditorHostHandle>
}

export function MarkdownPreview({ path, editorRef }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  // 内容渲染:model 变更防抖 250ms 重渲(model 由 EditorHost 管理)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let alive = true
    let debounce = 0
    let contentSub: monaco.IDisposable | null = null
    let createSub: monaco.IDisposable | null = null
    const blobUrls: string[] = []
    const uri = monaco.Uri.file(path)

    const render = (text: string): void => {
      if (!alive) return
      // 上一轮的 blob URL 全部释放
      for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u)
      el.innerHTML = DOMPurify.sanitize(md.render(text))
      // 相对路径图片 → fs IPC 二进制 → blob URL
      for (const img of Array.from(el.querySelectorAll('img'))) {
        const src = img.getAttribute('src') ?? ''
        if (src === '' || /^(https?:|data:|blob:)/i.test(src)) continue
        const abs = joinRel(dirOf(path), decodeURIComponent(src))
        window.api
          .readFileBinary(abs)
          .then((buf) => {
            if (!alive) return
            const url = URL.createObjectURL(new Blob([buf], { type: mimeFor(abs) }))
            blobUrls.push(url)
            img.src = url
          })
          .catch(() => {
            // 读不到(不存在/越界):保留 alt 文本
            img.removeAttribute('src')
          })
      }
    }

    const attach = (model: monaco.editor.ITextModel): void => {
      render(model.getValue())
      contentSub = model.onDidChangeContent(() => {
        window.clearTimeout(debounce)
        debounce = window.setTimeout(() => {
          if (!model.isDisposed()) render(model.getValue())
        }, 250)
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
      for (const u of blobUrls) URL.revokeObjectURL(u)
    }
  }, [path])

  // 滚动同步:编辑侧滚动比例 → 预览侧(单向)
  useEffect(() => {
    const editor = editorRef.current?.getEditor()
    const el = containerRef.current
    if (!editor || !el) return
    const sub = editor.onDidScrollChange(() => {
      const max = editor.getScrollHeight() - editor.getLayoutInfo().height
      const ratio = max > 0 ? editor.getScrollTop() / max : 0
      el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
    })
    return () => sub.dispose()
  }, [editorRef, path])

  // 链接点击:外链交系统浏览器;#锚点滚动到目标;其余一律拦截
  const onClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      void window.api.openExternal(href)
    } else if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1))
      containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView()
    }
  }

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      className="md-preview selectable h-full min-w-0 flex-1 overflow-y-auto bg-ink-900 px-6 py-4"
    />
  )
}
