/**
 * 编辑器视图设置(设置镜像的便捷封装)
 *
 * 数据源:main SettingsService(settings.json 的 editor 段;
 * 旧 localStorage minimap 键已由 settings/store.ts 首启迁移并弃用)。
 * EditorHost 订阅变化即时 updateOptions,无需重启窗口。
 */
import { getAppSettings, subscribeSettings } from '../settings/store'

export interface EditorViewSettings {
  minimap: boolean
  fontSize: number
  tabSize: number
  /** 完整字体回退链(设置项字体优先;字体文件阶段 2 引入后本地生效) */
  fontFamily: string
}

/** 当前编辑器视图设置(含字体回退链拼装) */
export function editorViewSettings(): EditorViewSettings {
  const e = getAppSettings().editor
  const family = e.fontFamily.trim().length > 0 ? e.fontFamily.trim() : 'JetBrains Mono'
  return {
    minimap: e.minimap,
    fontSize: e.fontSize,
    tabSize: e.tabSize,
    fontFamily: `"${family}", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`
  }
}

/** 订阅编辑器设置变化(settings:changed 镜像),返回取消函数 */
export const subscribeEditorSettings = subscribeSettings
