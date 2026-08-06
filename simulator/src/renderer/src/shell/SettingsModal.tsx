/**
 * IDE 设置页(阶段 3)—— 工具链相关设置(JetBrains 表单密度)
 *
 * 字段:ESP-IDF 路径覆盖(空 = 自动检测 $IDF_PATH / ~/esp/esp-idf)/
 *       默认目标芯片 / 串口烧录波特率
 * 持久化在 main 进程 userData/pixelbox-sim/toolchain.json;
 * 保存后重新检测并回显 IDF 版本;默认目标在本地无芯片记忆时立即生效
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuCircleCheck } from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { ToolchainInfo, ToolchainSettings } from '../../../shared/ipc-types'
import { CHIP_TARGETS, applyDefaultChip, chipLabel } from './store'
import { BAUD_OPTIONS } from './FlashDialog'
import { showToast } from '../components/toast'
import { minimapEnabled, setMinimapEnabled } from '../editor/editorSettings'

const INPUT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent'
const SELECT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] text-jb-text outline-none focus:border-accent'

function FormRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="w-28 shrink-0 pt-1.5 text-right text-xs text-jb-muted">{props.label}</div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

/** IDF 检测状态行(版本 / 错误码 → i18n) */
function DetectStatus({ info }: { info: ToolchainInfo | null }): React.JSX.Element {
  const { t } = useTranslation()
  if (!info) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-jb-muted">
        <VscLoading className="animate-spin" />
        {t('fw.settings.detecting')}
      </div>
    )
  }
  if (info.ok) {
    return (
      <div className="mt-1 flex items-start gap-1.5 text-[11px] text-green-400/90">
        <LuCircleCheck className="mt-0.5 shrink-0" />
        <span className="break-all">
          {t('fw.settings.detected', { version: info.version ?? '?', path: info.idfPath })}
        </span>
      </div>
    )
  }
  return (
    <div className="mt-1 flex items-start gap-1.5 text-[11px] text-red-400">
      <LuCircleAlert className="mt-0.5 shrink-0" />
      <span className="break-all">{t(`fw.errors.${info.error ?? 'idfNotFound'}`)}</span>
    </div>
  )
}

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  const [idfPathOverride, setIdfPathOverride] = useState('')
  const [defaultTarget, setDefaultTarget] = useState('esp32s3')
  const [baudRate, setBaudRate] = useState(460800)
  const [info, setInfo] = useState<ToolchainInfo | null>(null)
  const [saving, setSaving] = useState(false)
  // 编辑器设置(localStorage 持久化,保存时写回)
  const [minimap, setMinimap] = useState(minimapEnabled())

  // 打开时读取持久化设置 + 现状检测
  useEffect(() => {
    let alive = true
    void (async (): Promise<void> => {
      try {
        const s = await window.api.toolchainSettingsGet()
        if (!alive) return
        setIdfPathOverride(s.idfPathOverride)
        setDefaultTarget(s.defaultTarget)
        setBaudRate(s.baudRate)
        setLoaded(true)
        setInfo(await window.api.toolchainDetect())
      } catch {
        if (alive) setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /** 保存 → 重新检测(检测走持久化后的覆盖路径)→ 回显结果 */
  const save = async (): Promise<void> => {
    setSaving(true)
    // 编辑器设置先落地(与工具链检测结果无关)
    setMinimapEnabled(minimap)
    try {
      const s: ToolchainSettings = { idfPathOverride: idfPathOverride.trim(), defaultTarget, baudRate }
      await window.api.toolchainSettingsSet(s)
      applyDefaultChip(defaultTarget) // 本地无芯片记忆时立即生效
      const next = await window.api.toolchainDetect()
      setInfo(next)
      showToast(
        next.ok
          ? t('fw.settings.savedOk', { version: next.version ?? '?' })
          : t('fw.settings.savedNoIdf'),
        next.ok ? 'success' : 'warn'
      )
      onClose()
    } catch (err) {
      showToast(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="w-[520px] rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="border-b border-ink-700 px-4 py-2.5 text-sm font-medium text-jb-text">
          {t('fw.settings.title')}
        </div>

        <div className="space-y-3 px-4 py-4">
          {/* 分组标题:编辑器 */}
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
            {t('settings.groupEditor')}
          </div>

          <FormRow label={t('settings.minimap')}>
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-[13px] text-jb-text">
              <input
                type="checkbox"
                className="accent-[#3574F0]"
                checked={minimap}
                onChange={(e) => setMinimap(e.target.checked)}
              />
              <span className="text-jb-muted">{t('settings.minimapHint')}</span>
            </label>
          </FormRow>

          {/* 分组标题:固件工具链 */}
          <div className="pt-1 text-[11px] font-medium uppercase tracking-wide text-ink-500">
            {t('fw.settings.groupToolchain')}
          </div>

          <FormRow label={t('fw.settings.idfPath')}>
            <input
              value={idfPathOverride}
              disabled={!loaded}
              onChange={(e) => setIdfPathOverride(e.target.value)}
              placeholder={t('fw.settings.idfPathPlaceholder')}
              className={INPUT_CLASS}
              spellCheck={false}
            />
            <DetectStatus info={info} />
          </FormRow>

          <FormRow label={t('fw.settings.defaultTarget')}>
            <select
              value={defaultTarget}
              disabled={!loaded}
              onChange={(e) => setDefaultTarget(e.target.value)}
              className={SELECT_CLASS}
            >
              {CHIP_TARGETS.map((c) => (
                <option key={c} value={c}>
                  {chipLabel(c)}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[11px] text-ink-500">{t('fw.settings.defaultTargetHint')}</div>
          </FormRow>

          <FormRow label={t('fw.settings.baud')}>
            <select
              value={baudRate}
              disabled={!loaded}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              className={SELECT_CLASS}
            >
              {BAUD_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </FormRow>
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-2.5">
          <button
            onClick={onClose}
            className="rounded border border-ink-500 px-3 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
          >
            {t('common.cancel')}
          </button>
          <button
            disabled={saving || !loaded}
            onClick={() => void save()}
            className="rounded bg-accent-dim px-3 py-1 text-[13px] text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('fw.settings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
