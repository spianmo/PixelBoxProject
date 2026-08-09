/**
 * 设置页:工具 › 终端(分节对齐 JetBrains:字体设置 / 应用程序设置)
 * 字体族/字号/行高对已开会话即时生效;shell 覆盖留空用 $SHELL,仅对新建会话生效
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { CAT_TOOLS } from '../categories'
import { SettingsSection, SelectField, TextField } from '../controls'
import { detectMonoFonts } from '../fontDetect'
import {
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_LINE_HEIGHT_RANGE
} from '../../../../shared/settingsSchema'

const FONT_SIZES = Array.from(
  { length: TERMINAL_FONT_SIZE_RANGE.max - TERMINAL_FONT_SIZE_RANGE.min + 1 },
  (_v, i) => TERMINAL_FONT_SIZE_RANGE.min + i
)

// 1.0-2.0 的 0.1 步进档位(schema 校验器同步进规范化)
const LINE_HEIGHTS = Array.from(
  { length: Math.round((TERMINAL_LINE_HEIGHT_RANGE.max - TERMINAL_LINE_HEIGHT_RANGE.min) * 10) + 1 },
  (_v, i) => Math.round((TERMINAL_LINE_HEIGHT_RANGE.min + i * 0.1) * 10) / 10
)

function TerminalPage(): React.JSX.Element {
  const { t } = useTranslation()
  const monoFonts = useMemo(() => detectMonoFonts(), [])
  return (
    <div>
      <SettingsSection title={t('settings.terminal.sectionFont')}>
        <TextField
          path="terminal.fontFamily"
          label={t('settings.terminal.fontFamily')}
          placeholder="JetBrains Mono"
          mono
          suggestions={monoFonts}
          hint={t('settings.terminal.fontFamilyHint')}
        />
        <SelectField
          path="terminal.fontSize"
          label={t('settings.terminal.fontSize')}
          numeric
          width={120}
          options={FONT_SIZES.map((n) => ({ value: n, label: String(n) }))}
          hint={t('settings.terminal.fontSizeHint')}
        />
        <SelectField
          path="terminal.lineHeight"
          label={t('settings.terminal.lineHeight')}
          numeric
          width={120}
          options={LINE_HEIGHTS.map((n) => ({ value: n, label: n.toFixed(1) }))}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.terminal.sectionApp')}>
        <TextField
          path="terminal.shellOverride"
          label={t('settings.terminal.shellOverride')}
          placeholder={t('settings.terminal.shellOverridePlaceholder')}
          mono
          hint={t('settings.terminal.shellOverrideHint')}
        />
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'terminal',
  category: [CAT_TOOLS],
  titleKey: 'settings.page.terminal',
  keywords: [
    '终端',
    '字号',
    '字体',
    '行高',
    'shell',
    'terminal',
    'font',
    'family',
    'line height',
    'jetbrains mono',
    'zsh',
    'bash',
    'pty'
  ],
  order: 20,
  Component: TerminalPage
}
