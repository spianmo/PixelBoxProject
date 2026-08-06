/**
 * 新建项目向导(JetBrains 表单风格,标题栏项目下拉「新建项目…」触发)
 *
 * 字段:项目名称(目录名,[a-zA-Z0-9_-])/ 位置(默认 ~/PixelBoxProjects,可「浏览…」)/
 *       模板单选(像素动画 Hello = 弹跳方块示例 / 空白项目 = 最小 onFrame 骨架)/
 *       应用 ID(反域名,默认 com.example.<名称>,手动改过则不再跟随)
 * 创建走 main 进程 project:create;目录已存在且非空时报错拦截
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectCreateResult, ProjectTemplate } from '../../../shared/ipc-types'
import { showToast } from '../components/toast'

const NAME_RE = /^[a-zA-Z0-9_-]+$/
const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/

const INPUT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent'

function FormRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="w-24 shrink-0 pt-1.5 text-right text-xs text-jb-muted">{props.label}</div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

/** 应用 ID 默认值:com.example.<名称小写>(名称非法段兜底 app) */
function defaultAppId(name: string): string {
  const seg = name.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return `com.example.${seg || 'app'}`
}

interface Props {
  /** 创建成功(root/mainTs 由 main 进程返回;上层负责打开工作区与 src/main.ts) */
  onCreated: (result: ProjectCreateResult) => void
  onClose: () => void
}

export function NewProjectModal({ onCreated, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [template, setTemplate] = useState<ProjectTemplate>('hello')
  const [appId, setAppId] = useState(defaultAppId(''))
  /** 应用 ID 被手动编辑后不再跟随名称 */
  const [appIdTouched, setAppIdTouched] = useState(false)
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
    if (name.trim().length === 0) return t('newProject.errors.nameRequired')
    if (!NAME_RE.test(name.trim())) return t('newProject.errors.nameInvalid')
    if (location.trim().length === 0) return t('newProject.errors.locationRequired')
    if (!APP_ID_RE.test(appId.trim())) return t('newProject.errors.appIdInvalid')
    return null
  }

  const create = async (): Promise<void> => {
    const msg = validate()
    if (msg) {
      setError(msg)
      return
    }
    setCreating(true)
    try {
      const result = await window.api.projectCreate({
        name: name.trim(),
        location: location.trim(),
        template,
        appId: appId.trim()
      })
      showToast(t('newProject.created', { name: name.trim() }), 'success')
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

  const templates: Array<{ key: ProjectTemplate; label: string; desc: string }> = [
    { key: 'hello', label: t('newProject.templateHello'), desc: t('newProject.templateHelloDesc') },
    { key: 'blank', label: t('newProject.templateBlank'), desc: t('newProject.templateBlankDesc') }
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
      <div className="w-[560px] rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="border-b border-ink-700 px-4 py-2.5 text-sm font-medium text-jb-text">
          {t('newProject.title')}
        </div>

        <div className="space-y-3 px-4 py-4">
          <FormRow label={t('newProject.name')}>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => changeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
              }}
              placeholder={t('newProject.namePlaceholder')}
              className={INPUT_CLASS}
              spellCheck={false}
            />
            <div className="mt-1 text-[11px] text-ink-500">{t('newProject.nameHint')}</div>
          </FormRow>

          <FormRow label={t('newProject.location')}>
            <div className="flex gap-2">
              <input
                value={location}
                onChange={(e) => {
                  setLocation(e.target.value)
                  setError(null)
                }}
                className={INPUT_CLASS}
                spellCheck={false}
              />
              <button
                onClick={() => void browse()}
                className="shrink-0 rounded border border-ink-500 px-2.5 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
              >
                {t('newProject.browse')}
              </button>
            </div>
          </FormRow>

          <FormRow label={t('newProject.template')}>
            <div className="space-y-1.5">
              {templates.map((tp) => (
                <label
                  key={tp.key}
                  className={`flex cursor-pointer items-start gap-2 rounded border px-2.5 py-1.5 ${
                    template === tp.key
                      ? 'border-accent bg-jb-selection/40'
                      : 'border-ink-600 hover:bg-ink-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="pb-template"
                    className="mt-0.5 accent-[#3574F0]"
                    checked={template === tp.key}
                    onChange={() => setTemplate(tp.key)}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] text-jb-text">{tp.label}</span>
                    <span className="block text-[11px] text-jb-muted">{tp.desc}</span>
                  </span>
                </label>
              ))}
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
              className={`${INPUT_CLASS} font-mono`}
              spellCheck={false}
            />
            <div className="mt-1 text-[11px] text-ink-500">{t('newProject.appIdHint')}</div>
          </FormRow>

          {error && <div className="pl-[108px] text-[12px] text-red-400">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-2.5">
          <button
            onClick={onClose}
            className="rounded border border-ink-500 px-3 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
          >
            {t('common.cancel')}
          </button>
          <button
            disabled={creating}
            onClick={() => void create()}
            className="rounded bg-accent-dim px-3 py-1 text-[13px] text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? t('newProject.creating') : t('newProject.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
