/**
 * 设置页注册表 —— 新增设置页 = 在 pages/ 下新增一个文件,框架零改动
 *
 * pages/*.tsx 每个文件导出 `export const page: SettingsPage = {...}`,
 * 本文件经 import.meta.webpackContext(同步 eager)自动收集并按分类树组织;
 * 搜索(中英关键词)、面包屑、历史导航均由 SettingsWindow 基于本表驱动。
 * 扩展方法详见同目录 README.md。
 */

/** 分类树节点引用(页面声明自己的分类路径;新分类随页面自动出现) */
export interface SettingsCategoryRef {
  /** 稳定 id(树折叠状态 / key) */
  id: string
  /** 分类显示名 i18n key */
  labelKey: string
  /** 同层排序权重(小在前,默认 100) */
  order?: number
}

export interface SettingsPage {
  /** 稳定 id(选中态 / 历史栈 / 默认页) */
  id: string
  /** 分类树路径(根 → 父分类;空数组 = 顶层页面) */
  category: SettingsCategoryRef[]
  /** 页面标题 i18n key(左树行 / 面包屑) */
  titleKey: string
  /** 搜索关键词(中英;标题译文本身已参与匹配,无需重复) */
  keywords: string[]
  /** 可选图标(左树行前缀) */
  icon?: React.ReactNode
  /** 同层排序权重(小在前,默认 100) */
  order?: number
  /** 页面主体(在 SettingsDraftContext 内渲染,经 useDraftValue 读写草稿) */
  Component: React.ComponentType
}

interface PageModule {
  page?: SettingsPage
}

// 构建期静态收集 pages/ 下全部注册文件(Rspack import.meta.webpackContext 原生能力,
// 等价于 vite 时代的 import.meta.glob eager:新增设置页 = 新增一个文件,框架零改动)
const pagesContext = import.meta.webpackContext('./pages', {
  recursive: false,
  regExp: /\.tsx$/,
  mode: 'sync'
})
const modules: Record<string, PageModule> = Object.fromEntries(
  pagesContext.keys().map((key) => [key, pagesContext(key) as PageModule])
)

/** 全部设置页(分类 order → 页面 order → id 稳定排序) */
export const SETTINGS_PAGES: SettingsPage[] = Object.entries(modules)
  .map(([file, m]) => {
    if (!m.page) {
      // 注册文件缺少 page 导出:开发期直接报错比静默丢页容易发现
      throw new Error(`设置页注册文件缺少 export const page: ${file}`)
    }
    return m.page
  })
  .sort(
    (a, b) =>
      (a.category[0]?.order ?? 100) - (b.category[0]?.order ?? 100) ||
      (a.order ?? 100) - (b.order ?? 100) ||
      a.id.localeCompare(b.id)
  )

export function pageById(id: string): SettingsPage | null {
  return SETTINGS_PAGES.find((p) => p.id === id) ?? null
}

// ---------------------------------------------------------------
// 分类树(左栏)
// ---------------------------------------------------------------

export interface CategoryTreeNode {
  kind: 'category'
  id: string
  labelKey: string
  order: number
  children: TreeNode[]
}

export interface PageTreeNode {
  kind: 'page'
  page: SettingsPage
}

export type TreeNode = CategoryTreeNode | PageTreeNode

/** 由页面声明聚合分类树(同 id 分类合并;层内 分类/页面 混排按 order) */
export function buildCategoryTree(pages: SettingsPage[]): TreeNode[] {
  const roots: TreeNode[] = []

  const ensureCategory = (siblings: TreeNode[], ref: SettingsCategoryRef): CategoryTreeNode => {
    const found = siblings.find(
      (n): n is CategoryTreeNode => n.kind === 'category' && n.id === ref.id
    )
    if (found) return found
    const node: CategoryTreeNode = {
      kind: 'category',
      id: ref.id,
      labelKey: ref.labelKey,
      order: ref.order ?? 100,
      children: []
    }
    siblings.push(node)
    return node
  }

  for (const page of pages) {
    let siblings = roots
    for (const ref of page.category) {
      siblings = ensureCategory(siblings, ref).children
    }
    siblings.push({ kind: 'page', page })
  }

  const sortLevel = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => orderOf(a) - orderOf(b))
    for (const n of nodes) if (n.kind === 'category') sortLevel(n.children)
  }
  sortLevel(roots)
  return roots
}

function orderOf(n: TreeNode): number {
  return n.kind === 'category' ? n.order : (n.page.order ?? 100)
}

// ---------------------------------------------------------------
// 搜索(输入即过滤分类树并高亮命中页)
// ---------------------------------------------------------------

/** 页面是否命中查询(标题译文 + 中英关键词,大小写不敏感) */
export function pageMatches(page: SettingsPage, query: string, title: string): boolean {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return true
  if (title.toLowerCase().includes(q)) return true
  return page.keywords.some((k) => k.toLowerCase().includes(q))
}

/** 深度优先收集命中页(树序;回车跳首个命中用) */
export function collectMatches(
  nodes: TreeNode[],
  query: string,
  titleOf: (p: SettingsPage) => string
): SettingsPage[] {
  const out: SettingsPage[] = []
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      if (n.kind === 'page') {
        if (pageMatches(n.page, query, titleOf(n.page))) out.push(n.page)
      } else {
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return out
}
