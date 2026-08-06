/**
 * 设置镜像(renderer)—— main SettingsService 的只读镜像 + 消费方订阅分发
 *
 * - initSettings():settings:get-all 拉取全量 + 订阅 settings:changed 广播,
 *   所有窗口(主窗 / 设置窗 / 独立工具窗)入口(main.tsx)统一调用,幂等
 * - 消费方(Monaco / 终端字号 / 标题栏芯片 / i18n)经 subscribeSettings 订阅即时生效
 * - 语言同步:镜像变化 → i18n.changeLanguage;设置窗口的「立即预览」经
 *   setLanguagePreview 临时覆盖(Apply 落盘 / Cancel 丢弃后自动回落)
 * - 旧 localStorage 值(pixelbox-sim.lang / pixelbox-sim.editor.minimap)首启迁移:
 *   推送进 SettingsService 后写迁移标记,旧键此后仅作冷启动语言镜像缓存
 *   (i18n 初始化是同步的,settings 镜像是异步 IPC,缓存避免语言闪变)
 */
import { useSyncExternalStore } from 'react'
import { createStore, type Store } from '../device-sim/store'
import type { AppSettings, UiLanguage } from '../../../shared/ipc-types'
import { SETTINGS_DEFAULTS } from '../../../shared/settingsSchema'
import i18n from '../i18n'

export interface SettingsMirrorState {
  settings: AppSettings
  /** 首次 get-all 完成(设置窗口可据此禁用表单避免闪变) */
  loaded: boolean
}

export const settingsStore: Store<SettingsMirrorState> = createStore<SettingsMirrorState>({
  settings: SETTINGS_DEFAULTS,
  loaded: false
})

/** React hook:订阅设置镜像 */
export function useSettingsMirror(): SettingsMirrorState {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get)
}

/** 当前设置快照(非 React 消费方:xterm 注册表 / EditorHost 初值等) */
export function getAppSettings(): AppSettings {
  return settingsStore.get().settings
}

/** 订阅设置变化(返回取消函数) */
export function subscribeSettings(cb: () => void): () => void {
  return settingsStore.subscribe(cb)
}

// ---------------------------------------------------------------
// 语言同步(含设置窗口「立即预览」)
// ---------------------------------------------------------------

/** 旧语言键 —— 迁移后降级为冷启动镜像缓存(i18n/index.ts 同步初读) */
const LANG_MIRROR_KEY = 'pixelbox-sim.lang'
/** 旧 minimap 键(v2.2 SettingsModal 落盘;迁移后弃用不再读写) */
const LEGACY_MINIMAP_KEY = 'pixelbox-sim.editor.minimap'
/** localStorage 旧值一次性迁移标记 */
const MIGRATED_KEY = 'pixelbox-sim.settings-migrated'

let previewLanguage: UiLanguage | null = null

/** 生效语言 = 预览(设置窗口草稿)优先,否则落盘值 */
function syncLanguage(): void {
  const saved = settingsStore.get().settings.appearance.language
  const target = previewLanguage ?? saved
  if (i18n.language !== target) void i18n.changeLanguage(target)
  // 镜像缓存永远写落盘值(预览不污染冷启动语言)
  try {
    localStorage.setItem(LANG_MIRROR_KEY, saved)
  } catch {
    // localStorage 不可用时静默(语言仍由镜像驱动)
  }
}

/**
 * 设置窗口语言「立即预览」:传语言临时切换本窗口 i18n,传 null 回落到落盘值
 * (Cancel 丢弃草稿 / Apply 落盘后由框架调用)
 */
export function setLanguagePreview(lang: UiLanguage | null): void {
  previewLanguage = lang
  syncLanguage()
}

// ---------------------------------------------------------------
// 初始化(幂等)
// ---------------------------------------------------------------

/** localStorage 旧值一次性迁移(标记先行,主窗/设置窗并发也只跑一次) */
function migrateLegacyLocalStorage(): void {
  try {
    if (localStorage.getItem(MIGRATED_KEY) === '1') return
    localStorage.setItem(MIGRATED_KEY, '1')
    const patch: Record<string, unknown> = {}
    const lang = localStorage.getItem(LANG_MIRROR_KEY)
    if (lang === 'zh-CN' || lang === 'en') patch['appearance.language'] = lang
    const minimap = localStorage.getItem(LEGACY_MINIMAP_KEY)
    if (minimap !== null) patch['editor.minimap'] = minimap !== '0'
    if (Object.keys(patch).length > 0) void window.api.settingsSetMany(patch)
  } catch {
    // localStorage 不可用:无旧值可迁移
  }
}

let initialized: Promise<void> | null = null

/**
 * 全窗口统一初始化:拉取镜像 + 订阅广播 + 首启迁移(main.tsx 渲染前调用,幂等)。
 * 返回「首次 get-all 完成」的 promise:main.tsx 等其 settle 后再渲染首帧,
 * 使布局/会话恢复(App)同步读 getAppSettings() 即为真实落盘值。
 */
export function initSettings(): Promise<void> {
  if (initialized) return initialized

  // 变更广播 → 镜像更新 → 语言同步(其余消费方经 subscribeSettings 自取)
  window.api.onSettingsChanged((ev) => {
    settingsStore.set({ settings: ev.settings })
    syncLanguage()
  })

  initialized = window.api
    .settingsGetAll()
    .then((settings) => {
      settingsStore.set({ settings, loaded: true })
      migrateLegacyLocalStorage()
      syncLanguage()
    })
    .catch(() => {
      settingsStore.set({ loaded: true }) // IPC 失败保留默认值兜底
    })
  return initialized
}
