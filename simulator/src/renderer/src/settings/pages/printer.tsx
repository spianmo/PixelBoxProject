/**
 * 设置页:工具 › 3D 打印机(OctoPrint / Moonraker,IDE v3)
 * 类型 / 服务地址 / API Key + 测试连接(printer:test 读「已应用」设置,草稿需先 Apply)
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuCircleCheck } from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type { SettingsPage } from '../registry'
import { CAT_TOOLS } from '../categories'
import { SettingsSection, SelectField, TextField, FieldHint } from '../controls'
import { useDraftValue } from '../draft'

/** API Key 输入(密文;controls.tsx TextField 无 password 形态,页内按同样式实现) */
function PasswordField(props: { path: string; label: string; hint?: string }): React.JSX.Element {
  const [value, setValue] = useDraftValue<string>(props.path)
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="w-32 shrink-0 text-[13px] text-jb-text">{props.label}</span>
        <input
          type="password"
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent"
        />
      </div>
      {props.hint && (
        <div className="ml-[140px]">
          <FieldHint>{props.hint}</FieldHint>
        </div>
      )}
    </div>
  )
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; info: string }
  | { status: 'error'; code: string; raw: string }

/** 测试连接结果行(设置窗无 ToastHost,结果就地回显,形态同 toolchain 页 DetectStatus) */
function TestStatus({ state }: { state: TestState }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (state.status === 'idle') return null
  if (state.status === 'testing') {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-jb-muted">
        <VscLoading className="animate-spin" />
        {t('settings.printer.testing')}
      </span>
    )
  }
  if (state.status === 'ok') {
    return (
      <span className="flex items-start gap-1.5 text-[11px] text-green-400/90">
        <LuCircleCheck className="mt-0.5 shrink-0" />
        <span className="break-all">{t('settings.printer.testOk', { info: state.info })}</span>
      </span>
    )
  }
  return (
    <span className="flex items-start gap-1.5 text-[11px] text-red-400">
      <LuCircleAlert className="mt-0.5 shrink-0" />
      <span className="break-all">
        {t(`printer.errors.${state.code}`, { defaultValue: state.raw })}
      </span>
    </span>
  )
}

function PrinterPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  /** 测试连接:成功回显服务器版本/状态串,失败按 printer:<code> 映射 i18n */
  const runTest = async (): Promise<void> => {
    setTest({ status: 'testing' })
    try {
      const info = await window.api.printerTest()
      setTest({ status: 'ok', info })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const code = /printer:(\w+)/.exec(raw)?.[1] ?? 'requestFailed'
      setTest({ status: 'error', code, raw })
    }
  }

  return (
    <div>
      <SettingsSection title={t('settings.printer.section')}>
        <SelectField
          path="printer.type"
          label={t('settings.printer.type')}
          options={[
            { value: 'octoprint', label: 'OctoPrint' },
            { value: 'moonraker', label: 'Moonraker' }
          ]}
        />
        <TextField
          path="printer.baseUrl"
          label={t('settings.printer.baseUrl')}
          placeholder={t('settings.printer.baseUrlPlaceholder')}
          mono
          hint={t('settings.printer.baseUrlHint')}
        />
        <PasswordField
          path="printer.apiKey"
          label={t('settings.printer.apiKey')}
          hint={t('settings.printer.apiKeyHint')}
        />
        {/* 测试连接(printer:test 读已落盘设置,修改后先点「应用」) */}
        <div>
          <div className="flex items-center gap-3">
            <span className="w-32 shrink-0" />
            <button
              disabled={test.status === 'testing'}
              onClick={() => void runTest()}
              className={`flex items-center gap-1.5 rounded border border-ink-600 px-3 py-1 text-[13px] ${
                test.status === 'testing'
                  ? 'cursor-not-allowed text-ink-500'
                  : 'text-jb-text hover:bg-ink-800'
              }`}
            >
              {t('settings.printer.test')}
            </button>
          </div>
          <div className="ml-[140px] mt-1.5">
            <TestStatus state={test} />
            <FieldHint>{t('settings.printer.testHint')}</FieldHint>
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}

export const page: SettingsPage = {
  id: 'printer',
  category: [CAT_TOOLS],
  titleKey: 'settings.page.printer',
  keywords: [
    '打印机',
    '3d 打印',
    '打印',
    '上传',
    'printer',
    '3d print',
    'octoprint',
    'moonraker',
    'gcode',
    'api key'
  ],
  order: 20,
  Component: PrinterPage
}
