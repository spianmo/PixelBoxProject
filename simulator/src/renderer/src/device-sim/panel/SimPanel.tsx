/**
 * 虚拟设备面板(右侧):像素屏 + 虚拟外设控件
 *
 * - 屏幕:368×448 canvas,整数倍缩放 + image-rendering: pixelated,白色圆角盒子外框;
 *   鼠标事件映射为触摸(down/move/up),亮度→CSS filter,熄屏→黑色遮罩,旋转→CSS transform
 * - 外设分组(可折叠):电源(电量滑条+充电开关)/ 按键(BOOT+摇一摇)/
 *   IMU 三轴滑条 / GPS 经纬度 / LED 灯带(开关+可视化)/ 摄像头(预览)
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  VscChevronDown,
  VscChevronRight,
  VscCircleFilled,
  VscDeviceCameraVideo,
  VscLocation,
  VscPlug,
  VscPulse,
  VscRecordKeys,
  VscLightbulb,
  VscMic,
  VscComment
} from 'react-icons/vsc'
import type { SimEngine, EngineUiState } from '../engine'
import type { PeriphSnapshot } from '../protocol'

const SCREEN_W = 368
const SCREEN_H = 448

function useUiState(engine: SimEngine): EngineUiState {
  return useSyncExternalStore(engine.uiStore.subscribe, engine.uiStore.get)
}

function usePeriph(engine: SimEngine): PeriphSnapshot {
  return useSyncExternalStore(engine.periphStore.subscribe, engine.periphStore.get)
}

// ---------------------------------------------------------------
// 折叠分组
// ---------------------------------------------------------------

function Group(props: {
  icon: React.ReactNode
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  return (
    <div className="border-b border-ink-700">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-gray-300 hover:bg-ink-800"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <VscChevronDown className="shrink-0" /> : <VscChevronRight className="shrink-0" />}
        <span className="text-accent">{props.icon}</span>
        <span className="font-medium">{props.title}</span>
      </button>
      {open && <div className="space-y-2 px-3 pb-3 pt-1">{props.children}</div>}
    </div>
  )
}

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
    <label className="block text-xs text-gray-400">
      <div className="mb-0.5 flex justify-between">
        <span>{props.label}</span>
        <span className="font-mono text-gray-300">
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
        className="w-full accent-sky-400"
      />
    </label>
  )
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between text-xs text-gray-400">
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-sky-400"
      />
    </label>
  )
}

// ---------------------------------------------------------------
// 屏幕区域
// ---------------------------------------------------------------

function ScreenView({ engine }: { engine: SimEngine }): React.JSX.Element {
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

  // 容器尺寸变化 → 整数倍缩放(容不下 1x 时退到 0.5x)
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const ro = new ResizeObserver(() => {
      const pad = 40 // 白框 + 边距
      const rotated = ui.rotation === 90 || ui.rotation === 270
      const bw = (rotated ? SCREEN_H : SCREEN_W) + pad
      const bh = (rotated ? SCREEN_W : SCREEN_H) + pad
      const fit = Math.min(area.clientWidth / bw, area.clientHeight / bh)
      setScale(fit >= 1 ? Math.floor(fit) : 0.5)
    })
    ro.observe(area)
    return () => ro.disconnect()
  }, [ui.rotation])

  const toScreenXY = useCallback((e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    // offsetX/Y 在 Chromium 中已换算到元素本地坐标系(含 transform)
    const ne = e.nativeEvent
    return {
      x: Math.max(0, Math.min(SCREEN_W - 1, ne.offsetX / scale)),
      y: Math.max(0, Math.min(SCREEN_H - 1, ne.offsetY / scale))
    }
  }, [scale])

  const rotated = ui.rotation === 90 || ui.rotation === 270
  const boxW = (rotated ? SCREEN_H : SCREEN_W) * scale
  const boxH = (rotated ? SCREEN_W : SCREEN_H) * scale

  return (
    <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
      {/* 白色圆角盒子外框(产品外观) */}
      <div
        className="flex items-center justify-center rounded-2xl bg-white shadow-lg"
        style={{ width: boxW + 24, height: boxH + 24 }}
      >
        <div
          className="relative overflow-hidden rounded-md bg-black"
          style={{ width: boxW, height: boxH }}
        >
          <canvas
            ref={canvasRef}
            width={SCREEN_W}
            height={SCREEN_H}
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
              width: SCREEN_W * scale,
              height: SCREEN_H * scale,
              imageRendering: 'pixelated',
              filter: `brightness(${Math.max(5, ui.brightness)}%)`,
              transform: `translate(-50%, -50%) rotate(${ui.rotation}deg)`
            }}
          />
          {/* 熄屏遮罩 */}
          {!ui.power && <div className="absolute inset-0 bg-black" />}
        </div>
      </div>
    </div>
  )
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
// 主面板
// ---------------------------------------------------------------

