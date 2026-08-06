/**
 * 「新建模拟器」向导对话框(JetBrains 风格表单;编辑复用同一向导)
 *
 * 字段:名称 / 芯片下拉 / 屏幕分辨率(预设 + 自定义 WxH,64–1024 校验)/
 *       PSRAM(无/2/8MB,芯片不支持时禁用)/ Flash(4/8/16MB)/ 备注
 * 芯片差异由 shared/chipCapabilities.ts 单一数据源驱动
 * (如 ESP32-C6 无 PSRAM → 强制 0 并禁用;ESP32-P4 显示需配套 C6 hosted 提示)。
 *
 * 打开方式:openDeviceWizard(initial?) —— 标题栏「新建模拟器…」与
 * 设备管理器工具窗(新建/编辑)共用;App 挂载一次 <DeviceWizardHost/>。
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuInfo } from 'react-icons/lu'
import type { DeviceProfile } from '../../../shared/ipc-types'
import {
  CHIP_CAPABILITIES,
  FLASH_OPTIONS_MB,
  SCREEN_MAX,
  SCREEN_MIN,
  chipCapability,
  validateProfileFields
} from '../../../shared/chipCapabilities'
import { createStore } from '../device-sim/store'
import { saveDeviceProfile } from './store'
import { showToast } from '../components/toast'

// ---------------------------------------------------------------
// 打开状态(全局可触发:标题栏 / 设备管理器)
// ---------------------------------------------------------------

interface WizardState {
  open: boolean
  /** 编辑时的原档案;新建为 null */
  initial: DeviceProfile | null
}

const wizardStore = createStore<WizardState>({ open: false, initial: null })

/** 打开向导(不传 initial = 新建;传 = 编辑) */
export function openDeviceWizard(initial?: DeviceProfile): void {
  wizardStore.set({ open: true, initial: initial ?? null })
}

function closeWizard(): void {
  wizardStore.set({ open: false, initial: null })
}

// ---------------------------------------------------------------
// 分辨率预设
// ---------------------------------------------------------------

interface Preset {
  key: string
  w?: number
  h?: number
  /** 附注(如 AMOLED 1.8″) */
  tag?: string
}

const PRESETS: readonly Preset[] = [
  { key: '368x448', w: 368, h: 448, tag: 'AMOLED 1.8″' },
  { key: '240x240', w: 240, h: 240 },
  { key: '320x240', w: 320, h: 240 },
  { key: '466x466', w: 466, h: 466 },
  { key: '240x536', w: 240, h: 536 },
  { key: 'custom' } // 自定义 WxH
]

function presetKeyOf(w: number, h: number): string {
  return PRESETS.find((p) => p.w === w && p.h === h)?.key ?? 'custom'
}

// ---------------------------------------------------------------
// 表单
// ---------------------------------------------------------------

/** 表单行:左标签右控件(JetBrains 表单密度) */
function FormRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="w-24 shrink-0 pt-1.5 text-right text-xs text-jb-muted">{props.label}</div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

const INPUT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent'
const SELECT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] text-jb-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:text-ink-500'

