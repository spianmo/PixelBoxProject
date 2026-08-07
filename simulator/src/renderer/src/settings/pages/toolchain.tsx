/**
 * 设置页:工具 › 固件工具链(迁移自旧 SettingsModal,能力等价)
 * IDF 路径覆盖(留空自动检测,草稿实时检测回显版本)/ 默认目标芯片 / 烧录波特率
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuCircleCheck } from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { ToolchainInfo } from '../../../../shared/ipc-types'
import type { SettingsPage } from '../registry'
import { CAT_TOOLS } from '../categories'
import { SettingsSection, SelectField, TextField } from '../controls'
import { useDraftValue } from '../draft'
import { CHIP_TARGETS, chipLabel } from '../../shell/store'
import { BAUD_OPTIONS } from '../../shell/FlashDialog'

/** IDF 检测状态行(版本 / 错误码 → i18n;沿用旧 SettingsModal 的回显形态) */
function DetectStatus({ info }: { info: ToolchainInfo | null }): React.JSX.Element {
  const { t } = useTranslation()
  if (!info) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-jb-muted">
        <VscLoading className="animate-spin" />
        {t('fw.settings.detecting')}
      </span>
    )
  }
  if (info.ok) {
    return (
      <span className="flex items-start gap-1.5 text-[11px] text-green-400/90">
        <LuCircleCheck className="mt-0.5 shrink-0" />
        <span className="break-all">
          {t('fw.settings.detected', { version: info.version ?? '?', path: info.idfPath })}
        </span>
      </span>
    )
  }
  return (
    <span className="flex items-start gap-1.5 text-[11px] text-red-400">
      <LuCircleAlert className="mt-0.5 shrink-0" />
      <span className="break-all">{t(`fw.errors.${info.error ?? 'idfNotFound'}`)}</span>
    </span>
  )
}

function ToolchainPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [idfPath] = useDraftValue<string>('toolchain.idfPathOverride')
  const [info, setInfo] = useState<ToolchainInfo | null>(null)

  // 草稿路径实时检测(400ms 去抖;传草稿值试探,不落盘)
  useEffect(() => {
    setInfo(null)
    let alive = true
    const timer = window.setTimeout(() => {
      void window.api
        .toolchainDetect(idfPath)
        .then((r) => {
          if (alive) setInfo(r)
        })
        .catch(() => undefined)
    }, 400)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [idfPath])

  return (
    <div>
      <SettingsSection title={t('fw.settings.groupToolchain')}>
        <TextField
          path="toolchain.idfPathOverride"
          label={t('fw.settings.idfPath')}
          placeholder={t('fw.settings.idfPathPlaceholder')}
          mono
          hint={<DetectStatus info={info} />}
        />
        <SelectField
          path="toolchain.defaultTarget"
          label={t('fw.settings.defaultTarget')}
          options={CHIP_TARGETS.map((c) => ({ value: c, label: chipLabel(c) }))}
          hint={t('fw.settings.defaultTargetHint')}
        />
        <SelectField
          path="toolchain.baudRate"
          label={t('fw.settings.baud')}
          numeric
          width={160}
          options={BAUD_OPTIONS.map((b) => ({ value: b, label: String(b) }))}
        />
        <TextField
          path="toolchain.clangdPath"
          label={t('fw.settings.clangdPath')}
          placeholder={t('fw.settings.clangdPathPlaceholder')}
          mono
          hint={t('fw.settings.clangdPathHint')}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'toolchain',
  category: [CAT_TOOLS],
  titleKey: 'settings.page.toolchain',
  keywords: [
    '固件',
    '工具链',
    '烧录',
    '波特率',
    '芯片',
    '补全',
    'idf',
    'esp-idf',
    'toolchain',
    'firmware',
    'flash',
    'baud',
    'chip',
    'target',
    'clangd',
    'lsp',
    'completion'
  ],
  order: 10,
  Component: ToolchainPage
}
