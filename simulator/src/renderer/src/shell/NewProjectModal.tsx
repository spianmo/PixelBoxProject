/**
 * 新建项目向导(JetBrains IntelliJ「New Project」风格,标题栏项目下拉「新建项目…」触发)
 *
 * 布局:720×480 左右分栏 —— 左栏 190px 项目类型列表(应用 / 固件 / 硬件设计,选中 bg-accent 整行高亮),
 *       右栏表单:名称(自动聚焦,[a-zA-Z0-9_-] 实时校验)/ 位置(输入 + 📁 选择,灰字「项目将创建于:…」)/
 *       分隔线后按类型:app → 模板分段控件 + 应用 ID(默认 com.example.<名称>,手动改过不再跟随);
 *       firmware|hardware → 目标芯片分段控件(默认 esp32s3)。
 * 创建走 main 进程 project:create;错误码 project:<code> 映射 newProject.errors.*;Esc 关闭、Enter 提交。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircuitBoard, LuCpu, LuFolderOpen, LuLayoutTemplate } from 'react-icons/lu'
import { VscLoading } from 'react-icons/vsc'
import type {
  ProjectCreateOptions,
  ProjectCreateResult,
  ProjectKind,
  ProjectTemplate
} from '../../../shared/ipc-types'
import { showToast } from '../components/toast'
import { CHIP_TARGETS, chipLabel, type ChipTarget } from './store'

const NAME_RE = /^[a-zA-Z0-9_-]+$/
const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/

const INPUT_CLASS =
  'h-7 w-full rounded border border-ink-600 bg-ink-900 px-2 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent'

function FormRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="w-20 shrink-0 pt-1.5 text-right text-xs text-jb-muted">{props.label}</div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

/** JetBrains 风格分段控件(单选按钮组,选中 bg-accent) */
function Segmented<T extends string>(props: {
  options: Array<{ value: T; label: string; title?: string }>
  value: T
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="inline-flex overflow-hidden rounded border border-ink-600">
      {props.options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          title={opt.title}
          onClick={() => props.onChange(opt.value)}
          className={`h-7 px-3 text-[13px] transition-colors ${i > 0 ? 'border-l border-ink-600' : ''} ${
            props.value === opt.value ? 'bg-accent text-white' : 'text-gray-300 hover:bg-ink-700'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/** 应用 ID 默认值:com.example.<名称小写>(名称非法段兜底 app) */
function defaultAppId(name: string): string {
  const seg = name.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return `com.example.${seg || 'app'}`
}

/** 「项目将创建于」预览路径:位置 + 分隔符 + 名称(Windows 反斜杠路径沿用反斜杠) */
function joinPath(location: string, name: string): string {
  const loc = location.trim().replace(/[\\/]+$/, '')
  if (!name) return loc
  const sep = loc.includes('\\') && !loc.includes('/') ? '\\' : '/'
  return loc ? `${loc}${sep}${name}` : name
}

interface Props {
  /** 创建成功(root/kind/entryFile 由 main 进程返回;上层负责打开工作区与入口文件) */
  onCreated: (result: ProjectCreateResult) => void
  onClose: () => void
}

export function NewProjectModal({ onCreated, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [kind, setKind] = useState<ProjectKind>('app')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [template, setTemplate] = useState<ProjectTemplate>('hello')
  const [appId, setAppId] = useState(defaultAppId(''))
  /** 应用 ID 被手动编辑后不再跟随名称 */
  const [appIdTouched, setAppIdTouched] = useState(false)
  const [chip, setChip] = useState<ChipTarget>('esp32s3')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // 默认位置 ~/PixelBoxProjects(main 进程给绝对路径)
  useEffect(() => {
    nameRef.current?.focus()
    window.api
      .projectDefaultLocation()
      .then(setLocation)
      .catch(() => undefined)
  }, [])

  const trimmedName = name.trim()
  const nameInvalid = trimmedName.length > 0 && !NAME_RE.test(trimmedName)
  const valid =
    NAME_RE.test(trimmedName) &&
    location.trim().length > 0 &&
    (kind !== 'app' || APP_ID_RE.test(appId.trim()))

  const changeName = (v: string): void => {
    setName(v)
    setError(null)
    if (!appIdTouched) setAppId(defaultAppId(v.trim()))
  }

  const browse = async (): Promise<void> => {
    const dir = await window.api.chooseDirectory(location || undefined)
    if (dir) setLocation(dir)
  }

  /** 提交前的本地校验(与 main 进程二次校验同规则) */
  const validate = (): string | null => {
    if (trimmedName.length === 0) return t('newProject.errors.nameRequired')
    if (!NAME_RE.test(trimmedName)) return t('newProject.errors.nameInvalid')
    if (location.trim().length === 0) return t('newProject.errors.locationRequired')
    if (kind === 'app' && !APP_ID_RE.test(appId.trim())) return t('newProject.errors.appIdInvalid')
    return null
  }

  const create = async (): Promise<void> => {
    if (creating) return
    const msg = validate()
    if (msg) {
      setError(msg)
      return
    }
    setCreating(true)
    try {
      const opts: ProjectCreateOptions =
        kind === 'app'
          ? { kind, name: trimmedName, location: location.trim(), appId: appId.trim(), template }
          : { kind, name: trimmedName, location: location.trim(), chip }
      const result = await window.api.projectCreate(opts)
      showToast(t('newProject.created', { name: trimmedName }), 'success')
      onCreated(result)
    } catch (err) {
      // main 进程以 project:<code> 抛错 → 映射 i18n
      const raw = err instanceof Error ? err.message : String(err)
      const code = /project:(\w+)/.exec(raw)?.[1]
      setError(
        code
          ? t(`newProject.errors.${code}`, { defaultValue: t('newProject.errors.createFailed') })
          : t('newProject.errors.createFailed')
      )
    } finally {
      setCreating(false)
    }
  }

  /** 文本输入内 Enter 提交(有效时) */
  const submitOnEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && valid) void create()
  }

  const kinds: Array<{ key: ProjectKind; icon: React.ReactNode; label: string; desc: string }> = [
    {
      key: 'app',
      icon: <LuLayoutTemplate className="text-[16px]" />,
      label: t('newProject.kinds.app'),
      desc: t('newProject.kinds.appDesc')
    },
    {
      key: 'firmware',
      icon: <LuCpu className="text-[16px]" />,
      label: t('newProject.kinds.firmware'),
      desc: t('newProject.kinds.firmwareDesc')
    },
    {
      key: 'hardware',
      icon: <LuCircuitBoard className="text-[16px]" />,
      label: t('newProject.kinds.hardware'),
      desc: t('newProject.kinds.hardwareDesc')
    }
  ]

  const templates: Array<{ value: ProjectTemplate; label: string; title: string }> = [
    { value: 'hello', label: t('newProject.templateHello'), title: t('newProject.templateHelloDesc') },
    { value: 'blank', label: t('newProject.templateBlank'), title: t('newProject.templateBlankDesc') }
  ]

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="flex h-[480px] w-[720px] flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="flex min-h-0 flex-1">
          {/* 左栏:项目类型列表 */}
          <aside className="flex w-[190px] shrink-0 flex-col border-r border-ink-700 bg-ink-900">
            <div className="px-3 pb-1.5 pt-3 text-sm font-medium text-jb-text">
              {t('newProject.title')}
            </div>
            <div className="flex-1 overflow-y-auto py-1" role="listbox" aria-label={t('newProject.title')}>
              {kinds.map((k) => {
                const selected = kind === k.key
                return (
                  <button
                    key={k.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    title={k.desc}
                    onClick={() => {
                      setKind(k.key)
                      setError(null)
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                      selected ? 'bg-accent text-white' : 'text-jb-text hover:bg-ink-700'
                    }`}
                  >
                    <span className={`mt-0.5 shrink-0 ${selected ? 'text-white' : 'text-jb-muted'}`}>
                      {k.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] leading-5">{k.label}</span>
                      <span
                        className={`block truncate text-[11px] leading-4 ${
                          selected ? 'text-white/70' : 'text-jb-muted'
                        }`}
                      >
                        {k.desc}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>

          {/* 右栏:表单 */}
          <section className="min-w-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            <FormRow label={t('newProject.name')}>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => changeName(e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={t('newProject.namePlaceholder')}
                className={`${INPUT_CLASS} ${nameInvalid ? 'border-red-500 focus:border-red-500' : ''}`}
                spellCheck={false}
              />
              <div className={`mt-1 text-[11px] ${nameInvalid ? 'text-red-400' : 'text-ink-500'}`}>
                {nameInvalid ? t('newProject.errors.nameInvalid') : t('newProject.nameHint')}
              </div>
            </FormRow>

            <FormRow label={t('newProject.location')}>
              <div className="flex gap-2">
                <input
                  value={location}
                  onChange={(e) => {
                    setLocation(e.target.value)
                    setError(null)
                  }}
                  onKeyDown={submitOnEnter}
                  className={INPUT_CLASS}
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => void browse()}
                  title={t('newProject.browse')}
                  aria-label={t('newProject.browse')}
                  className="flex h-7 w-8 shrink-0 items-center justify-center rounded border border-ink-500 text-gray-300 hover:bg-ink-700"
                >
                  <LuFolderOpen className="text-[14px]" />
                </button>
              </div>
              <div className="mt-1 truncate text-[11px] text-ink-500" title={joinPath(location, trimmedName)}>
                {t('newProject.createIn', { path: joinPath(location, trimmedName) })}
              </div>
            </FormRow>

            <div className="border-t border-ink-700" />

            {kind === 'app' ? (
              <>
                <FormRow label={t('newProject.template')}>
                  <Segmented options={templates} value={template} onChange={setTemplate} />
                  <div className="mt-1 text-[11px] text-ink-500">
                    {template === 'hello'
                      ? t('newProject.templateHelloDesc')
                      : t('newProject.templateBlankDesc')}
                  </div>
                </FormRow>

                <FormRow label={t('newProject.appId')}>
                  <input
                    value={appId}
                    onChange={(e) => {
                      setAppId(e.target.value)
                      setAppIdTouched(true)
                      setError(null)
                    }}
                    onKeyDown={submitOnEnter}
                    className={`${INPUT_CLASS} font-mono`}
                    spellCheck={false}
                  />
                  <div className="mt-1 text-[11px] text-ink-500">{t('newProject.appIdHint')}</div>
                </FormRow>
              </>
            ) : (
              <FormRow label={t('newProject.chip')}>
                <Segmented
                  options={CHIP_TARGETS.map((c) => ({ value: c, label: chipLabel(c) }))}
                  value={chip}
                  onChange={setChip}
                />
                <div className="mt-1 text-[11px] text-ink-500">{t('newProject.chipHint')}</div>
              </FormRow>
            )}
          </section>
        </div>

        {/* 底部操作栏:左侧错误信息,右侧 取消/创建 */}
        <div className="flex items-center gap-2 border-t border-ink-700 px-4 py-2.5">
          <div className="min-w-0 flex-1 truncate text-[12px] text-red-400" title={error ?? undefined}>
            {error}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-ink-500 px-3 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={creating || !valid}
            onClick={() => void create()}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-[13px] text-white hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating && <VscLoading className="animate-spin" />}
            {creating ? t('newProject.creating') : t('newProject.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
