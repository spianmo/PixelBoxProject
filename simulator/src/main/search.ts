/**
 * 项目内容检索服务(Find in Files,IDEA ⇧⌘F 的数据层)
 *
 * - 遍历规则与 ⌘P(workspace:list-files)对齐:跳过 node_modules/dist/out/build/.git
 *   与点开头目录;额外跳过二进制(前 8KB 含 NUL)与超大文件(>1MB —— 逐行检索
 *   对日志/产物意义不大且拖慢交互)
 * - 匹配选项:大小写 / 整词 / 正则(用户正则包 try,语法错误抛 search:badPattern)
 * - 结果按「文件 → 行内命中」平铺返回,全局命中上限 2000(超出置 truncated,
 *   renderer 提示收窄查询);单次调用 10s 预算,超时返回已得结果
 * - 路径牢笼:只在 getWatchedRoot() 内检索(与全部 fs IPC 同一约束)
 */
import { ipcMain } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { ContentSearchOptions, ContentSearchResult, ContentSearchMatch } from '../shared/ipc-types'
import { getWatchedRoot } from './workspace'

/** 与 workspace.ts LIST_SKIP_DIRS 同值(该常量未导出;两处语义必须一致) */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.git'])
/** 单文件大小上限 */
const MAX_FILE_BYTES = 1024 * 1024
/** 全局命中上限 */
const MAX_MATCHES = 2000
/** 单行展示截断(超长压缩行防 UI 卡顿) */
const MAX_LINE_CHARS = 500
/** 单次检索时间预算 ms */
const TIME_BUDGET_MS = 10_000

/** 前 8KB 含 NUL 判二进制 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 正则元字符转义(非 regex 模式下把查询词字面量化) */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 查询选项 → 每次匹配新建的 RegExp 工厂(g 粘滞状态不可跨行复用,逐行 exec 前重置) */
function buildPattern(query: string, opts: ContentSearchOptions): RegExp {
  let source = opts.regex ? query : escapeRegExp(query)
  if (opts.wholeWord) source = `\\b(?:${source})\\b`
  try {
    return new RegExp(source, opts.caseSensitive ? 'g' : 'gi')
  } catch {
    throw new Error('search:badPattern')
  }
}

async function searchContent(
  query: string,
  opts: ContentSearchOptions
): Promise<ContentSearchResult> {
  const root = getWatchedRoot()
  if (!root) return { matches: [], truncated: false, filesScanned: 0 }
  if (typeof query !== 'string' || query.length === 0) {
    return { matches: [], truncated: false, filesScanned: 0 }
  }
  const pattern = buildPattern(query, opts)
  const matches: ContentSearchMatch[] = []
  let filesScanned = 0
  let truncated = false
  const deadline = Date.now() + TIME_BUDGET_MS

  async function walk(dir: string): Promise<void> {
    if (truncated || Date.now() > deadline) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // 目录消失/无权限:跳过
    }
    for (const it of entries) {
      if (truncated || Date.now() > deadline) return
      if (it.name.startsWith('.')) continue
      const abs = join(dir, it.name)
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name)) await walk(abs)
        continue
      }
      if (!it.isFile()) continue
      let buf: Buffer
      try {
        const stat = await fsp.stat(abs)
        if (stat.size > MAX_FILE_BYTES) continue
        buf = await fsp.readFile(abs)
      } catch {
        continue
      }
      if (looksBinary(buf)) continue
      filesScanned++
      const text = buf.toString('utf8')
      const lines = text.split(/\r\n|\n|\r/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pattern.exec(line)) !== null) {
          matches.push({
            path: abs,
            relPath: abs.slice(root!.length + 1),
            line: i + 1,
            column: m.index + 1,
            matchLen: Math.max(m[0].length, 1),
            lineText: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line
          })
          if (matches.length >= MAX_MATCHES) {
            truncated = true
            return
          }
          // 空匹配(如正则 a*)防死循环
          if (m[0].length === 0) pattern.lastIndex++
        }
      }
    }
  }

  await walk(root)
  if (Date.now() > deadline) truncated = true
  return { matches, truncated, filesScanned }
}

export function registerSearchIpc(): void {
  ipcMain.handle(
    'search:content',
    (_e, query: string, opts: ContentSearchOptions): Promise<ContentSearchResult> =>
      searchContent(query, opts ?? { caseSensitive: false, wholeWord: false, regex: false })
  )
}
