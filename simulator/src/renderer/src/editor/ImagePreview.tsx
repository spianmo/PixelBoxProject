/** 图片只经二进制 IPC 读取,使用 img 加载 Blob(SVG 同样处于不可执行脚本的图片上下文)。 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuImage, LuRefreshCw, LuZoomIn, LuZoomOut } from 'react-icons/lu'
import { imageMimeForPath } from './imageFile'

type ImageState =
  | { status: 'loading' }
  | { status: 'error'; reason: 'readFailed' | 'decodeFailed' }
  | { status: 'ready'; url: string; width: number; height: number; bytes: number }

const MIN_ZOOM = 0.05
const MAX_ZOOM = 16

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function ImagePreview({ path }: { path: string }): React.JSX.Element {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ImageState>({ status: 'loading' })
  const [revision, setRevision] = useState(0)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const name = path.split(/[/\\]/).pop() ?? path

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setZoom('fit')
  }, [path])

  // 外部覆盖、删除和重新创建均重读;未激活页签再次打开时也会读取最新磁盘内容。
  useEffect(() => {
    return window.api.onFsEvent((ev) => {
      if (ev.path === path && (ev.type === 'change' || ev.type === 'add' || ev.type === 'unlink')) {
        setRevision((value) => value + 1)
      }
    })
  }, [path])

  useEffect(() => {
    let alive = true
    let url: string | null = null
    let decoder: HTMLImageElement | null = null
    setState({ status: 'loading' })
    void window.api.readFileBinary(path)
      .then((buffer) => {
        // 切页签/刷新后的旧请求不得更新新预览,也不再为旧结果分配 Blob URL。
        if (!alive) return
        url = URL.createObjectURL(new Blob([buffer], { type: imageMimeForPath(path) ?? '' }))
        decoder = new Image()
        decoder.onload = () => {
          if (!alive || !decoder || !url) return
          setState({
            status: 'ready',
            url,
            width: decoder.naturalWidth,
            height: decoder.naturalHeight,
            bytes: buffer.byteLength
          })
        }
        decoder.onerror = () => {
          if (alive) setState({ status: 'error', reason: 'decodeFailed' })
        }
        decoder.src = url
      })
      .catch(() => {
        if (alive) setState({ status: 'error', reason: 'readFailed' })
      })
    return () => {
      alive = false
      if (decoder) {
        decoder.onload = null
        decoder.onerror = null
        decoder.src = ''
      }
      if (url) URL.revokeObjectURL(url)
    }
  }, [path, revision])

  // 默认只缩小大图,小图保持原始尺寸;分屏/拖动面板时按实际视口重新计算。
  const fitZoom = state.status === 'ready'
    ? Math.min(
        1,
        Math.max(1, viewport.width - 48) / state.width,
        Math.max(1, viewport.height - 48) / state.height
      )
    : 1
  const scale = zoom === 'fit' ? fitZoom : zoom
  const changeZoom = (factor: number): void => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * factor)))
  }
  const buttonClass =
    'flex h-7 items-center justify-center gap-1 rounded px-2 text-xs text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:opacity-40 disabled:pointer-events-none'

  return (
    <section
      className="image-preview flex h-full min-w-0 flex-1 flex-col bg-ink-900"
      aria-label={t('imagePreview.title')}
      data-path={path}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-ink-700 bg-ink-850 px-2 py-1">
        <LuImage className="mx-1 shrink-0 text-jb-muted" />
        <button
          className={buttonClass}
          title={t('imagePreview.zoomOut')}
          aria-label={t('imagePreview.zoomOut')}
          disabled={state.status !== 'ready' || scale <= MIN_ZOOM}
          onClick={() => changeZoom(1 / 1.25)}
        >
          <LuZoomOut />
        </button>
        <span className="min-w-[44px] text-center text-xs tabular-nums text-jb-muted">
          {state.status === 'ready' ? `${Math.round(scale * 100)}%` : '—'}
        </span>
        <button
          className={buttonClass}
          title={t('imagePreview.zoomIn')}
          aria-label={t('imagePreview.zoomIn')}
          disabled={state.status !== 'ready' || scale >= MAX_ZOOM}
          onClick={() => changeZoom(1.25)}
        >
          <LuZoomIn />
        </button>
        <button
          className={buttonClass}
          aria-pressed={zoom === 'fit'}
          disabled={state.status !== 'ready'}
          onClick={() => setZoom('fit')}
        >
          {t('imagePreview.fit')}
        </button>
        <button
          className={buttonClass}
          aria-pressed={zoom === 1}
          disabled={state.status !== 'ready'}
          onClick={() => setZoom(1)}
          title={t('imagePreview.actualSize')}
        >
          100%
        </button>
        <button
          className={buttonClass}
          title={t('imagePreview.reload')}
          aria-label={t('imagePreview.reload')}
          onClick={() => setRevision((value) => value + 1)}
        >
          <LuRefreshCw />
        </button>
        {state.status === 'ready' && (
          <span className="ml-auto whitespace-nowrap px-2 text-xs tabular-nums text-jb-muted">
            {state.width} × {state.height} px · {formatSize(state.bytes)}
          </span>
        )}
      </div>
      <div ref={viewportRef} className="image-preview-viewport min-h-0 flex-1 overflow-auto" tabIndex={0}>
        {state.status === 'ready' ? (
          <div className="flex min-h-full min-w-full w-max p-6">
            <img
              src={state.url}
              alt={name}
              draggable={false}
              className="m-auto block max-w-none shrink-0"
              style={{ width: state.width * scale, height: state.height * scale }}
            />
          </div>
        ) : (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-jb-muted"
            role={state.status === 'error' ? 'alert' : 'status'}
          >
            <span>{t(`imagePreview.${state.status === 'error' ? state.reason : 'loading'}`)}</span>
            {state.status === 'error' && (
              <button className={buttonClass} onClick={() => setRevision((value) => value + 1)}>
                {t('imagePreview.retry')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
