/**
 * 设置页:外观与行为 › 外观
 * 界面语言(设置窗口内立即预览,Apply 落盘)+ 主题(深色 / 亮色 / 跟随系统;
 * Apply 落盘后 settings:changed 广播,主题管理器全窗口即时切换,无需重启)
 */
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { CAT_APPEARANCE_BEHAVIOR } from '../categories'
import { SettingsSection, SelectField, CheckboxField } from '../controls'

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
            { value: 'light', label: t('settings.appearance.themeLight') },
            // 跟随系统:main 侧 nativeTheme 解析,系统深浅切换时全窗口即时跟随
            { value: 'system', label: t('settings.appearance.themeSystem') }
          ]}
          hint={t('settings.appearance.themeHint')}
        />
        <CheckboxField
          path="appearance.show3dAxes"
          label={t('settings.appearance.show3dAxes')}
          hint={t('settings.appearance.show3dAxesHint')}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'appearance',
  category: [CAT_APPEARANCE_BEHAVIOR],
  titleKey: 'settings.page.appearance',
  keywords: ['外观', '语言', '主题', '中文', '坐标轴', 'appearance', 'language', 'theme', 'dark', 'light', 'axes', '3d'],
  order: 10,
  Component: AppearancePage
}
