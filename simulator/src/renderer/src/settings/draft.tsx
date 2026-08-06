/**
 * 设置草稿(Draft)—— 框架统一管理的「未应用修改」层
 *
 * 语义(与 JetBrains 设置对话框一致):
 * - 页面组件只读写草稿(useDraftValue),不直接落盘
 * - Apply / OK 时框架把草稿经 settings:set-many 一次性落盘并广播,Cancel 丢弃
 * - 草稿仅存「与已保存值不同」的键 —— 改回原值自动出栈,dirty = 草稿非空
 * - 切页不清草稿(未应用修改跨页保留),关窗且 dirty 时确认框(SettingsWindow)
 */
import { createContext, useContext } from 'react'
import { getAtPath } from '../../../shared/settingsSchema'
import type { AppSettings } from '../../../shared/ipc-types'

export interface SettingsDraftApi {
  /** 已保存的全量设置(镜像) */
  saved: AppSettings
  /** 草稿层(dot-path → 值;仅含与 saved 不同的键) */
  draft: Record<string, unknown>
  /** 读取生效值:草稿优先,回落已保存值 */
  get(path: string): unknown
  /** 写入草稿(与已保存值相同时自动移除该键) */
  set(path: string, value: unknown): void
  /** 是否存在未应用修改 */
  dirty: boolean
}

export const SettingsDraftContext = createContext<SettingsDraftApi | null>(null)

/** 页面组件专用:读取草稿 API(必须在 SettingsWindow 框架内使用) */
export function useSettingsDraft(): SettingsDraftApi {
  const api = useContext(SettingsDraftContext)
  if (!api) throw new Error('useSettingsDraft 必须在设置窗口框架(DraftProvider)内使用')
  return api
}

/** 单项设置的 [值, 写草稿] 便捷 hook(泛型仅作调用侧标注,值经 schema 校验落盘) */
export function useDraftValue<T>(path: string): [T, (v: T) => void] {
  const api = useSettingsDraft()
  return [api.get(path) as T, (v: T) => api.set(path, v)]
}

/** 组件外读取生效值的工具(面包屑等框架自用) */
export function draftGet(
  saved: AppSettings,
  draft: Record<string, unknown>,
  path: string
): unknown {
  return path in draft ? draft[path] : getAtPath(saved, path)
}
