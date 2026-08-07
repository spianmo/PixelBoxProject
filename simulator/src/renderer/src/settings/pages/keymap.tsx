/**
 * 设置页:快捷键(顶层页,只读键位表;自定义键位规划中)
 * 键位按当前平台展示(macOS ⌘/⌃ 记号,其他平台 Ctrl/Shift 文本)
 */
import { useTranslation } from 'react-i18next'
import type { SettingsPage } from '../registry'
import { SettingsSection, FieldHint } from '../controls'

interface KeyRow {
  /** 操作名 i18n key */
  actionKey: string
  /** macOS 键位 */
  mac: string
  /** Windows/Linux 键位 */
  other: string
}

/** 只读键位表(与 App.tsx / xtermRegistry / EditorHost 中的真实绑定一致) */
const KEY_ROWS: KeyRow[] = [
  { actionKey: 'settings.keymap.quickOpen', mac: '⌘ P / ⇧⌘ O', other: 'Ctrl+P / Ctrl+Shift+O' },
  { actionKey: 'settings.keymap.findInFile', mac: '⌘ F', other: 'Ctrl+F' },
  { actionKey: 'settings.keymap.findInFiles', mac: '⇧⌘ F', other: 'Ctrl+Shift+F' },
  { actionKey: 'settings.keymap.save', mac: '⌘ S', other: 'Ctrl+S' },
  { actionKey: 'settings.keymap.run', mac: '⌃ R', other: 'Shift+F10' },
  { actionKey: 'settings.keymap.stop', mac: '⌘ F2', other: 'Ctrl+F2' },
  { actionKey: 'settings.keymap.terminalClear', mac: '⌘ K', other: 'Ctrl+K' },
  { actionKey: 'settings.keymap.terminalSearch', mac: '⌘ F', other: 'Ctrl+F' },
  { actionKey: 'settings.keymap.escape', mac: 'Esc', other: 'Esc' }
]

function KeymapPage(): React.JSX.Element {
  const { t } = useTranslation()
  const isMac = window.api.platform === 'darwin'
  return (
    <div>
      <SettingsSection title={t('settings.page.keymap')}>
        <div className="overflow-hidden rounded border border-ink-700">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-ink-850 text-left text-[11px] uppercase tracking-wide text-ink-500">
                <th className="px-3 py-1.5 font-medium">{t('settings.keymap.colAction')}</th>
                <th className="w-40 px-3 py-1.5 font-medium">{t('settings.keymap.colKeys')}</th>
              </tr>
            </thead>
            <tbody>
              {KEY_ROWS.map((row) => (
                <tr key={row.actionKey} className="border-t border-ink-700">
                  <td className="px-3 py-1.5 text-jb-text">{t(row.actionKey)}</td>
                  <td className="px-3 py-1.5">
                    <kbd className="rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono text-xs text-jb-muted">
                      {isMac ? row.mac : row.other}
                    </kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <FieldHint>{t('settings.keymap.readonlyHint')}</FieldHint>
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'keymap',
  category: [], // 顶层页面(JetBrains「按键映射」层级)
  titleKey: 'settings.page.keymap',
  keywords: ['快捷键', '键位', '按键', 'keymap', 'shortcut', 'keyboard', 'hotkey'],
  order: 30,
  Component: KeymapPage
}
