/**
 * 设置页:编辑器(顶层页)
 * minimap / 字号 12-20 / Tab 宽度 2/4 / 字体族(默认 JetBrains Mono,字体文件阶段 2)
 * 消费方 EditorHost 订阅 settings:changed 即时 updateOptions,无需重启
 */
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { SettingsSection, CheckboxField, SelectField, TextField } from '../controls'
import { EDITOR_FONT_SIZE_RANGE } from '../../../../shared/settingsSchema'

const FONT_SIZES = Array.from(
  { length: EDITOR_FONT_SIZE_RANGE.max - EDITOR_FONT_SIZE_RANGE.min + 1 },
  (_v, i) => EDITOR_FONT_SIZE_RANGE.min + i
)

function EditorPage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SettingsSection title={t('settings.editor.sectionDisplay')}>
        <CheckboxField
          path="editor.minimap"
          label={t('settings.minimap')}
          hint={t('settings.minimapHint')}
        />
        <SelectField
          path="editor.tabSize"
          label={t('settings.editor.tabSize')}
          numeric
          width={120}
          options={[
            { value: 2, label: '2' },
            { value: 4, label: '4' }
          ]}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.editor.sectionFont')}>
        <SelectField
          path="editor.fontSize"
          label={t('settings.editor.fontSize')}
          numeric
          width={120}
          options={FONT_SIZES.map((n) => ({ value: n, label: String(n) }))}
        />
        <TextField
          path="editor.fontFamily"
          label={t('settings.editor.fontFamily')}
          placeholder="JetBrains Mono"
          mono
          hint={t('settings.editor.fontFamilyHint')}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'editor',
  category: [], // 顶层页面(JetBrains「编辑器」层级)
  titleKey: 'settings.page.editor',
  keywords: [
    '编辑器',
    '缩略图',
    '字号',
    '字体',
    '缩进',
    'editor',
    'minimap',
    'font',
    'size',
    'tab',
    'indent',
    'monaco'
  ],
  order: 20,
  Component: EditorPage
}
