/**
 * Markdown 查看模式记忆(每文件独立,localStorage 持久化)
 * 模式:编辑 / 分屏(默认)/ 预览
 */

export type MdViewMode = 'edit' | 'split' | 'preview'

const KEY = 'pixelbox-sim.md-view-modes'
/** 记忆上限(防止无限膨胀,超出丢弃最早写入的键) */
const MAX_ENTRIES = 200

function loadAll(): Record<string, MdViewMode> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, MdViewMode>
    }
  } catch {
    // 损坏的存储:重置
  }
  return {}
}

/** 读取文件的查看模式(默认分屏) */
export function getMdViewMode(path: string): MdViewMode {
  const m = loadAll()[path]
  return m === 'edit' || m === 'preview' ? m : 'split'
}

/** 记忆文件的查看模式 */
export function setMdViewMode(path: string, mode: MdViewMode): void {
  const all = loadAll()
  all[path] = mode
  const keys = Object.keys(all)
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k]
  }
  localStorage.setItem(KEY, JSON.stringify(all))
}