export function SimPanel({ engine }: { engine: SimEngine }): React.JSX.Element {
  const { t } = useTranslation()
  const ui = useUiState(engine)
  const periph = usePeriph(engine)
  const videoRef = useRef<HTMLVideoElement>(null)

  // 摄像头预览
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = ui.cameraStream
      if (ui.cameraStream) void videoRef.current.play().catch(() => undefined)
    }
  }, [ui.cameraStream])

  const setImu = (axis: 'ax' | 'ay' | 'az', v: number): void => {
    engine.periphStore.set({ imu: { ...periph.imu, [axis]: v } })
  }

  return (
    <div className="flex h-full flex-col bg-ink-900">
      {/* 屏幕 + 运行状态 */}
      <div className="flex h-6 shrink-0 items-center gap-2 px-3 text-[11px] text-gray-500">
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
      <ScreenView engine={engine} />

      {/* 外设控件(滚动区) */}
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-ink-700">
        {/* 电源 */}
        <Group icon={<VscPlug />} title={t('sim.group.power')}>
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
        </Group>

        {/* 按键 */}
        <Group icon={<VscRecordKeys />} title={t('sim.group.buttons')}>
          <div className="flex gap-2">
            <button
              className="flex-1 rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-gray-200 active:bg-accent-dim"
              onMouseDown={() => engine.sendButton('down')}
              onMouseUp={() => engine.sendButton('up')}
              onMouseLeave={(e) => {
                if (e.buttons > 0) engine.sendButton('up')
              }}
            >
              {t('sim.bootButton')}
            </button>
            <button
              className="flex-1 rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-gray-200 active:bg-accent-dim"
              onClick={() => engine.sendShake()}
            >
              {t('sim.shake')}
            </button>
          </div>
          <div className="text-[10px] text-gray-600">{t('sim.bootHint')}</div>
        </Group>

        {/* IMU */}
        <Group icon={<VscPulse />} title={t('sim.group.imu')} defaultOpen={false}>
          <Slider label="ax (g)" min={-2} max={2} step={0.05} value={periph.imu.ax} onChange={(v) => setImu('ax', v)} />
          <Slider label="ay (g)" min={-2} max={2} step={0.05} value={periph.imu.ay} onChange={(v) => setImu('ay', v)} />
          <Slider label="az (g)" min={-2} max={2} step={0.05} value={periph.imu.az} onChange={(v) => setImu('az', v)} />
        </Group>

        {/* GPS */}
        <Group icon={<VscLocation />} title={t('sim.group.gps')} defaultOpen={false}>
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-gray-400">
              {t('sim.lat')}
              <input
                type="number"
                step="0.0001"
                value={periph.gps.lat}
                onChange={(e) =>
                  engine.periphStore.set({ gps: { ...periph.gps, lat: Number(e.target.value) } })
                }
                className="mt-0.5 w-full rounded border border-ink-600 bg-ink-800 px-1.5 py-1 font-mono text-xs text-gray-200 outline-none focus:border-accent"
              />
            </label>
            <label className="flex-1 text-xs text-gray-400">
              {t('sim.lng')}
              <input
                type="number"
                step="0.0001"
                value={periph.gps.lng}
                onChange={(e) =>
                  engine.periphStore.set({ gps: { ...periph.gps, lng: Number(e.target.value) } })
                }
                className="mt-0.5 w-full rounded border border-ink-600 bg-ink-800 px-1.5 py-1 font-mono text-xs text-gray-200 outline-none focus:border-accent"
              />
            </label>
          </div>
        </Group>

        {/* LED 灯带 */}
        <Group icon={<VscLightbulb />} title={t('sim.group.led')} defaultOpen={false}>
          <Toggle
            label={t('sim.ledEnable')}
            checked={periph.led.available}
            onChange={(v) => engine.periphStore.set({ led: { ...periph.led, available: v } })}
          />
          {periph.led.available && <LedStrip colors={ui.ledColors} brightness={ui.ledBrightness} />}
        </Group>

        {/* 摄像头 */}
        <Group icon={<VscDeviceCameraVideo />} title={t('sim.group.camera')} defaultOpen={false}>
          <div className="text-[10px] text-gray-600">{t('sim.cameraHint')}</div>
          {ui.cameraActive && (
            <video ref={videoRef} muted playsInline className="w-full rounded border border-ink-600" />
          )}
        </Group>
      </div>
    </div>
  )
}
