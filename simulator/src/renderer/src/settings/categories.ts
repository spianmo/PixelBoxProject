/**
 * 共享分类引用(多个设置页复用的分类树节点)
 * 页面也可以内联声明新分类(见 registry.tsx SettingsCategoryRef)—— 新分类随页面自动出现
 */
import type { SettingsCategoryRef } from './registry'

/** 外观与行为(order 10:树顶) */
export const CAT_APPEARANCE_BEHAVIOR: SettingsCategoryRef = {
  id: 'appearanceBehavior',
  labelKey: 'settings.cat.appearanceBehavior',
  order: 10
}

/** 工具 */
export const CAT_TOOLS: SettingsCategoryRef = {
  id: 'tools',
  labelKey: 'settings.cat.tools',
  order: 40
}
