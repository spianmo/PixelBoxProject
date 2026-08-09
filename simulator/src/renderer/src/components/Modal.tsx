/**
 * 简易模态框:输入框(新建/重命名)与确认框(删除)两种形态
 * Electron 渲染进程没有 window.prompt/confirm,统一走这里
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface InputModalProps {
  title: string
  placeholder?: string
  initialValue?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function InputModal({
  title,
  placeholder,
  initialValue,
  onConfirm,
  onCancel
}: InputModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = (): void => {
    const v = value.trim()
    if (v.length > 0) onConfirm(v)
  }

  return (
    <ModalShell onCancel={onCancel}>
      <div className="mb-3 text-sm font-medium text-gray-100">{title}</div>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            e.preventDefault() // 消费 Esc:全屏下的「Esc 退出全屏」让位
            onCancel()
          }
        }}
        className="mb-4 w-full rounded border border-ink-500 bg-ink-900 px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
      />
      <ModalButtons okLabel={t('common.ok')} cancelLabel={t('common.cancel')} onOk={submit} onCancel={onCancel} />
    </ModalShell>
  )
}

export interface ConfirmModalProps {
  message: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({ message, onConfirm, onCancel }: ConfirmModalProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ModalShell onCancel={onCancel}>
      <div className="mb-4 text-sm text-gray-100">{message}</div>
      <ModalButtons
        okLabel={t('common.ok')}
        cancelLabel={t('common.cancel')}
        danger
        onOk={onConfirm}
        onCancel={onCancel}
      />
    </ModalShell>
  )
}

function ModalShell({
  children,
  onCancel
}: {
  children: React.ReactNode
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-80 rounded-lg border border-ink-600 bg-ink-800 p-4 shadow-2xl">{children}</div>
    </div>
  )
}

function ModalButtons({
  okLabel,
  cancelLabel,
  danger,
  onOk,
  onCancel
}: {
  okLabel: string
  cancelLabel: string
  danger?: boolean
  onOk: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="flex justify-end gap-2">
      <button
        onClick={onCancel}
        className="rounded border border-ink-500 px-3 py-1 text-sm text-gray-300 hover:bg-ink-700"
      >
        {cancelLabel}
      </button>
      <button
        onClick={onOk}
        className={`rounded px-3 py-1 text-sm text-white ${
          danger ? 'bg-red-600 hover:bg-red-500' : 'bg-accent-dim hover:bg-accent'
        }`}
      >
        {okLabel}
      </button>
    </div>
  )
}
