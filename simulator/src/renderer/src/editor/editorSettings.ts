/**
 * 编辑器本地设置(localStorage 持久化 + 轻量订阅)
 * 当前仅 minimap 开关(默认开);EditorHost 订阅变化即时 updateOptions
 */

const MINIMAP_KEY = 'pixelbox-sim.editor.minimap'

const listeners = new Set<() => void>()

/** minimap 是否开启(默认开,仅显式存 '0' 时关) */
export function minimapEnabled(): boolean {
  return localStorage.getItem(MINIMAP_KEY) !== '0'
}

/** 设置 minimap 开关并通知订阅者(设置弹窗保存时调用) */
export function setMinimapEnabled(enabled: boolean): void {
  localStorage.setItem(MINIMAP_KEY, enabled ? '1' : '0')
  for (const cb of listeners) cb()
}

/** 订阅编辑器设置变化,返回取消函数 */
export function subscribeEditorSettings(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
