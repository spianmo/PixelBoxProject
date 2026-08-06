/**
 * 外壳参数表单(硬件设计面板「外壳」tab)
 *
 * - JetBrains 密度:左标签右控件;数值输入聚焦期间不被 store 回写打断,
 *   输入合法即实时提交(3D 视图即时重建),失焦时钳制并回显
 * - 侧壁开孔(ports)列表编辑:墙面 N/S/E/W + x/y/w/h/r
 * - 所有变更经 setEnclosureParams:store 即时生效 + 500ms 防抖写回 enclosure.json
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuInfo, LuPlus, LuTrash2 } from 'react-icons/lu'
import type { EnclosureParams, EnclosurePort } from './types'
import { setEnclosureParams, useHardware } from './store'

const INPUT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent'
const SELECT_CLASS =
  'rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[12px] text-jb-text outline-none focus:border-accent'

/** 表单行:左标签右控件 */
function FormRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="w-32 shrink-0 pt-1.5 text-right text-xs text-jb-muted">{props.label}</div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

/**
 * 数值输入:内部持有文本态,聚焦期间不同步外部值(避免打断输入);
 * 输入合法即钳制提交(实时预览),失焦/回车时把文本规整为钳制后的值。
 */
function NumField(props: {
  value: number
  min: number
  max: number
  step: number
  className?: string
  placeholder?: string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const { value, min, max, onCommit } = props
  const [text, setText] = useState(String(value))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])

  const clamp = (n: number): number => Math.min(max, Math.max(min, n))

  const commitLive = (raw: string): void => {
    setText(raw)
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(n)) {
      const c = clamp(n)
      if (c !== value) onCommit(c)
    }
  }

  const normalize = (): void => {
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) {
      setText(String(value))
      return
    }
    const c = clamp(n)
    setText(String(c))
    if (c !== value) onCommit(c)
  }

  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={props.step}
      placeholder={props.placeholder}
      className={props.className ?? `${INPUT_CLASS} w-24`}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => commitLive(e.target.value)}
      onBlur={() => {
        focused.current = false
        normalize()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') normalize()
      }}
    />
  )
}

/** 数值字段清单(标签 i18n key 后缀 = 字段名;范围为可打印外壳的合理钳制区间) */
const NUM_FIELDS: {
  key: keyof Pick<
    EnclosureParams,
    | 'wallMM'
    | 'clearanceMM'
    | 'baseHeightMM'
    | 'lidHeightMM'
    | 'standoffHeightMM'
    | 'standoffOuterR'
    | 'standoffInnerR'
    | 'cornerR'
  >
  min: number
  max: number
  step: number
}[] = [
  { key: 'wallMM', min: 0.8, max: 5, step: 0.1 },
  { key: 'clearanceMM', min: 0, max: 5, step: 0.1 },
  { key: 'baseHeightMM', min: 3, max: 60, step: 0.5 },
  { key: 'lidHeightMM', min: 1, max: 40, step: 0.5 },
  { key: 'standoffHeightMM', min: 1, max: 20, step: 0.5 },
  { key: 'standoffOuterR', min: 1.5, max: 8, step: 0.1 },
  { key: 'standoffInnerR', min: 0.5, max: 3, step: 0.05 },
  { key: 'cornerR', min: 0, max: 10, step: 0.5 }
]

const WALLS: EnclosurePort['wall'][] = ['north', 'south', 'east', 'west']

/** 开孔数值列(x/y 允许负偏移;w/h 下限保证可打印;r 圆角) */
const PORT_NUM_COLS: { key: 'x' | 'y' | 'w' | 'h' | 'r'; min: number; max: number }[] = [
  { key: 'x', min: -200, max: 200 },
  { key: 'y', min: -200, max: 200 },
  { key: 'w', min: 0.5, max: 100 },
  { key: 'h', min: 0.5, max: 100 },
  { key: 'r', min: 0, max: 10 }
]

/** 新增开孔默认值(USB-C 窗口量级) */
const NEW_PORT: EnclosurePort = { wall: 'south', x: 0, y: 5, w: 12, h: 7, r: 1.5 }

