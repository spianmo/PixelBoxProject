/**
 * 虚拟设备面板(「运行的设备」工具窗内容,对齐 AS Running Devices)
 *
 * - 左缘竖排小工具条:电源(停止)/ 重载 / 截图(PNG → ~/Downloads)/ 旋转 / 音量开关 /
 *   缩放适应 / 100%;分隔线下为虚拟外设分组图标(电源/按键/IMU/GPS/LED/摄像头),
 *   点击在右侧弹出 JetBrains 气泡 popover 承载原分组表单(同时只开一个,点外部/Esc 关闭,
 *   有活动状态的组图标右上角显示小圆点)
 * - 画布区:设备屏幕居中(尺寸=设备档案分辨率,经 screen props 传入,不再硬编码),
 *   整数倍缩放优先,右下角缩放百分比小标签(如 147%);外设收进 popover 后画布获得
 *   全部纵向空间(缩放适应经 ResizeObserver 自动复算)
 *   鼠标事件映射为触摸(down/move/up),亮度→CSS filter,熄屏→黑色遮罩,旋转→CSS transform
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { VscCircleFilled, VscMic, VscComment } from 'react-icons/vsc'
import {
  LuAxis3D,
  LuBatteryMedium,
  LuBox,
  LuCamera,
  LuExpand,
  LuKeyboard,
  LuLightbulb,
  LuMapPin,
  LuMaximize,
  LuMonitor,
  LuPower,
  LuRefreshCw,
  LuRotateCw,
  LuVolume2,
  LuVolumeX,
  LuWebcam
} from 'react-icons/lu'
import type { SimEngine, EngineUiState } from '../engine'
import type { PeriphSnapshot } from '../protocol'
import { setSessionViewMode, useSimSessions } from '../sessions'
import { ScreenView3D } from './ScreenView3D'
import { showToast } from '../../components/toast'

/** 设备屏幕分辨率(设备档案,阶段 2 由设备管理器提供) */
export interface ScreenSize {
  width: number
  height: number
}

/** 缩放模式:适应窗口(整数倍优先)或固定 100% */
type ZoomMode = 'fit' | 'one'

/** 屏幕视图模式(档案带 hardware3d 时可切 3D;状态存 SimSession) */
type SimViewMode = '2d' | '3d'

/** 外设分组(左缘工具条 popover) */
type PeriphGroup = 'power' | 'buttons' | 'imu' | 'gps' | 'led' | 'camera'

function useUiState(engine: SimEngine): EngineUiState {
  return useSyncExternalStore(engine.uiStore.subscribe, engine.uiStore.get)
}

function usePeriph(engine: SimEngine): PeriphSnapshot {
  return useSyncExternalStore(engine.periphStore.subscribe, engine.periphStore.get)
}

// ---------------------------------------------------------------
// 表单控件(popover 内容,11-12px 紧凑密度)
// ---------------------------------------------------------------

function Slider(props: {
  label: string
  min: number
  max: number
  step?: number
  value: number
  suffix?: string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="block text-[11px] text-jb-muted">
      <div className="mb-0.5 flex justify-between">
        <span>{props.label}</span>
        <span className="font-mono text-jb-text">
          {props.value}
          {props.suffix ?? ''}
        </span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  )
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between text-[11px] text-jb-muted">
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="h-3.5 w-3.5"
      />
    </label>
  )
}

// ---------------------------------------------------------------
// JetBrains 气泡 popover(锚定左缘工具条按钮,右侧弹出,小箭头指向按钮)
// ---------------------------------------------------------------

function PeriphPopover(props: {
  /** 锚点:按钮右缘中点(视口坐标) */
  anchor: { x: number; y: number }
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(props.anchor.y - 18)

  // 首帧测量高度,垂直方向夹取避免越出窗口
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    const ideal = props.anchor.y - 18
    setTop(Math.max(8, Math.min(ideal, window.innerHeight - h - 8)))
  }, [props.anchor])

  // 箭头相对 popover 顶部的偏移(始终指向按钮中心)
  const arrowY = Math.max(8, Math.min(props.anchor.y - top - 5, 320))

  return (
    <div
      ref={ref}
      className="fixed z-[900] w-[248px] rounded-md border border-ink-700 bg-ink-850 shadow-2xl"
      style={{ left: props.anchor.x + 10, top }}
    >
      {/* 小箭头(旋转方块,指向左侧按钮) */}
      <span
        className="absolute -left-[5px] h-2.5 w-2.5 rotate-45 border-b border-l border-ink-700 bg-ink-850"
        style={{ top: arrowY }}
      />
      <div className="border-b border-ink-700 px-3 py-1.5 text-[12px] font-medium text-jb-text">{props.title}</div>
      <div className="space-y-2 px-3 py-2.5">{props.children}</div>
    </div>
  )
}

