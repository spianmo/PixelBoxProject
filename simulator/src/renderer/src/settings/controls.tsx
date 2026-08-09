/**
 * 设置页表单控件(JetBrains 表单风,紧凑密度)
 *
 * - SettingsSection:分节标题 + 横线
 * - CheckboxField / SelectField / TextField:统一「控件 + 下方灰色小字说明」形态,
 *   全部经 useDraftValue 读写草稿(Apply 才落盘,见 draft.tsx)
 * - 只读展示(快捷键表等)由页面自行排版
 */
import { useId } from 'react'
import { useDraftValue } from './draft'

/** 分节:标题 + 右侧延展横线(JetBrains 设置页分组样式) */
export function SettingsSection(props: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-3">
        <span className="shrink-0 text-[13px] font-medium text-jb-text">{props.title}</span>
        <div className="h-px flex-1 bg-ink-700" />
      </div>
      <div className="space-y-4 pl-0.5">{props.children}</div>
    </div>
  )
}

/** 控件下方灰色小字说明 */
export function FieldHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mt-1 text-[11px] leading-4 text-ink-500">{children}</div>
}

/** 勾选项(说明文字在下一行,整行可点) */
export function CheckboxField(props: {
  path: string
  label: string
  hint?: string
  disabled?: boolean
}): React.JSX.Element {
  const [value, setValue] = useDraftValue<boolean>(props.path)
  return (
    <div>
      <label
        className={`flex items-center gap-2 text-[13px] ${
          props.disabled ? 'cursor-not-allowed text-ink-500' : 'cursor-pointer text-jb-text'
        }`}
      >
        <input
          type="checkbox"
          className="accent-[#3574F0]"
          checked={value}
          disabled={props.disabled}
          onChange={(e) => setValue(e.target.checked)}
        />
        {props.label}
      </label>
      {props.hint && <div className="ml-[22px]">{<FieldHint>{props.hint}</FieldHint>}</div>}
    </div>
  )
}

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

/** 下拉项(标签在左,JetBrains 组合框行) */
export function SelectField<T extends string | number>(props: {
  path: string
  label: string
  options: Array<SelectOption<T>>
  hint?: string
  /** 值为数字时需转换(schema 校验按类型区分) */
  numeric?: boolean
  width?: number
}): React.JSX.Element {
  const [value, setValue] = useDraftValue<T>(props.path)
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="w-32 shrink-0 text-[13px] text-jb-text">{props.label}</span>
        <select
          value={String(value)}
          onChange={(e) =>
            setValue((props.numeric ? Number(e.target.value) : e.target.value) as T)
          }
          style={{ width: props.width ?? 220 }}
          className="rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] text-jb-text outline-none focus:border-accent"
        >
          {props.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {props.hint && <div className="ml-[140px]">{<FieldHint>{props.hint}</FieldHint>}</div>}
    </div>
  )
}

/** 文本项(标签在左;宽输入框;suggestions 提供 datalist 候选,仍可自由输入) */
export function TextField(props: {
  path: string
  label: string
  placeholder?: string
  hint?: React.ReactNode
  mono?: boolean
  suggestions?: string[]
}): React.JSX.Element {
  const [value, setValue] = useDraftValue<string>(props.path)
  const listId = useId()
  const hasList = (props.suggestions?.length ?? 0) > 0
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="w-32 shrink-0 text-[13px] text-jb-text">{props.label}</span>
        <input
          value={value}
          placeholder={props.placeholder}
          spellCheck={false}
          list={hasList ? listId : undefined}
          onChange={(e) => setValue(e.target.value)}
          className={`min-w-0 flex-1 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent ${
            props.mono ? 'font-mono' : ''
          }`}
        />
        {hasList && (
          <datalist id={listId}>
            {props.suggestions!.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      {props.hint && <div className="ml-[140px]">{<FieldHint>{props.hint}</FieldHint>}</div>}
    </div>
  )
}
