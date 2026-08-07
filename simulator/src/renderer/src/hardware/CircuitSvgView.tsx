/**
 * 电路 SVG 视图(PCB / 原理图共用)
 *
 * 用纯离线库 circuit-to-svg 把 Circuit JSON 同步转成 SVG 字符串再注入容器,
 * 替代已移除的 @tscircuit/pcb-viewer / @tscircuit/schematic-viewer —— 二者
 * dist 运行时引 @tscircuit/core 的 react-reconciler@0.32(要 React19 内部结构),
 * React18 下 import 即崩(ReadableStream 'S' TypeError 白屏)。
 *
 * - circuit-to-svg 走动态 import():留在懒加载 chunk,不拖慢外壳启动
 * - SVG 根节点后处理:去固定 width/height(库固定输出 800×600)→ 100% 自适应容器
 * - 交互:滚轮缩放(0.25x..8x,围绕光标)+ 拖动平移(CSS transform),双击复位
 * - 库输出本地可信,原样注入(不做裁剪)
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuLoaderCircle } from 'react-icons/lu'
import type { AnyCircuitElement } from 'circuit-json'

const MIN_SCALE = 0.25
const MAX_SCALE = 8

interface ViewTransform {
  scale: number
  tx: number
  ty: number
}

const IDENTITY: ViewTransform = { scale: 1, tx: 0, ty: 0 }

/**
 * SVG 根节点自适应容器:库输出固定 width=800 height=600,去掉后改为
 * 100%×100% + preserveAspectRatio 等比居中;无 viewBox 时用原固定宽高补齐
 * (否则去掉宽高后失去缩放基准)。解析失败时原样返回兜底。
 */
function fitSvgToContainer(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg' || doc.querySelector('parsererror')) return svgText
  if (!root.hasAttribute('viewBox')) {
    const w = Number.parseFloat(root.getAttribute('width') ?? '')
    const h = Number.parseFloat(root.getAttribute('height') ?? '')
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      root.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }
  }
  root.setAttribute('width', '100%')
  root.setAttribute('height', '100%')
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  return new XMLSerializer().serializeToString(root)
}

export function CircuitSvgView(props: {
  circuitJson: AnyCircuitElement[]
  kind: 'pcb' | 'schematic'
  evalSeq: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewTransform>(IDENTITY)
  /** 拖动起点(指针按下时的坐标与平移量);null = 未在拖动 */
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  // 转换:conversion 本身同步,但动态 import 异步 → effect 内做,cancelled 防过期写入
  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    setView(IDENTITY)
    void (async () => {
      try {
        const lib = await import('circuit-to-svg')
        if (cancelled) return
        const raw =
          props.kind === 'pcb'
            ? lib.convertCircuitJsonToPcbSvg(props.circuitJson)
            : lib.convertCircuitJsonToSchematicSvg(props.circuitJson)
        if (!cancelled) setSvg(fitSvgToContainer(raw))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.circuitJson, props.kind, props.evalSeq])

  // 滚轮缩放:原生监听(passive:false 才能 preventDefault 阻止页面滚动)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setView((v) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * Math.exp(-e.deltaY * 0.0015)))
        if (scale === v.scale) return v
        // 围绕光标缩放:光标处内容点在缩放前后保持屏幕位置不变
        const k = scale / v.scale
        return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }))
  }

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  if (error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="w-full max-w-[560px] rounded border border-red-500/40 bg-red-500/10 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-red-400">
            <LuCircleAlert className="shrink-0" />
            <span>{t('hw.view.error')}</span>
          </div>
          <div className="selectable break-all font-mono text-xs leading-5 text-red-300">{error}</div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => setView(IDENTITY)}
    >
      {svg === null ? (
        <div className="flex h-full items-center justify-center gap-2 text-[12px] text-ink-500">
          <LuLoaderCircle className="animate-spin text-accent" />
          <span>{t('hw.view.loading')}</span>
        </div>
      ) : (
        <div
          className="h-full w-full [&>svg]:block"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transformOrigin: '0 0'
          }}
          // circuit-to-svg 为本地可信库输出,原样注入
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {svg !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[11px] text-ink-500">
          {t('hw.view.zoomHint')}
        </div>
      )}
    </div>
  )
}
