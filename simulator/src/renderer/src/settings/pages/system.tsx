/**
 * 设置页:外观与行为 › 系统设置
 * 启动时恢复上次会话(阶段 2 消费)+ 关闭主窗口时退出应用
 */
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { CAT_APPEARANCE_BEHAVIOR } from '../categories'
import { SettingsSection, CheckboxField } from '../controls'

function SystemPage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SettingsSection title={t('settings.system.sectionStartup')}>
        <CheckboxField
          path="system.restoreSession"
          label={t('settings.system.restoreSession')}
          hint={t('settings.system.restoreSessionHint')}
        />
        <CheckboxField
          path="system.quitOnMainWindowClose"
          label={t('settings.system.quitOnClose')}
          hint={t('settings.system.quitOnCloseHint')}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'system',
  category: [CAT_APPEARANCE_BEHAVIOR],
  titleKey: 'settings.page.system',
  keywords: [
    '系统',
    '会话',
    '恢复',
    '退出',
    '关闭窗口',
    'system',
    'session',
    'restore',
    'quit',
    'exit'
  ],
  order: 20,
  Component: SystemPage
}
