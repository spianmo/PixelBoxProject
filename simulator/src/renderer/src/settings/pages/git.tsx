/**
 * 设置页:工具 › Git(版本控制)
 * git 可执行路径覆盖(留空自动检测,草稿实时检测回显版本;写法照 toolchain.tsx)
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuCircleCheck } from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { GitDetectResult } from '../../../../shared/ipc-types'
import type { SettingsPage } from '../registry'
import { CAT_TOOLS } from '../categories'
import { SettingsSection, TextField } from '../controls'
import { useDraftValue } from '../draft'

/** git 检测状态行(版本 / 未找到 → i18n) */
function DetectStatus({ info }: { info: GitDetectResult | null }): React.JSX.Element {
  const { t } = useTranslation()
  if (!info) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-jb-muted">
        <VscLoading className="animate-spin" />
        {t('git.settings.detecting')}
      </span>
    )
  }
  if (info.found) {
    return (
      <span className="flex items-start gap-1.5 text-[11px] text-green-400/90">
        <LuCircleCheck className="mt-0.5 shrink-0" />
        <span className="break-all">
          {t('git.settings.detected', { version: info.version ?? '?', path: info.path })}
        </span>
      </span>
    )
  }
  return (
    <span className="flex items-start gap-1.5 text-[11px] text-red-400">
      <LuCircleAlert className="mt-0.5 shrink-0" />
      <span className="break-all">{t('git.settings.notFound')}</span>
    </span>
  )
}

function GitPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [gitPath] = useDraftValue<string>('git.executablePath')
  const [info, setInfo] = useState<GitDetectResult | null>(null)

  // 草稿路径实时检测(400ms 去抖;传草稿值试探,不落盘)
  useEffect(() => {
    setInfo(null)
    let alive = true
    const timer = window.setTimeout(() => {
      void window.api
        .gitDetect(gitPath)
        .then((r) => {
          if (alive) setInfo(r)
        })
        .catch(() => undefined)
    }, 400)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [gitPath])

  return (
    <div>
      <SettingsSection title={t('git.settings.group')}>
        <TextField
          path="git.executablePath"
          label={t('git.settings.path')}
          placeholder={t('git.settings.pathPlaceholder')}
          mono
          hint={<DetectStatus info={info} />}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'git',
  category: [CAT_TOOLS],
  titleKey: 'settings.page.git',
  keywords: ['git', '版本控制', '分支', '提交', '推送', 'vcs', 'version control', 'branch', 'commit', 'push', 'pull'],
  order: 15,
  Component: GitPage
}
