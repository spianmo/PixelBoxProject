/**
 * 新建项目对话框 —— 视觉完全复刻设置窗口(settings/SettingsWindow.tsx + settings/controls.tsx):
 *
 * 布局:720×500 卡片(bg-ink-900),flex-col = [36px 标题条][主体左右分栏][底部按钮条]。
 * - 标题条:克隆设置窗口标题栏(bg-ink-850 / border-b),图标 + 标题 + 「— PixelBox」,右侧 ✕;
 * - 左栏 240px(bg-ink-850):「项目类型」小节标签 + 三个 PageRow 式平铺行
 *   (无圆角,选中 bg-jb-selection,悬停 bg-ink-800,描述经 title 提示);
 * - 右栏内容区(px-6 py-4):SettingsSection 式分节(标题 + 延展横线)——
 *   节 1 = 选中类型名(标题下类型描述 FieldHint 风):名称(自动聚焦,[a-zA-Z0-9_-] 实时校验,
 *     无效时提示转红)/ 位置(输入 + 文件夹按钮,「项目将创建于:…」);
 *   节 2 = 选项:app → 模板下拉(SelectField 风,220px)+ 应用 ID(TextField 风,
 *     默认 com.example.<名称>,手动改过不再跟随,无效时提示转红);
 *     firmware|hardware → 目标芯片下拉(CHIP_TARGETS,默认 esp32s3);
 * - 底栏:克隆设置窗口底栏(border-t px-4 py-2.5),左侧内联错误,右侧 取消 / 创建(主色)。
 *
 * 创建走 main 进程 project:create;错误码 project:<code> 映射 newProject.errors.*(取最后一个匹配);
 * Esc 关闭、Enter(表单有效时)提交。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IconType } from 'react-icons'
import { LuCircuitBoard, LuCpu, LuFilePlus2, LuFolderOpen, LuLayoutTemplate, LuX } from 'react-icons/lu'
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

/** 标签列(同 settings/controls.tsx SelectField/TextField 的左标签) */
const LABEL_CLASS = 'w-32 shrink-0 text-[13px] text-jb-text'

/** 文本输入(同 settings/controls.tsx TextField) */
const INPUT_CLASS =
  'min-w-0 flex-1 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-jb-text outline-none placeholder:text-ink-500 focus:border-accent'

/** 下拉框(同 settings/controls.tsx SelectField) */
const SELECT_CLASS =
  'rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] text-jb-text outline-none focus:border-accent'

/** 字段下方提示(同 controls.tsx FieldHint,左移对齐控件列:128px 标签 + 12px gap) */
const HINT_CLASS = 'ml-[140px] mt-1 text-[11px] leading-4 text-ink-500'

