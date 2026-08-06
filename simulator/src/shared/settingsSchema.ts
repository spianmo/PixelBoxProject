/**
 * IDE 设置 schema(单一数据源)—— 默认值 + 逐项校验/规范化 + dot-path 补丁工具
 *
 * main(SettingsService 落盘)与 renderer(设置窗口草稿/表单、消费方镜像)共用:
 * - SETTINGS_DEFAULTS:全量默认值(类型即 shared/ipc-types.ts 的 AppSettings)
 * - SETTINGS_KEYS / sanitizeSetting:合法 dot-path 白名单与逐项校验
 *   (未知键 / 校验不过的值一律丢弃,坏数据不落盘不广播)
 * - applyPatch:把 dot-path 补丁合入基线,返回新对象与实际变化键列表
 *
 * 新增设置项 = 在 DEFAULTS + SANITIZERS 各加一行(再到 renderer 设置页注册表挂 UI,
 * 见 src/renderer/src/settings/README.md);IPC / 落盘 / 广播框架零改动。
 */
import type { AppSettings } from './ipc-types'

export const SETTINGS_DEFAULTS: AppSettings = {
  appearance: {
    language: 'zh-CN',
    theme: 'dark'
  },
  system: {
    restoreSession: true,
    quitOnMainWindowClose: false
  },
  editor: {
    minimap: true,
    fontSize: 13,
    tabSize: 2,
    fontFamily: 'JetBrains Mono'
  },
  toolchain: {
    idfPathOverride: '',
    defaultTarget: 'esp32s3',
    baudRate: 460800
  },
  terminal: {
    shellOverride: '',
    fontSize: 12
  }
}

/** 编辑器字号允许区间(设置页下拉与校验器共用) */
export const EDITOR_FONT_SIZE_RANGE = { min: 12, max: 20 } as const
/** 终端字号允许区间 */
export const TERMINAL_FONT_SIZE_RANGE = { min: 8, max: 24 } as const

/** 校验器:合法返回规范化后的值,非法返回 undefined(调用方丢弃该项) */
type Sanitizer = (v: unknown) => unknown | undefined

const bool: Sanitizer = (v) => (typeof v === 'boolean' ? v : undefined)

const intRange =
  (min: number, max: number): Sanitizer =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
      ? Math.round(v)
      : undefined

const trimmedString =
  (maxLen: number): Sanitizer =>
  (v) =>
    typeof v === 'string' ? v.trim().slice(0, maxLen) : undefined

/** dot-path → 校验器(键集合即设置项白名单) */
const SANITIZERS: Record<string, Sanitizer> = {
  'appearance.language': (v) => (v === 'zh-CN' || v === 'en' ? v : undefined),
  // 主题三值:dark / light / system(system 由 main 侧 nativeTheme 解析为有效主题)
  'appearance.theme': (v) => (v === 'dark' || v === 'light' || v === 'system' ? v : undefined),
  'system.restoreSession': bool,
  'system.quitOnMainWindowClose': bool,
  'editor.minimap': bool,
  'editor.fontSize': intRange(EDITOR_FONT_SIZE_RANGE.min, EDITOR_FONT_SIZE_RANGE.max),
  'editor.tabSize': (v) => (v === 2 || v === 4 ? v : undefined),
  'editor.fontFamily': trimmedString(128),
  'toolchain.idfPathOverride': trimmedString(1024),
  'toolchain.defaultTarget': (v) =>
    typeof v === 'string' && /^[a-z0-9]{2,32}$/.test(v) ? v : undefined,
  'toolchain.baudRate': (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 9600 && v <= 4000000
      ? Math.floor(v)
      : undefined,
  'terminal.shellOverride': trimmedString(1024),
  'terminal.fontSize': intRange(TERMINAL_FONT_SIZE_RANGE.min, TERMINAL_FONT_SIZE_RANGE.max)
}

/** 全部合法设置键(dot-path) */
export const SETTINGS_KEYS: readonly string[] = Object.keys(SANITIZERS)

/** 校验单项设置值:合法返回规范化值,未知键/非法值返回 undefined */
export function sanitizeSetting(path: string, value: unknown): unknown | undefined {
  const fn = SANITIZERS[path]
  return fn ? fn(value) : undefined
}

/** 按 dot-path 取值(仅两级 section.key;路径非法返回 undefined) */
export function getAtPath(settings: AppSettings, path: string): unknown {
  const [section, key] = path.split('.')
  const sec = (settings as unknown as Record<string, Record<string, unknown>>)[section]
  return sec && key ? sec[key] : undefined
}

/** 深拷贝(schema 为两级纯 JSON 结构) */
function cloneSettings(s: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(s)) as AppSettings
}

export interface PatchResult {
  next: AppSettings
  /** 实际发生变化(校验通过且值不同)的键 */
  changedKeys: string[]
}

/**
 * 把 dot-path 补丁合入基线设置:逐项过白名单校验,值未变化的键不计入 changedKeys。
 * 返回新对象(基线不被修改);补丁全部无效时 changedKeys 为空、next 与基线等值。
 */
export function applyPatch(base: AppSettings, patch: Record<string, unknown>): PatchResult {
  const next = cloneSettings(base)
  const changedKeys: string[] = []
  for (const [path, raw] of Object.entries(patch)) {
    const value = sanitizeSetting(path, raw)
    if (value === undefined) continue // 未知键 / 校验不过:丢弃
    if (getAtPath(next, path) === value) continue // 值未变化
    const [section, key] = path.split('.')
    ;(next as unknown as Record<string, Record<string, unknown>>)[section][key] = value
    changedKeys.push(path)
  }
  return { next, changedKeys }
}

/**
 * 从未知 JSON(落盘文件)恢复设置:仅吸收白名单内且校验通过的字段,
 * 其余回退默认值(文件损坏 / 旧版本多余字段安全降级)。
 */
export function settingsFromDisk(raw: unknown): AppSettings {
  const next = cloneSettings(SETTINGS_DEFAULTS)
  if (typeof raw !== 'object' || raw === null) return next
  const obj = raw as Record<string, Record<string, unknown>>
  for (const path of SETTINGS_KEYS) {
    const [section, key] = path.split('.')
    const sec = obj[section]
    if (typeof sec !== 'object' || sec === null) continue
    const value = sanitizeSetting(path, sec[key])
    if (value !== undefined) {
      ;(next as unknown as Record<string, Record<string, unknown>>)[section][key] = value
    }
  }
  return next
}