// ---------------------------------------------------------------
// 左缘工具条
// ---------------------------------------------------------------

function ToolStripButton(props: {
  title: string
  disabled?: boolean
  active?: boolean
  /** 右上角活动状态小圆点(充电中/LED 开等) */
  dot?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`relative flex h-7 w-7 items-center justify-center rounded text-[14px] ${
        props.disabled
          ? 'cursor-not-allowed text-ink-500'
          : props.active
            ? 'bg-jb-selection text-jb-text'
            : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
      }`}
    >
      {props.children}
      {props.dot && <span className="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  )
}

/** 摄像头预览(popover 内;流为空时不渲染) */
function CameraPreview({ stream }: { stream: MediaStream | null }): React.JSX.Element | null {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream
      if (stream) void ref.current.play().catch(() => undefined)
    }
  }, [stream])
  if (!stream) return null
  return <video ref={ref} muted playsInline className="w-full rounded border border-ink-600" />
}

// ---------------------------------------------------------------
// LED 灯带可视化
// ---------------------------------------------------------------

function LedStrip({ colors, brightness }: { colors: number[]; brightness: number }): React.JSX.Element {
  const items = colors.length > 0 ? colors : new Array<number>(8).fill(0)
  return (
    <div className="flex gap-1.5">
      {items.map((c, i) => {
        const css = `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
        const lit = (c & 0xffffff) !== 0
        return (
          <span
            key={i}
            className="h-4 w-4 rounded-full border border-ink-600"
            style={{
              backgroundColor: css,
              opacity: lit ? Math.max(0.2, brightness / 100) : 1,
              boxShadow: lit ? `0 0 6px ${css}` : 'none'
            }}
          />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------
// 工具条(运行控制 + 外设分组图标)
// ---------------------------------------------------------------

function ToolStrip({
  engine,
  zoom,
  onZoom,
  openGroup,
  onToggleGroup,
  gpsLive,
  stripRef,
  has3d,
  viewMode,
  onToggleViewMode,
  explode,
  onToggleExplode
}: {
  engine: SimEngine
  zoom: ZoomMode
  onZoom: (z: ZoomMode) => void
  openGroup: PeriphGroup | null
  onToggleGroup: (g: PeriphGroup, anchor: { x: number; y: number }) => void
  /** GPS 持续上报开启(图标点) */
  gpsLive: boolean
  /** 外层容器 ref(popover 点外部关闭的边界判断) */
  stripRef: React.RefObject<HTMLDivElement>
  /** 档案带 hardware3d → 显示 2D/3D 切换 */
  has3d: boolean
  viewMode: SimViewMode
  onToggleViewMode: () => void
  /** 爆炸视图(仅 3D 模式显示) */
  explode: boolean
  onToggleExplode: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const ui = useUiState(engine)
  const periph = usePeriph(engine)

  const screenshot = async (): Promise<void> => {
    try {
      const png = await engine.captureScreenshotPng()
      if (!png) {
        showToast(t('sim.screenshotEmpty'), 'warn')
        return
      }
      const path = await window.api.saveScreenshot(png)
      showToast(t('sim.screenshotSaved', { path }), 'success')
    } catch (err) {
      showToast(t('sim.screenshotFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
    }
  }

  /** 分组按钮点击 → 上抛锚点(按钮右缘中点) */
  const toggle = (g: PeriphGroup) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onToggleGroup(g, { x: r.right, y: r.top + r.height / 2 })
  }

  // IMU 偏离默认姿态(0,0,1)视为活动状态
  const imuActive = periph.imu.ax !== 0 || periph.imu.ay !== 0 || periph.imu.az !== 1

  return (
    <div ref={stripRef} className="flex w-9 shrink-0 flex-col items-center gap-0.5 border-r border-ink-700 bg-ink-850 py-1">
      <ToolStripButton title={t('sim.toolbar.power')} disabled={!ui.running} onClick={() => engine.api.stop()}>
        <LuPower className={ui.running ? 'text-red-400' : ''} />
      </ToolStripButton>
      <ToolStripButton title={t('sim.toolbar.reload')} disabled={!ui.running} onClick={() => void engine.reload()}>
        <LuRefreshCw />
      </ToolStripButton>
      <ToolStripButton title={t('sim.toolbar.screenshot')} onClick={() => void screenshot()}>
        <LuCamera />
      </ToolStripButton>
      {/* 3D 视图不应用显示旋转(纹理旋转与触摸 UV 映射冲突),禁用避免静默 no-op */}
      <ToolStripButton title={t('sim.toolbar.rotate')} disabled={viewMode === '3d'} onClick={() => engine.rotateScreen()}>
        <LuRotateCw />
      </ToolStripButton>
      <ToolStripButton title={t('sim.toolbar.volume')} onClick={() => engine.setMuted(!ui.muted)}>
        {ui.muted ? <LuVolumeX className="text-yellow-400" /> : <LuVolume2 />}
      </ToolStripButton>
      <div className="my-0.5 h-px w-5 bg-ink-700" />
      <ToolStripButton
        title={t('sim.toolbar.zoomFit')}
        active={zoom === 'fit'}
        disabled={viewMode === '3d'}
        onClick={() => onZoom('fit')}
      >
        <LuMaximize />
      </ToolStripButton>
      <ToolStripButton
        title={t('sim.toolbar.zoom100')}
        active={zoom === 'one'}
        disabled={viewMode === '3d'}
        onClick={() => onZoom('one')}
      >
        <span className="text-[9px] font-bold">1:1</span>
      </ToolStripButton>

      {/* 2D/3D 视图切换 + 爆炸视图(仅档案带 hardware3d 的设备) */}
      {has3d && (
        <>
          <div className="my-0.5 h-px w-5 bg-ink-700" />
          <ToolStripButton
            title={viewMode === '3d' ? t('sim.toolbar.view2d') : t('sim.toolbar.view3d')}
            active={viewMode === '3d'}
            onClick={onToggleViewMode}
          >
            {viewMode === '3d' ? <LuMonitor /> : <LuBox />}
          </ToolStripButton>
          {viewMode === '3d' && (
            <ToolStripButton title={t('sim.toolbar.explode')} active={explode} onClick={onToggleExplode}>
              <LuExpand />
            </ToolStripButton>
          )}
        </>
      )}

      {/* 分隔线下:虚拟外设分组(点击弹 popover,活动状态右上角圆点) */}
      <div className="my-0.5 h-px w-5 bg-ink-700" />
      <ToolStripButton
        title={t('sim.group.power')}
        active={openGroup === 'power'}
        dot={periph.battery.charging}
        onClick={toggle('power')}
      >
        <LuBatteryMedium />
      </ToolStripButton>
      <ToolStripButton title={t('sim.group.buttons')} active={openGroup === 'buttons'} onClick={toggle('buttons')}>
        <LuKeyboard />
      </ToolStripButton>
      <ToolStripButton title={t('sim.group.imu')} active={openGroup === 'imu'} dot={imuActive} onClick={toggle('imu')}>
        <LuAxis3D />
      </ToolStripButton>
      <ToolStripButton title={t('sim.group.gps')} active={openGroup === 'gps'} dot={gpsLive} onClick={toggle('gps')}>
        <LuMapPin />
      </ToolStripButton>
      <ToolStripButton
        title={t('sim.group.led')}
        active={openGroup === 'led'}
        dot={periph.led.available}
        onClick={toggle('led')}
      >
        <LuLightbulb />
      </ToolStripButton>
      <ToolStripButton
        title={t('sim.group.camera')}
        active={openGroup === 'camera'}
        dot={ui.cameraActive}
        onClick={toggle('camera')}
      >
        <LuWebcam />
      </ToolStripButton>
    </div>
  )
}

// ---------------------------------------------------------------
// 屏幕区域
// ---------------------------------------------------------------

function ScreenView({
  engine,
  screen,
  zoom
}: {
  engine: SimEngine
  screen: ScreenSize
  zoom: ZoomMode
}): React.JSX.Element {
  const ui = useUiState(engine)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const pressedRef = useRef(false)

  // 画布挂载 → 引擎
  useEffect(() => {
    engine.attachScreen(canvasRef.current)
    return () => engine.attachScreen(null)
  }, [engine])

  // 容器尺寸变化 → 计算缩放:fit = 整数倍优先(容不下 1x 时用精确比例);one = 恒 100%
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const compute = (): void => {
      if (zoom === 'one') {
        setScale(1)
        return
      }
      const pad = 40 // 白框 + 边距
      const rotated = ui.rotation === 90 || ui.rotation === 270
      const bw = (rotated ? screen.height : screen.width) + pad
      const bh = (rotated ? screen.width : screen.height) + pad
      const fit = Math.min(area.clientWidth / bw, area.clientHeight / bh)
      setScale(fit >= 1 ? Math.floor(fit) : Math.max(0.1, fit))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(area)
    return () => ro.disconnect()
  }, [ui.rotation, zoom, screen.width, screen.height])

  const toScreenXY = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
      // offsetX/Y 在 Chromium 中已换算到元素本地坐标系(含 transform)
      const ne = e.nativeEvent
      return {
        x: Math.max(0, Math.min(screen.width - 1, ne.offsetX / scale)),
        y: Math.max(0, Math.min(screen.height - 1, ne.offsetY / scale))
      }
    },
    [scale, screen.width, screen.height]
  )

  const rotated = ui.rotation === 90 || ui.rotation === 270
  const boxW = (rotated ? screen.height : screen.width) * scale
  const boxH = (rotated ? screen.width : screen.height) * scale

  return (
    <div ref={areaRef} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-2">
      {/* 白色圆角盒子外框(产品外观;亮色主题下经 .sim-device-shell 补描边/投影与浅背景分离) */}
      <div
        className="sim-device-shell flex items-center justify-center rounded-2xl bg-white shadow-lg"
        style={{ width: boxW + 24, height: boxH + 24 }}
      >
        <div
          className="relative overflow-hidden rounded-md bg-black"
          style={{ width: boxW, height: boxH }}
        >
          <canvas
            ref={canvasRef}
            width={screen.width}
            height={screen.height}
            onMouseDown={(e) => {
              pressedRef.current = true
              const p = toScreenXY(e)
              engine.sendTouch('down', p.x, p.y)
            }}
            onMouseMove={(e) => {
              if (!pressedRef.current) return
              const p = toScreenXY(e)
              engine.sendTouch('move', p.x, p.y)
            }}
            onMouseUp={(e) => {
              if (!pressedRef.current) return
              pressedRef.current = false
              const p = toScreenXY(e)
              engine.sendTouch('up', p.x, p.y)
            }}
            onMouseLeave={(e) => {
              if (!pressedRef.current) return
              pressedRef.current = false
              const p = toScreenXY(e)
              engine.sendTouch('up', p.x, p.y)
            }}
            className="absolute left-1/2 top-1/2 cursor-crosshair"
            style={{
              width: screen.width * scale,
              height: screen.height * scale,
              imageRendering: 'pixelated',
              filter: `brightness(${Math.max(5, ui.brightness)}%)`,
              transform: `translate(-50%, -50%) rotate(${ui.rotation}deg)`
            }}
          />
          {/* 熄屏遮罩 */}
          {!ui.power && <div className="absolute inset-0 bg-black" />}
        </div>
      </div>
      {/* 右下角缩放百分比标签(如 147%) */}
      <span className="absolute bottom-1.5 right-2 rounded bg-ink-850/90 px-1.5 py-0.5 text-[10px] text-jb-muted">
        {Math.round(scale * 100)}%
      </span>
    </div>
  )
}

// ---------------------------------------------------------------
// 主面板
// ---------------------------------------------------------------

export function SimPanel({ engine, screen }: { engine: SimEngine; screen: ScreenSize }): React.JSX.Element {
  const { t } = useTranslation()
  const ui = useUiState(engine)
  const periph = usePeriph(engine)
  const [zoom, setZoom] = useState<ZoomMode>('fit')

  // ---- 2D/3D 视图(仅档案带 hardware3d;模式存 SimSession 随 tab 保留,
  //      爆炸态与 zoom 一样留在本地,tab 切换重挂即复位) ----
  const { sessions } = useSimSessions()
  const hardware3d = engine.profile.hardware3d ?? null
  const sessionViewMode = sessions.find((s) => s.key === engine.deviceKey)?.viewMode
  const viewMode: SimViewMode = hardware3d && sessionViewMode === '3d' ? '3d' : '2d'
  const [explode, setExplode] = useState(false)

  const toggleViewMode = useCallback((): void => {
    const next: SimViewMode = viewMode === '3d' ? '2d' : '3d'
    if (next === '2d') setExplode(false)
    setSessionViewMode(engine.deviceKey, next)
  }, [viewMode, engine.deviceKey])

  // ---- 外设 popover(同时只开一个;popover 作用于当前激活 tab 的会话:
  //      SimPanel 按会话 key 重挂,引擎即本会话实例) ----
  const [openGroup, setOpenGroup] = useState<PeriphGroup | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // GPS:草稿输入 + 「发送定位」提交;「持续上报」开启时输入即推送
  const [gpsDraft, setGpsDraft] = useState<{ lat: number; lng: number }>(() => engine.periphStore.get().gps)
  const [gpsLive, setGpsLive] = useState(false)

  const toggleGroup = useCallback((g: PeriphGroup, a: { x: number; y: number }): void => {
    setOpenGroup((cur) => (cur === g ? null : g))
    setAnchor(a)
  }, [])

  // 点外部 / Esc / 窗口尺寸变化 → 关闭 popover(工具条与 popover 内部点击除外)
  useEffect(() => {
    if (!openGroup) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (stripRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpenGroup(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
        setOpenGroup(null)
      }
    }
    const onResize = (): void => setOpenGroup(null)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [openGroup])

  const setImu = (axis: 'ax' | 'ay' | 'az', v: number): void => {
    engine.periphStore.set({ imu: { ...periph.imu, [axis]: v } })
  }

  /** GPS 输入变更:更新草稿;持续上报开启时立即推送 */
  const changeGps = (patch: Partial<{ lat: number; lng: number }>): void => {
    const next = { ...gpsDraft, ...patch }
    setGpsDraft(next)
    if (gpsLive) engine.periphStore.set({ gps: next })
  }

  /** popover 内容(逻辑复用原分组表单,仅换容器) */
  const renderGroup = (g: PeriphGroup): React.JSX.Element => {
    switch (g) {
      case 'power':
        return (
          <>
            <Slider
              label={t('sim.battery')}
              min={0}
              max={100}
              value={periph.battery.level}
              suffix="%"
              onChange={(v) => engine.periphStore.set({ battery: { ...periph.battery, level: v } })}
            />
            <Toggle
              label={t('sim.charging')}
              checked={periph.battery.charging}
              onChange={(v) => engine.periphStore.set({ battery: { ...periph.battery, charging: v } })}
            />
          </>
        )
      case 'buttons':
        return (
          <>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-[11px] text-jb-text active:bg-accent-dim"
                onMouseDown={() => engine.sendButton('down')}
                onMouseUp={() => engine.sendButton('up')}
                onMouseLeave={(e) => {
                  if (e.buttons > 0) engine.sendButton('up')
                }}
              >
                {t('sim.bootButton')}
              </button>
              <button
                className="flex-1 rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-[11px] text-jb-text active:bg-accent-dim"
                onClick={() => engine.sendShake()}
              >
                {t('sim.shake')}
              </button>
            </div>
            <div className="text-[10px] text-ink-500">{t('sim.bootHint')}</div>
          </>
        )
      case 'imu':
        return (
          <>
            <Slider label="ax (g)" min={-2} max={2} step={0.05} value={periph.imu.ax} onChange={(v) => setImu('ax', v)} />
            <Slider label="ay (g)" min={-2} max={2} step={0.05} value={periph.imu.ay} onChange={(v) => setImu('ay', v)} />
            <Slider label="az (g)" min={-2} max={2} step={0.05} value={periph.imu.az} onChange={(v) => setImu('az', v)} />
            <button
              className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-jb-text hover:bg-ink-700"
              onClick={() => engine.periphStore.set({ imu: { ...periph.imu, ax: 0, ay: 0, az: 1 } })}
            >
              {t('sim.imuReset')}
            </button>
          </>
        )
      case 'gps':
        return (
          <>
            <div className="flex gap-2">
              <label className="flex-1 text-[11px] text-jb-muted">
                {t('sim.lat')}
                <input
                  type="number"
                  step="0.0001"
                  value={gpsDraft.lat}
                  onChange={(e) => changeGps({ lat: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded border border-ink-600 bg-ink-800 px-1.5 py-1 font-mono text-[11px] text-jb-text outline-none focus:border-accent"
                />
              </label>
              <label className="flex-1 text-[11px] text-jb-muted">
                {t('sim.lng')}
                <input
                  type="number"
                  step="0.0001"
                  value={gpsDraft.lng}
                  onChange={(e) => changeGps({ lng: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded border border-ink-600 bg-ink-800 px-1.5 py-1 font-mono text-[11px] text-jb-text outline-none focus:border-accent"
                />
              </label>
            </div>
            <button
              className="w-full rounded bg-accent px-2 py-1 text-[11px] text-white hover:bg-accent-dim"
              onClick={() => engine.periphStore.set({ gps: { ...gpsDraft } })}
            >
              {t('sim.gpsSend')}
            </button>
            <Toggle
              label={t('sim.gpsLive')}
              checked={gpsLive}
              onChange={(v) => {
                setGpsLive(v)
                // 开启即推送一次当前草稿(随后输入实时上报)
                if (v) engine.periphStore.set({ gps: { ...gpsDraft } })
              }}
            />
          </>
        )
      case 'led':
        return (
          <>
            <Toggle
              label={t('sim.ledEnable')}
              checked={periph.led.available}
              onChange={(v) => engine.periphStore.set({ led: { ...periph.led, available: v } })}
            />
            {periph.led.available && <LedStrip colors={ui.ledColors} brightness={ui.ledBrightness} />}
          </>
        )
      case 'camera':
        return (
          <>
            <div className="text-[10px] text-ink-500">{t('sim.cameraHint')}</div>
            {ui.cameraActive && <CameraPreview stream={ui.cameraStream} />}
          </>
        )
    }
  }

  return (
    <div className="flex h-full flex-col bg-ink-900">
      {/* 运行状态行 */}
      <div className="flex h-6 shrink-0 items-center gap-2 px-3 text-[11px] text-jb-muted">
        <VscCircleFilled className={ui.running ? 'text-green-400' : 'text-ink-500'} />
        <span>{ui.running ? (ui.appName ?? t('sim.running')) : t('sim.stopped')}</span>
        {ui.voiceState !== 'idle' && (
          <span className="flex items-center gap-1 text-sky-300">
            <VscComment /> {t(`sim.voice.${ui.voiceState}`)}
          </span>
        )}
        {ui.micActive && (
          <span className="flex items-center gap-1 text-red-300">
            <VscMic /> {t('sim.micOn')}
          </span>
        )}
      </div>

      {/* 左缘工具条 + 屏幕画布(外设收进 popover,画布独占纵向空间) */}
      <div className="flex min-h-0 flex-1">
        <ToolStrip
          engine={engine}
          zoom={zoom}
          onZoom={setZoom}
          openGroup={openGroup}
          onToggleGroup={toggleGroup}
          gpsLive={gpsLive}
          stripRef={stripRef}
          has3d={hardware3d !== null}
          viewMode={viewMode}
          onToggleViewMode={toggleViewMode}
          explode={explode}
          onToggleExplode={() => setExplode((v) => !v)}
        />
        {/* 2D/3D 互斥使用 attachScreen 单 sink:React 先跑旧分支 cleanup(attach(null))再挂新分支 */}
        {viewMode === '3d' && hardware3d ? (
          <ScreenView3D engine={engine} screen={screen} hardware={hardware3d} explode={explode} />
        ) : (
          <ScreenView engine={engine} screen={screen} zoom={zoom} />
        )}
      </div>

      {/* 外设分组 popover(JetBrains 气泡:#2B2D30 底 / #393B40 边框 / 箭头指向按钮) */}
      {openGroup && anchor && (
        <div ref={popoverRef}>
          <PeriphPopover anchor={anchor} title={t(`sim.group.${openGroup}`)}>
            {renderGroup(openGroup)}
          </PeriphPopover>
        </div>
      )}
    </div>
  )
}