/** SettingsSection 的展示型克隆(settings/controls.tsx):标题 + 延展横线 + 可选描述行 */
function Section(props: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-3">
        <span className="shrink-0 text-[13px] font-medium text-jb-text">{props.title}</span>
        <div className="h-px flex-1 bg-ink-700" />
      </div>
      {props.description && (
        <div className="mb-3 text-[11px] leading-4 text-ink-500">{props.description}</div>
      )}
      <div className="space-y-4 pl-0.5">{props.children}</div>
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
  const appIdInvalid = appId.trim().length > 0 && !APP_ID_RE.test(appId.trim())
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
      // main 进程以 project:<code> 抛错 → 映射 i18n;
      // Electron 包装为 "Error invoking remote method 'project:create': Error: project:<code>",
      // 首个匹配恒为通道名 → 取最后一个匹配才是真实错误码
      const raw = err instanceof Error ? err.message : String(err)
      const code = [...raw.matchAll(/project:(\w+)/g)].pop()?.[1]
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

  const kinds: Array<{ key: ProjectKind; Icon: IconType; label: string; desc: string }> = [
    {
      key: 'app',
      Icon: LuLayoutTemplate,
      label: t('newProject.kinds.app'),
      desc: t('newProject.kinds.appDesc')
    },
    {
      key: 'firmware',
      Icon: LuCpu,
      label: t('newProject.kinds.firmware'),
      desc: t('newProject.kinds.firmwareDesc')
    },
    {
      key: 'hardware',
      Icon: LuCircuitBoard,
      label: t('newProject.kinds.hardware'),
      desc: t('newProject.kinds.hardwareDesc')
    }
  ]
  const currentKind = kinds.find((k) => k.key === kind) ?? kinds[0]
  const previewPath = joinPath(location, trimmedName)

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
      <div className="flex h-[500px] w-[720px] flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-900 text-jb-text shadow-2xl">
        {/* 标题条:克隆设置窗口标题栏(免拖拽) */}
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-ink-700 bg-ink-850 px-3">
          <LuFilePlus2 className="text-jb-muted" />
          <span className="text-xs font-medium text-jb-text">{t('newProject.title')}</span>
          <span className="text-xs text-jb-muted">— PixelBox</span>
          <button
            type="button"
            title={t('titlebar.close')}
            onClick={onClose}
            className="ml-auto flex h-full w-11 items-center justify-center text-jb-muted hover:bg-ink-800 hover:text-jb-text"
          >
            <LuX />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左栏:项目类型(PageRow 式平铺行,克隆设置窗口分类树选中/悬停态) */}
          <div className="w-[240px] shrink-0 border-r border-ink-700 bg-ink-850 py-2">
            <div className="px-3 pb-1 text-[11px] text-ink-500">{t('newProject.kindsLabel')}</div>
            <div role="listbox" aria-label={t('newProject.kindsLabel')}>
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
                    className={`flex w-full items-center gap-2 py-[3px] pl-3 pr-2 text-left text-[13px] ${
                      selected
                        ? 'bg-jb-selection text-jb-text'
                        : 'text-jb-muted hover:bg-ink-800 hover:text-jb-text'
                    }`}
                  >
                    <k.Icon className="text-[14px]" />
                    <span className="truncate">{k.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 右栏:SettingsSection 式表单 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {/* 节 1:选中类型名 + 描述;名称 / 位置 */}
              <Section title={currentKind.label} description={currentKind.desc}>
                <div>
                  <div className="flex items-center gap-3">
                    <span className={LABEL_CLASS}>{t('newProject.name')}</span>
                    <input
                      ref={nameRef}
                      autoFocus
                      value={name}
                      onChange={(e) => changeName(e.target.value)}
                      onKeyDown={submitOnEnter}
                      placeholder={t('newProject.namePlaceholder')}
                      spellCheck={false}
                      className={INPUT_CLASS}
                    />
                  </div>
                  <div
                    className={`ml-[140px] mt-1 text-[11px] leading-4 ${
                      nameInvalid ? 'text-red-400' : 'text-ink-500'
                    }`}
                  >
                    {nameInvalid ? t('newProject.errors.nameInvalid') : t('newProject.nameHint')}
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-3">
                    <span className={LABEL_CLASS}>{t('newProject.location')}</span>
                    <input
                      value={location}
                      onChange={(e) => {
                        setLocation(e.target.value)
                        setError(null)
                      }}
                      onKeyDown={submitOnEnter}
                      spellCheck={false}
                      className={INPUT_CLASS}
                    />
                    <button
                      type="button"
                      onClick={() => void browse()}
                      title={t('newProject.browse')}
                      aria-label={t('newProject.browse')}
                      className="rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] text-jb-muted hover:bg-ink-800 hover:text-jb-text"
                    >
                      <LuFolderOpen />
                    </button>
                  </div>
                  <div className={`${HINT_CLASS} truncate`} title={previewPath}>
                    {t('newProject.createIn', { path: previewPath })}
                  </div>
                </div>
              </Section>

              {/* 节 2:选项(app → 模板 + 应用 ID;firmware|hardware → 目标芯片) */}
              <Section title={t('newProject.sectionOptions')}>
                {kind === 'app' ? (
                  <>
                    <div>
                      <div className="flex items-center gap-3">
                        <span className={LABEL_CLASS}>{t('newProject.template')}</span>
                        <select
                          value={template}
                          onChange={(e) => setTemplate(e.target.value as ProjectTemplate)}
                          style={{ width: 220 }}
                          className={SELECT_CLASS}
                        >
                          <option value="hello">{t('newProject.templateHello')}</option>
                          <option value="blank">{t('newProject.templateBlank')}</option>
                        </select>
                      </div>
                      <div className={HINT_CLASS}>
                        {template === 'hello'
                          ? t('newProject.templateHelloDesc')
                          : t('newProject.templateBlankDesc')}
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-3">
                        <span className={LABEL_CLASS}>{t('newProject.appId')}</span>
                        <input
                          value={appId}
                          onChange={(e) => {
                            setAppId(e.target.value)
                            setAppIdTouched(true)
                            setError(null)
                          }}
                          onKeyDown={submitOnEnter}
                          spellCheck={false}
                          className={`${INPUT_CLASS} font-mono`}
                        />
                      </div>
                      <div
                        className={`ml-[140px] mt-1 text-[11px] leading-4 ${
                          appIdInvalid ? 'text-red-400' : 'text-ink-500'
                        }`}
                      >
                        {appIdInvalid
                          ? t('newProject.errors.appIdInvalid')
                          : t('newProject.appIdHint')}
                      </div>
                    </div>
                  </>
                ) : (
                  <div>
                    <div className="flex items-center gap-3">
                      <span className={LABEL_CLASS}>{t('newProject.chip')}</span>
                      <select
                        value={chip}
                        onChange={(e) => setChip(e.target.value as ChipTarget)}
                        style={{ width: 220 }}
                        className={SELECT_CLASS}
                      >
                        {CHIP_TARGETS.map((c) => (
                          <option key={c} value={c}>
                            {chipLabel(c)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* hardware 的芯片选择决定生成哪块微雪参考板卡模板(templates/boards 注册表) */}
                    <div className={HINT_CLASS}>
                      {t(kind === 'hardware' ? 'newProject.chipHintHardware' : 'newProject.chipHint')}
                    </div>
                  </div>
                )}
              </Section>
            </div>
          </div>
        </div>

        {/* 底栏:克隆设置窗口底部按钮条(左侧内联错误信息) */}
        <div className="flex shrink-0 items-center gap-2 border-t border-ink-700 px-4 py-2.5">
          <div className="min-w-0 flex-1 truncate text-[12px] text-red-400" title={error ?? undefined}>
            {error}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-ink-500 px-3.5 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={creating || !valid}
            onClick={() => void create()}
            className="rounded bg-accent-dim px-3.5 py-1 text-[13px] text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex items-center gap-1.5">
              {creating && <VscLoading className="animate-spin" />}
              {creating ? t('newProject.creating') : t('newProject.create')}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