export function EnclosureForm(props: { root: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { enclosure, screen } = useHardware()

  const patch = (p: Partial<EnclosureParams>): void => setEnclosureParams(props.root, p)

  const updatePort = (index: number, p: Partial<EnclosurePort>): void => {
    const ports = enclosure.ports.map((port, i) => (i === index ? { ...port, ...p } : port))
    patch({ ports })
  }

  const removePort = (index: number): void => {
    patch({ ports: enclosure.ports.filter((_, i) => i !== index) })
  }

  const addPort = (): void => {
    patch({ ports: [...enclosure.ports, { ...NEW_PORT }] })
  }

  return (
    <div className="max-w-[460px] space-y-3">
      {/* 尺寸参数 */}
      {NUM_FIELDS.map((f) => (
        <FormRow key={f.key} label={t(`hw.enclosure.${f.key}`)}>
          <NumField
            value={enclosure[f.key]}
            min={f.min}
            max={f.max}
            step={f.step}
            onCommit={(v) => patch({ [f.key]: v })}
          />
        </FormRow>
      ))}

      {/* 顶盖屏幕窗 */}
      <FormRow label={t('hw.enclosure.screenWindow')}>
        <label className="flex cursor-pointer items-center gap-2 pt-1.5 text-[13px] text-jb-text">
          <input
            type="checkbox"
            checked={enclosure.screenWindow}
            onChange={(e) => patch({ screenWindow: e.target.checked })}
            className="accent-[#3574F0]"
          />
          <span className="text-xs text-jb-muted">{t('hw.enclosure.screenWindowHint')}</span>
        </label>
        {enclosure.screenWindow && !screen && (
          <div className="mt-1 flex items-start gap-1 text-[11px] text-yellow-300/90">
            <LuInfo className="mt-0.5 shrink-0" />
            <span>{t('hw.enclosure.noScreenHint')}</span>
          </div>
        )}
      </FormRow>

      {/* 侧壁开孔列表 */}
      <FormRow label={t('hw.enclosure.ports')}>
        <div className="space-y-1.5 pt-1">
          {enclosure.ports.length === 0 && (
            <div className="text-[11px] text-ink-500">{t('hw.enclosure.noPorts')}</div>
          )}
          {enclosure.ports.map((port, i) => (
            <div key={i} className="flex items-center gap-1">
              <select
                value={port.wall}
                onChange={(e) => updatePort(i, { wall: e.target.value as EnclosurePort['wall'] })}
                className={SELECT_CLASS}
                title={t('hw.enclosure.wall')}
              >
                {WALLS.map((w) => (
                  <option key={w} value={w}>
                    {t(`hw.enclosure.wall_${w}`)}
                  </option>
                ))}
              </select>
              {PORT_NUM_COLS.map((col) => (
                <NumField
                  key={col.key}
                  value={col.key === 'r' ? (port.r ?? 0) : port[col.key]}
                  min={col.min}
                  max={col.max}
                  step={0.5}
                  placeholder={col.key}
                  className={`${INPUT_CLASS} w-14 px-1 text-center`}
                  onCommit={(v) => updatePort(i, { [col.key]: v })}
                />
              ))}
              <button
                title={t('hw.enclosure.removePort')}
                onClick={() => removePort(i)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-red-400"
              >
                <LuTrash2 className="text-[12px]" />
              </button>
            </div>
          ))}
          {/* 列头提示:mm 单位,x/y 沿墙偏移,w/h 开孔尺寸,r 圆角 */}
          {enclosure.ports.length > 0 && (
            <div className="text-[11px] text-ink-500">{t('hw.enclosure.portHint')}</div>
          )}
          <button
            onClick={addPort}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-jb-muted hover:bg-ink-800 hover:text-jb-text"
          >
            <LuPlus className="text-[12px]" />
            <span>{t('hw.enclosure.addPort')}</span>
          </button>
        </div>
      </FormRow>
    </div>
  )
}
