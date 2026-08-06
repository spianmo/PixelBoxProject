/**
 * ScreenView3D —— 模拟器 3D 设备视图(SimPanel 2D/3D 切换的 3D 分支)
 *
 * 帧管线:引擎帧 → 隐藏 canvas(分辨率 = 设备屏幕,不挂 DOM)→ HardwareViewer
 * 的 CanvasTexture 贴到 3D 板卡屏幕面;engine.onFrame 回调做脏标记(仅新帧
 * needsUpdate,勿每 rAF 上传)。触摸:viewer 对屏幕面 raycast 出 UV(0..1),
 * 映射回屏幕像素坐标注入 engine.sendTouch。
 *
 * 单 sink 约定:engine.attachScreen 同一时刻只有一个画布;本组件挂载时接管
 * (attachScreen 会立即重绘 latestFrame,无像素丢失),卸载 cleanup 归还
 * (attachScreen(null) + onFrame=null),随后挂载的 2D ScreenView 自行 attach。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BoardSpec, Hardware3D, ScreenPlacement } from '../../../../shared/ipc-types'
import { HardwareViewer } from '../../hardware/three/HardwareViewer'
import type { SimEngine } from '../engine'
import type { ScreenSize } from './SimPanel'

/** 档案未提供屏幕放置时的兜底:按屏幕像素宽高比居中铺在板面(四周留 4mm 边) */
function defaultPlacement(board: BoardSpec, screen: ScreenSize): ScreenPlacement {
  const margin = 4
  const availW = Math.max(4, board.widthMM - margin * 2)
  const availH = Math.max(4, board.heightMM - margin * 2)
  const aspect = screen.width > 0 && screen.height > 0 ? screen.width / screen.height : 1
  let w = availW
  let h = w / aspect
  if (h > availH) {
    h = availH
    w = h * aspect
  }
  return { x: 0, y: 0, w, h }
}

export function ScreenView3D({
  engine,
  screen,
  hardware,
  explode
}: {
  engine: SimEngine
  screen: ScreenSize
  hardware: Hardware3D
  explode: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<HardwareViewer | null>(null)
  // 爆炸目标经 ref 透传给创建 effect(viewer 重建时恢复当前爆炸态,且不触发重建)
  const explodeRef = useRef(explode)
  explodeRef.current = explode
  // 操作提示浮层(数秒后淡出)
  const [hintVisible, setHintVisible] = useState(true)

  // viewer 生命周期 + 帧管线(engine/hardware/分辨率变化时整体重建)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    // 隐藏 canvas:引擎帧 sink(不挂 DOM,仅作纹理源)
    const hidden = document.createElement('canvas')
    hidden.width = screen.width
    hidden.height = screen.height

    const viewer = new HardwareViewer(canvas, {
      interactive: true,
      background: null,
      onScreenTouch: (type: 'down' | 'move' | 'up', u: number, v: number) =>
        engine.sendTouch(type, Math.round(u * screen.width), Math.round(v * screen.height))
    })
    viewerRef.current = viewer
    viewer.setHardware(hardware)
    viewer.attachScreenCanvas(hidden, hardware.screen ?? defaultPlacement(hardware.board, screen))
    viewer.setExplode(explodeRef.current ? 1 : 0)

    // attachScreen 会立即把 latestFrame 重绘进隐藏 canvas → 先绘后标脏
    engine.attachScreen(hidden)
    viewer.markScreenDirty()
    engine.onFrame = () => viewer.markScreenDirty()

    const ro = new ResizeObserver(() => viewer.resize())
    if (containerRef.current) ro.observe(containerRef.current)
    viewer.resize()

    return () => {
      ro.disconnect()
      engine.onFrame = null
      engine.attachScreen(null)
      viewerRef.current = null
      viewer.dispose()
    }
    // 依赖取 width/height 标量(与 ScreenView 约定一致,screen 对象经 SimHost useMemo 稳定)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, hardware, screen.width, screen.height])

  // 爆炸视图切换(damp 动画由 viewer 内部驱动)
  useEffect(() => {
    viewerRef.current?.setExplode(explode ? 1 : 0)
  }, [explode])

  // 提示浮层 4s 后淡出
  useEffect(() => {
    const timer = window.setTimeout(() => setHintVisible(false), 4000)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-ink-900">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* 操作提示(拖动旋转/滚轮缩放),淡出后不挡交互 */}
      <span
        className={`pointer-events-none absolute bottom-1.5 right-2 rounded bg-ink-850/90 px-1.5 py-0.5 text-[10px] text-jb-muted transition-opacity duration-700 ${
          hintVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {t('sim.view3dHint')}
      </span>
    </div>
  )
}
