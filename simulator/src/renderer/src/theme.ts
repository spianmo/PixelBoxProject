/**
 * 主题管理器(renderer)—— 有效主题解析 + <html data-theme> 应用 + 消费方订阅
 *
 * - 有效主题 = appearance.theme(dark/light)或跟随系统(system 经 main 侧
 *   nativeTheme 解析:初始化拉取一次 theme:get-system,变化经 theme:system-changed 推送)
 * - 应用 = 置 document.documentElement.dataset.theme(CSS 变量组 [data-theme=light]
 *   随之切换,组件类名不变)+ 通知订阅方(Monaco setTheme / xterm options.theme 热切)
 * - 每次应用打印并回报「[theme] applied=<设置值> effective=<有效值>」:
 *   main 侧转印到 dev 终端(PIXELBOX_SMOKE_THEME 冒烟断言)并同步各窗口底色
 * - 冷启动镜像:有效主题写 localStorage,下次启动在首个 IPC 往返前先按镜像上屏,
 *   避免亮色用户冷启动闪一帧深色(与 i18n 语言镜像同一模式)
 * - 所有窗口(主窗 / 设置窗 / 独立工具窗)入口统一 initTheme(),幂等
 */
import { getAppSettings, subscribeSettings } from './settings/store'
import type { AppTheme, EffectiveTheme } from '../../shared/ipc-types'

/** 有效主题冷启动镜像键(仅作首帧防闪,真值恒来自设置镜像 + 系统主题) */
const THEME_MIRROR_KEY = 'pixelbox-sim.theme-mirror'

let systemTheme: EffectiveTheme = 'dark'
let appliedSetting: AppTheme | null = null
let appliedEffective: EffectiveTheme = 'dark'
const listeners = new Set<() => void>()

/** 当前有效主题(Monaco / xterm 等消费方读取) */
export function getEffectiveTheme(): EffectiveTheme {
  return appliedEffective
}

/** 订阅有效主题变化(返回取消函数;仅有效主题真实变化时通知) */
export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 解析 + 应用主题;force 用于初始化(即使与镜像预applied一致也回报一次) */
function apply(force = false): void {
  const setting = getAppSettings().appearance.theme
  const effective: EffectiveTheme = setting === 'system' ? systemTheme : setting
  // 设置值与有效值均未变化则跳过(system 下系统翻转会改变 effective,不会漏)
  if (!force && setting === appliedSetting && effective === appliedEffective) return
  const effectiveChanged = effective !== appliedEffective
  appliedSetting = setting
  appliedEffective = effective

  document.documentElement.dataset.theme = effective
  try {
    localStorage.setItem(THEME_MIRROR_KEY, effective)
  } catch {
    // localStorage 不可用:仅失去冷启动防闪,主题仍正常生效
  }

  // 应用日志:renderer console + main 终端([theme] 前缀,冒烟断言依据)
  const line = `[theme] applied=${setting} effective=${effective}`
  console.log(line)
  window.api.themeApplied(line)

  if (effectiveChanged || force) {
    for (const cb of listeners) cb()
  }
}

/**
 * 首帧防闪:模块加载即按冷启动镜像先上屏(同步,早于首个 IPC 往返与 React 首帧)。
 * 镜像缺失时保持 CSS 默认(:root 即深色)。
 */
export function applyThemeMirrorEarly(): void {
  try {
    const cached = localStorage.getItem(THEME_MIRROR_KEY)
    if (cached === 'light' || cached === 'dark') {
      document.documentElement.dataset.theme = cached
      appliedEffective = cached
    }
  } catch {
    // localStorage 不可用:保持深色默认
  }
}

let initialized: Promise<void> | null = null

/**
 * 全窗口统一初始化(幂等):拉取系统主题 → 订阅系统主题推送与设置镜像 → 首次应用。
 * main.tsx 在 initSettings() 之后、首帧渲染之前 await,保证首帧即正确主题。
 */
export function initTheme(): Promise<void> {
  if (initialized) return initialized

  // 系统主题变化(nativeTheme updated 广播):仅「跟随系统」时改变有效主题
  window.api.onSystemThemeChanged((mode) => {
    systemTheme = mode
    apply()
  })
  // 设置镜像变化(settings:changed):appearance.theme 变化时重算
  subscribeSettings(() => apply())

  initialized = window.api
    .themeGetSystem()
    .then((mode) => {
      systemTheme = mode
      apply(true)
    })
    .catch(() => {
      apply(true) // IPC 失败:按 systemTheme 默认 dark 兜底,不阻塞渲染
    })
  return initialized
}
