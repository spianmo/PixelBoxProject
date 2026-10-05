/**
 * 设置页:工具 › 固件工具链(迁移自旧 SettingsModal,能力等价)
 * 两种后端独立检测(草稿实时回显版本)/ 默认目标芯片 / 烧录波特率
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuCircleCheck } from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { FirmwareBackend, ToolchainInfo } from '../../../../shared/ipc-types'
import type { SettingsPage } from '../registry'
import { CAT_TOOLS } from '../categories'
import { SettingsSection, SelectField, TextField } from '../controls'
import { useDraftValue } from '../draft'
import { CHIP_TARGETS, chipLabel } from '../../shell/store'
import { BAUD_OPTIONS } from '../../shell/FlashDialog'
import { firmwareBackendLabel } from '../../shell/firmware'

/** 后端检测状态行；路径和错误必须属于正在检测的后端，不能回退显示 ESP-IDF。 */
function DetectStatus({
  info,
  failed,
  backend
}: {
  info: ToolchainInfo | null
  failed: boolean
  backend: FirmwareBackend
}): React.JSX.Element {
  const { t } = useTranslation()
  const backendName = firmwareBackendLabel(backend)
  if (!info && !failed) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-jb-muted">
        <VscLoading className="animate-spin" />
        {t('fw.settings.detecting', { backend: backendName })}
      </span>
    )
  }
  if (info?.ok) {
    return (
      <span className="flex items-start gap-1.5 text-[11px] text-green-400/90">
        <LuCircleCheck className="mt-0.5 shrink-0" />
        <span className="break-all">
          {t('fw.settings.detected', {
            backend: backendName,
            version: info.version ?? '?',
            path: backend === 'nuttx' ? info.nuttxPath : info.idfPath
          })}
        </span>
      </span>
    )
  }
  return (
    <span className="flex items-start gap-1.5 text-[11px] text-red-400">
      <LuCircleAlert className="mt-0.5 shrink-0" />
      <span className="break-all">
        {failed
          ? t('fw.settings.detectFailed', { backend: backendName })
          : t(`fw.errors.${info?.error ?? (backend === 'nuttx' ? 'nuttxNotFound' : 'idfNotFound')}`, {
              defaultValue: t('fw.settings.detectFailed', { backend: backendName })
            })}
      </span>
    </span>
  )
}

function useToolchainDetection(path: string, backend: FirmwareBackend): {
  info: ToolchainInfo | null
  failed: boolean
} {
  const [info, setInfo] = useState<ToolchainInfo | null>(null)
  const [failed, setFailed] = useState(false)

  // 草稿路径实时检测(400ms 去抖;传草稿值试探,不落盘)
  useEffect(() => {
    setInfo(null)
    setFailed(false)
    let alive = true
    const timer = window.setTimeout(() => {
      void window.api
        .toolchainDetect(path, backend)
        .then((r) => {
          if (alive) setInfo(r)
        })
        .catch(() => {
          if (alive) setFailed(true)
        })
    }, 400)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [path, backend])
  return { info, failed }
}

function ToolchainPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [idfPath] = useDraftValue<string>('toolchain.idfPathOverride')
  const [nuttxPath] = useDraftValue<string>('toolchain.nuttxPathOverride')
  const idfDetection = useToolchainDetection(idfPath, 'esp-idf')
  const nuttxDetection = useToolchainDetection(nuttxPath, 'nuttx')

  return (
    <div>
      <SettingsSection title="ESP-IDF">
        <TextField
          path="toolchain.idfPathOverride"
          label={t('fw.settings.idfPath')}
          placeholder={t('fw.settings.idfPathPlaceholder')}
          mono
          hint={<DetectStatus {...idfDetection} backend="esp-idf" />}
        />
      </SettingsSection>
      <SettingsSection title="Apache NuttX">
        <TextField
          path="toolchain.nuttxPathOverride"
          label={t('fw.settings.nuttxPath')}
          placeholder={t('fw.settings.nuttxPathPlaceholder')}
          mono
          hint={
            <>
              <DetectStatus {...nuttxDetection} backend="nuttx" />
              <div className="mt-1">{t('fw.settings.nuttxPathHint')}</div>
            </>
          }
        />
      </SettingsSection>
      <SettingsSection title={t('fw.settings.groupToolchain')}>
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
    'nuttx',
    'simpleboot',
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