function WizardForm({ initial }: { initial: DeviceProfile | null }): React.JSX.Element {
  const { t } = useTranslation()
  const editing = initial !== null

  const [name, setName] = useState(initial?.name ?? t('deviceManager.wizard.defaultName'))
  const [chip, setChip] = useState(initial?.chip ?? 'esp32s3')
  const [preset, setPreset] = useState(() =>
    initial ? presetKeyOf(initial.screenW, initial.screenH) : '368x448'
  )
  const [customW, setCustomW] = useState(String(initial?.screenW ?? 368))
  const [customH, setCustomH] = useState(String(initial?.screenH ?? 448))
  const [psramMB, setPsramMB] = useState(initial?.psramMB ?? 8)
  const [flashMB, setFlashMB] = useState(initial?.flashMB ?? 16)
  const [note, setNote] = useState(initial?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const cap = useMemo(() => chipCapability(chip), [chip])

  /** 芯片切换:PSRAM 档位随能力表收敛(C6/C3 → 0 并禁用) */
  const onChipChange = (next: string): void => {
    setChip(next)
    const nextCap = chipCapability(next)
    if (!nextCap.psramOptionsMB.includes(psramMB)) {
      setPsramMB(nextCap.psram ? 8 : 0)
    }
  }

  const resolved = (): { w: number; h: number } => {
    const p = PRESETS.find((x) => x.key === preset)
    if (p?.w && p?.h) return { w: p.w, h: p.h }
    return { w: Number(customW), h: Number(customH) }
  }

  const submit = async (): Promise<void> => {
    const { w, h } = resolved()
    const profile: DeviceProfile = {
      id: initial?.id ?? '',
      name: name.trim(),
      chip,
      screenW: w,
      screenH: h,
      psramMB: cap.psram ? psramMB : 0,
      flashMB,
      note: note.trim(),
      createdAt: initial?.createdAt ?? 0
    }
    // 前端先行校验(与 main 侧同一校验函数,错误码 → i18n)
    const code = validateProfileFields(profile)
    if (code) {
      setError(code)
      return
    }
    setSaving(true)
    const err = await saveDeviceProfile(profile)
    setSaving(false)
    if (err) {
      // main 抛错格式 "profile:<code>"(IPC 会包一层前缀,取最后一段)
      const m = /profile:(\w+)/.exec(err)
      setError(m ? m[1] : 'saveFailed')
      return
    }
    showToast(t(editing ? 'deviceManager.saved' : 'deviceManager.created', { name: profile.name }), 'success')
    closeWizard()
  }

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeWizard()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeWizard()
      }}
    >
      <div className="w-[440px] rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        {/* 标题 */}
        <div className="border-b border-ink-700 px-4 py-2.5 text-sm font-medium text-jb-text">
          {editing ? t('deviceManager.wizard.editTitle') : t('deviceManager.wizard.title')}
        </div>

        {/* 表单体 */}
        <div className="space-y-3 px-4 py-4">
          <FormRow label={t('deviceManager.wizard.name')}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('deviceManager.wizard.namePlaceholder')}
              className={INPUT_CLASS}
              spellCheck={false}
            />
          </FormRow>

          <FormRow label={t('deviceManager.wizard.chip')}>
            <select value={chip} onChange={(e) => onChipChange(e.target.value)} className={SELECT_CLASS}>
              {CHIP_CAPABILITIES.map((c) => (
                <option key={c.chip} value={c.chip}>
                  {c.label}
                  {c.dualCore ? ` · ${t('deviceManager.wizard.dualCore')}` : ''}
                </option>
              ))}
            </select>
            {/* 芯片提示(如 P4:WiFi/BLE 需配套 ESP32-C6 hosted 模块) */}
            {cap.hintKey && (
              <div className="mt-1 flex items-start gap-1 text-[11px] text-yellow-300/90">
                <LuInfo className="mt-0.5 shrink-0" />
                <span>{t(`deviceManager.chipHint.${cap.hintKey}`)}</span>
              </div>
            )}
          </FormRow>

          <FormRow label={t('deviceManager.wizard.screen')}>
            <select value={preset} onChange={(e) => setPreset(e.target.value)} className={SELECT_CLASS}>
              {PRESETS.map((p) =>
                p.w && p.h ? (
                  <option key={p.key} value={p.key}>
                    {p.w}×{p.h}
                    {p.tag ? ` · ${p.tag}` : ''}
                  </option>
                ) : (
                  <option key={p.key} value={p.key}>
                    {t('deviceManager.wizard.custom')}
                  </option>
                )
              )}
            </select>
            {preset === 'custom' && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  value={customW}
                  onChange={(e) => setCustomW(e.target.value.replace(/[^\d]/g, ''))}
                  className={`${INPUT_CLASS} w-20 text-center`}
                  placeholder="W"
                  inputMode="numeric"
                />
                <span className="text-xs text-ink-500">×</span>
                <input
                  value={customH}
                  onChange={(e) => setCustomH(e.target.value.replace(/[^\d]/g, ''))}
                  className={`${INPUT_CLASS} w-20 text-center`}
                  placeholder="H"
                  inputMode="numeric"
                />
                <span className="text-[11px] text-ink-500">
                  {t('deviceManager.wizard.screenRangeHint', { min: SCREEN_MIN, max: SCREEN_MAX })}
                </span>
              </div>
            )}
          </FormRow>

          <FormRow label="PSRAM">
            <select
              value={psramMB}
              disabled={!cap.psram}
              onChange={(e) => setPsramMB(Number(e.target.value))}
              className={SELECT_CLASS}
              title={cap.psram ? undefined : t('deviceManager.wizard.psramUnsupported')}
            >
              {cap.psramOptionsMB.map((mb) => (
                <option key={mb} value={mb}>
                  {mb === 0 ? t('deviceManager.wizard.psramNone') : `${mb} MB`}
                </option>
              ))}
            </select>
            {!cap.psram && (
              <div className="mt-1 text-[11px] text-ink-500">{t('deviceManager.wizard.psramUnsupported')}</div>
            )}
          </FormRow>

          <FormRow label="Flash">
            <select value={flashMB} onChange={(e) => setFlashMB(Number(e.target.value))} className={SELECT_CLASS}>
              {FLASH_OPTIONS_MB.map((mb) => (
                <option key={mb} value={mb}>
                  {mb} MB
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label={t('deviceManager.wizard.note')}>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className={`${INPUT_CLASS} resize-none`}
              placeholder={t('deviceManager.wizard.notePlaceholder')}
            />
          </FormRow>

          {error && (
            <div className="flex items-center gap-1.5 pl-[108px] text-xs text-red-400">
              <LuCircleAlert className="shrink-0" />
              <span>{t(`deviceManager.errors.${error}`, { min: SCREEN_MIN, max: SCREEN_MAX })}</span>
            </div>
          )}
        </div>

        {/* 按钮行 */}
        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-2.5">
          <button
            onClick={closeWizard}
            className="rounded border border-ink-500 px-3 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
          >
            {t('common.cancel')}
          </button>
          <button
            disabled={saving}
            onClick={() => void submit()}
            className="rounded bg-accent-dim px-3 py-1 text-[13px] text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {editing ? t('common.ok') : t('deviceManager.wizard.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 向导宿主(App 挂载一次;openDeviceWizard 触发) */
export function DeviceWizardHost(): React.JSX.Element | null {
  const state = useSyncExternalStore(wizardStore.subscribe, wizardStore.get)
  if (!state.open) return null
  // key 保证「编辑 A → 关闭 → 新建」时表单状态重置
  return <WizardForm key={state.initial?.id ?? '__new__'} initial={state.initial} />
}
