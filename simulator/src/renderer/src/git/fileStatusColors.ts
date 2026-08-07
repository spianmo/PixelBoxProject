/**
 * Git 文件状态着色映射(IDEA 式;GitPanel 变更行 + components/FileTree.tsx 统一数据源)
 *
 * 档位全部为主题化 tailwind 类(tailwind.config.js 把 red/green/yellow/gray 等
 * 档位映射到 --pb-c-* CSS 变量,dark/light 双主题各有取值;禁止写死 hex):
 * - M/R 修改/重命名 = 蓝(text-blue-400 档)
 * - A   新增(已暂存)= 绿
 * - U   未跟踪(未管理)= IDEA 的砖红(red-300 档,与冲突亮红区分)
 * - C   冲突 = 亮红加粗
 * - D   删除 = 灰 + 删除线
 * - I   忽略(gitignore 命中)= 橄榄/暗黄绿(yellow-600 为主题化档位里最接近的)
 */
import type { GitFileStatus } from '../../../shared/ipc-types'

/** FileTree 着色用状态字母(GitFileStatus 去掉 R —— store 已把 R 归并为 M) */
export type GitTreeMark = Exclude<GitFileStatus, 'R'>

/** 状态字母 → 文字着色 className(GitPanel 徽标/文件名与 FileTree 行共用) */
export const GIT_STATUS_CLS: Record<GitFileStatus, string> = {
  M: 'text-blue-400',
  R: 'text-blue-400',
  A: 'text-green-400',
  U: 'text-red-300',
  C: 'text-red-500 font-bold',
  D: 'text-gray-500 line-through',
  I: 'text-yellow-600'
}

/**
 * FileTree 行取状态:直查命中即返回;未命中时向上走祖先目录链,命中 ignored
 * 目录('I',git status --ignored=matching 对目录整条给出不展开)则整棵子树
 * 继承橄榄色。目录行仅在 ignored 时着色(与 IDEA 一致,普通变更不染目录)。
 */
export function gitMarkFor(
  map: ReadonlyMap<string, GitTreeMark> | undefined,
  path: string,
  isDir: boolean
): GitTreeMark | undefined {
  if (!map || map.size === 0) return undefined
  const direct = map.get(path)
  if (direct) return isDir && direct !== 'I' ? undefined : direct
  // 祖先 ignored 传播(最多走到没有分隔符为止;map 键为工作区内绝对路径,越界无命中)
  let p = path
  for (;;) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    if (i <= 0) return undefined
    p = p.slice(0, i)
    if (map.get(p) === 'I') return 'I'
  }
}
