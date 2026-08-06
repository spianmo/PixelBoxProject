/**
 * 设置页:外观与行为 › 外观
 * 界面语言(设置窗口内立即预览,Apply 落盘)+ 主题(深色;亮色规划中 disabled)
 */
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { CAT_APPEARANCE_BEHAVIOR } from '../categories'
import { SettingsSection, SelectField } from '../controls'

function AppearancePage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SettingsSection title={t('settings.appearance.sectionUi')}>
        <SelectField
          path="appearance.language"
          label={t('settings.appearance.language')}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en', label: 'English' }
          ]}
          hint={t('settings.appearance.languageHint')}
        />
        <SelectField
          path="appearance.theme"
          label={t('settings.appearance.theme')}
          options={[
            { value: 'dark', label: t('settings.appearance.themeDark') },
            // 亮色项 disabled:主题规划中(色板已 CSS 变量化,阶段 2 切 :root 变量)
            { value: 'light', label: t('settings.appearance.themeLight'), disabled: true }
          ]}
          hint={t('settings.appearance.themeHint')}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'appearance',
  category: [CAT_APPEARANCE_BEHAVIOR],
  titleKey: 'settings.page.appearance',
  keywords: ['外观', '语言', '主题', '中文', 'appearance', 'language', 'theme', 'dark', 'light'],
  order: 10,
  Component: AppearancePage
}
