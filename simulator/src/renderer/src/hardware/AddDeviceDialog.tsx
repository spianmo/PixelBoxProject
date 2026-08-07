/**
 * 「添加到模拟器」对话框:把当前硬件设计(板卡+外壳+屏幕放置)注册为设备档案
 *
 * - 名称默认「<项目名> 板卡」(project:info 取 manifest 名,回退目录名)
 * - 芯片默认取工程 manifest.chip(非法/缺省回退 esp32s3);PSRAM 档位随芯片能力收敛
 * - 分辨率默认 480x480(微雪 ESP32-S3-Touch-AMOLED-2.16 实机屏幕),psram/flash 默认 8/16
 * - 提交:saveDeviceProfile({...档案, hardware3d: {board, enclosure, screen, designRoot}})
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert } from 'react-icons/lu'
import type { DeviceProfile } from '../../../shared/ipc-types'
import {
  CHIP_CAPABILITIES,
  CHIP_IDS,
  FLASH_OPTIONS_MB,
  SCREEN_MAX,
  SCREEN_MIN,
  chipCapability,
  validateProfileFields
} from '../../../shared/chipCapabilities'
import { saveDeviceProfile } from '../shell/store'
import { showToast } from '../components/toast'
import { useHardware } from './store'

const INPUT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent'
const SELECT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] text-jb-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:text-ink-500'

function FormRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="w-24 shrink-0 pt-1.5 text-right text-xs text-jb-muted">{props.label}</div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

export function AddDeviceDialog(props: {
  workspaceRoot: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { boardSpec, screen, scad } = useHardware()

  const folderName = useMemo(
    () => props.workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'board',
    [props.workspaceRoot]
  )

  const [name, setName] = useState(() => t('hw.addDevice.defaultName', { name: folderName }))
  const [chip, setChip] = useState('esp32s3')
  const [screenW, setScreenW] = useState('480')
  const [screenH, setScreenH] = useState('480')
  const [psramMB, setPsramMB] = useState(8)
  const [flashMB, setFlashMB] = useState(16)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 用户改过的字段不再被 project:info 异步默认值覆盖 */
  const nameTouched = useRef(false)
  const chipTouched = useRef(false)

  const cap = useMemo(() => chipCapability(chip), [chip])

  // 工程信息 → 默认名称/芯片(异步到达,仅覆盖未被用户编辑过的字段)
  useEffect(() => {
    let cancelled = false
    window.api
      .projectInfo(props.workspaceRoot)
      .then((info) => {
        if (cancelled) return
        if (!nameTouched.current && info.name) {
          setName(t('hw.addDevice.defaultName', { name: info.name }))
        }
        if (!chipTouched.current && info.chip && (CHIP_IDS as readonly string[]).includes(info.chip)) {
          setChip(info.chip)
          if (!chipCapability(info.chip).psram) setPsramMB(0)
        }
      })
      .catch(() => {
        // 读取失败保持目录名默认值
      })
    return () => {
      cancelled = true
    }
  }, [props.workspaceRoot, t])

  const onChipChange = (next: string): void => {
    chipTouched.current = true
    setChip(next)
    const nextCap = chipCapability(next)
    if (!nextCap.psramOptionsMB.includes(psramMB)) setPsramMB(nextCap.psram ? 8 : 0)
  }

  const submit = async (): Promise<void> => {
    if (!boardSpec) {
      setError('needBoard')
      return
    }
    const profile: DeviceProfile = {
      id: '',
      name: name.trim(),
      chip,
      screenW: Number(screenW),
      screenH: Number(screenH),
      psramMB: cap.psram ? psramMB : 0,
      flashMB,
      note: '',
      createdAt: 0,
      hardware3d: {
        board: boardSpec,
        // OpenSCAD 外壳编译产物(b64 可 JSON 落盘;enclosure 参数字段已随
        // enclosure.json 退役,仅旧档案读取路径还认它)
        ...(scad ? { scad } : {}),
        screen: screen ?? undefined,
        designRoot: props.workspaceRoot
      }
    }
    const code = validateProfileFields(profile)
    if (code) {
      setError(code)
      return
    }
    setSaving(true)
    const err = await saveDeviceProfile(profile)
    setSaving(false)
    if (err) {
      const m = /profile:(\w+)/.exec(err)
      setError(m ? m[1] : 'saveFailed')
      return
    }
    showToast(t('hw.addDevice.added', { name: profile.name }), 'success')
    props.onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose()
      }}
    >
      <div className="w-[420px] rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="border-b border-ink-700 px-4 py-2.5 text-sm font-medium text-jb-text">
          {t('hw.addDevice.title')}
        </div>

        <div className="space-y-3 px-4 py-4">
          <FormRow label={t('hw.addDevice.name')}>
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                nameTouched.current = true
                setName(e.target.value)
              }}
              className={INPUT_CLASS}
              spellCheck={false}
            />
          </FormRow>

          <FormRow label={t('hw.addDevice.chip')}>
            <select value={chip} onChange={(e) => onChipChange(e.target.value)} className={SELECT_CLASS}>
              {CHIP_CAPABILITIES.map((c) => (
                <option key={c.chip} value={c.chip}>
                  {c.label}
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label={t('hw.addDevice.screen')}>
            <div className="flex items-center gap-1.5">
              <input
                value={screenW}
                onChange={(e) => setScreenW(e.target.value.replace(/[^\d]/g, ''))}
                className={`${INPUT_CLASS} w-20 text-center`}
                placeholder="W"
                inputMode="numeric"
              />
              <span className="text-xs text-ink-500">×</span>
              <input
                value={screenH}
                onChange={(e) => setScreenH(e.target.value.replace(/[^\d]/g, ''))}
                className={`${INPUT_CLASS} w-20 text-center`}
                placeholder="H"
                inputMode="numeric"
              />
            </div>
          </FormRow>

          <FormRow label="PSRAM">
            <select
              value={psramMB}
              disabled={!cap.psram}
              onChange={(e) => setPsramMB(Number(e.target.value))}
              className={SELECT_CLASS}
            >
              {cap.psramOptionsMB.map((mb) => (
                <option key={mb} value={mb}>
                  {mb === 0 ? t('deviceManager.wizard.psramNone') : `${mb} MB`}
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label="Flash">
            <select
              value={flashMB}
              onChange={(e) => setFlashMB(Number(e.target.value))}
              className={SELECT_CLASS}
            >
              {FLASH_OPTIONS_MB.map((mb) => (
                <option key={mb} value={mb}>
                  {mb} MB
                </option>
              ))}
            </select>
          </FormRow>

          {!boardSpec && (
            <div className="flex items-center gap-1.5 pl-[108px] text-xs text-yellow-300/90">
              <LuCircleAlert className="shrink-0" />
              <span>{t('hw.addDevice.needBoard')}</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-1.5 pl-[108px] text-xs text-red-400">
              <LuCircleAlert className="shrink-0" />
              <span>
                {error === 'needBoard'
                  ? t('hw.addDevice.needBoard')
                  : t(`deviceManager.errors.${error}`, { min: SCREEN_MIN, max: SCREEN_MAX })}
              </span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-2.5">
          <button
            onClick={props.onClose}
            className="rounded border border-ink-500 px-3 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
          >
            {t('common.cancel')}
          </button>
          <button
            disabled={saving || !boardSpec}
            onClick={() => void submit()}
            className="rounded bg-accent-dim px-3 py-1 text-[13px] text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('hw.addDevice.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
