import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuBox, LuRefreshCw, LuZoomIn, LuZoomOut } from 'react-icons/lu'
import { loadModel, ModelPreviewError, type LoadedModel, type ModelErrorCode } from './modelLoader'
import { ModelViewer } from './modelViewer'
import { subscribeTheme } from '../theme'

type PreviewState = { status: 'loading' } | { status: 'error'; code: ModelErrorCode } | {
  status: 'ready'; size: string; triangles: number; vertices: number
}

function dimension(value: number): string {
  return value !== 0 && (value < 0.001 || value >= 1e7) ? value.toExponential(2) : String(Number(value.toFixed(3)))
}

export function ModelPreview({ path }: { path: string }): React.JSX.Element {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<ModelViewer | null>(null)
  const [revision, setRevision] = useState(0)
  const [wireframe, setWireframe] = useState(false)
  const [state, setState] = useState<PreviewState>({ status: 'loading' })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const controller = new AbortController()
    const dependencies = new Set([path])
    let model: LoadedModel | null = null
    let viewer: ModelViewer | null = null
    let refreshTimer = 0
    setState({ status: 'loading' })
    setWireframe(false)
    // 整个读取/贴图解码流程限时;关闭页签和超时都使旧结果失效。
    const timeout = window.setTimeout(() => {
      controller.abort()
      setState({ status: 'error', code: 'timeout' })
    }, 20_000)
    const unsubscribe = window.api.onFsEvent((event) => {
      if (!dependencies.has(event.path) || !['change', 'add', 'unlink'].includes(event.type)) return
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => setRevision((value) => value + 1), 150)
    })
    const unsubscribeTheme = subscribeTheme(() => viewer?.render())
    const contextLost = (event: Event): void => {
      event.preventDefault()
      if (!controller.signal.aborted) setState({ status: 'error', code: 'graphicsFailed' })
    }
    canvas.addEventListener('webglcontextlost', contextLost)

    void loadModel(path, controller.signal, (file) => dependencies.add(file))
      .then((loaded) => {
        model = loaded
        if (controller.signal.aborted) { loaded.dispose(); return }
        try { viewer = new ModelViewer(canvas, loaded, path) } catch { throw new ModelPreviewError('graphicsFailed') }
        viewerRef.current = viewer
        setState({
          status: 'ready', size: [...loaded.size].map(dimension).join(' × '),
          triangles: loaded.triangles, vertices: loaded.vertices
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        model?.dispose()
        setState({ status: 'error', code: error instanceof ModelPreviewError ? error.code : 'invalid' })
      })
      .finally(() => window.clearTimeout(timeout))

    return () => {
      controller.abort()
      window.clearTimeout(timeout)
      window.clearTimeout(refreshTimer)
      unsubscribe()
      unsubscribeTheme()
      canvas.removeEventListener('webglcontextlost', contextLost)
      viewerRef.current = null
      if (viewer) viewer.dispose()
      else model?.dispose()
    }
  }, [path, revision])

  const buttonClass = 'flex h-7 items-center justify-center gap-1 rounded px-2 text-xs text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:pointer-events-none disabled:opacity-40'
  const ready = state.status === 'ready'
  return (
    <section className="model-preview flex h-full min-w-0 flex-1 flex-col bg-ink-900" aria-label={t('modelPreview.title')} data-path={path} data-status={state.status}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-ink-700 bg-ink-850 px-2 py-1">
        <LuBox className="mx-1 shrink-0 text-jb-muted" />
        <button className={buttonClass} aria-label={t('imagePreview.zoomOut')} title={t('imagePreview.zoomOut')} disabled={!ready} onClick={() => viewerRef.current?.zoom(1.25)}><LuZoomOut /></button>
        <button className={buttonClass} aria-label={t('imagePreview.zoomIn')} title={t('imagePreview.zoomIn')} disabled={!ready} onClick={() => viewerRef.current?.zoom(1 / 1.25)}><LuZoomIn /></button>
        <button className={buttonClass} disabled={!ready} onClick={() => viewerRef.current?.fit()}>{t('modelPreview.reset')}</button>
        <button className={`${buttonClass} ${wireframe ? 'bg-jb-selection text-jb-text' : ''}`} aria-pressed={wireframe} disabled={!ready} onClick={() => {
          viewerRef.current?.setWireframe(!wireframe)
          setWireframe(!wireframe)
        }}>{t('modelPreview.wireframe')}</button>
        <button className={buttonClass} aria-label={t('modelPreview.reload')} title={t('modelPreview.reload')} onClick={() => setRevision((value) => value + 1)}><LuRefreshCw /></button>
        {ready && <span className="ml-auto px-2 text-xs tabular-nums text-jb-muted">{t('modelPreview.counts', { triangles: state.triangles, vertices: state.vertices })}</span>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <canvas key={`${path}:${revision}`} ref={canvasRef} className="h-full w-full touch-none outline-none" aria-label={t('modelPreview.title')} tabIndex={0} />
        {ready ? (
          <span className="pointer-events-none absolute bottom-3 right-3 max-w-[75%] rounded bg-ink-900/80 px-2 py-1 text-right text-xs text-jb-muted">
            {t('modelPreview.size', { size: state.size })}<br />{t('modelPreview.controls')}
          </span>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900 px-6 text-center text-sm text-jb-muted" role={state.status === 'error' ? 'alert' : 'status'}>
            <span>{t(`modelPreview.${state.status === 'error' ? state.code : 'loading'}`)}</span>
            {state.status === 'error' && <button className={buttonClass} onClick={() => setRevision((value) => value + 1)}>{t('imagePreview.retry')}</button>}
          </div>
        )}
      </div>
    </section>
  )
}
