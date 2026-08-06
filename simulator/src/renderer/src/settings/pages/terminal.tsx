/**
 * 设置页:工具 › 终端
 * shell 覆盖(留空用 $SHELL,仅对新建会话生效)+ 终端字号(已开会话即时生效)
 */
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { CAT_TOOLS } from '../categories'
import { SettingsSection, SelectField, TextField } from '../controls'
import { TERMINAL_FONT_SIZE_RANGE } from '../../../../shared/settingsSchema'

const FONT_SIZES = Array.from(
  { length: TERMINAL_FONT_SIZE_RANGE.max - TERMINAL_FONT_SIZE_RANGE.min + 1 },
  (_v, i) => TERMINAL_FONT_SIZE_RANGE.min + i
)

function TerminalPage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SettingsSection title={t('settings.page.terminal')}>
        <TextField
          path="terminal.shellOverride"
          label={t('settings.terminal.shellOverride')}
          placeholder={t('settings.terminal.shellOverridePlaceholder')}
          mono
          hint={t('settings.terminal.shellOverrideHint')}
        />
        <SelectField
          path="terminal.fontSize"
          label={t('settings.terminal.fontSize')}
          numeric
          width={120}
          options={FONT_SIZES.map((n) => ({ value: n, label: String(n) }))}
          hint={t('settings.terminal.fontSizeHint')}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'terminal',
  category: [CAT_TOOLS],
  titleKey: 'settings.page.terminal',
  keywords: ['终端', '字号', 'shell', 'terminal', 'font', 'zsh', 'bash', 'pty'],
  order: 20,
  Component: TerminalPage
}
