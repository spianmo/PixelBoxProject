/**
 * Git 输出解析纯函数(main 进程 git.ts 消费;不依赖 electron/node,
 * 可被独立 node 脚本喂真实 git 输出做断言测试)
 *
 * - parseStatusPorcelainV2:`git status --porcelain=v2 -z --branch` → 分支头信息
 *   + 已暂存/未暂存/未跟踪/冲突/忽略 五组条目(相对路径;绝对路径由 main 侧拼接;
 *   忽略组需调用时加 --ignored=matching 才有 '!' 记录)
 * - parseGitLog:`git log --format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%P` → GitCommitInfo[]
 * - parseNameStatusZ:`git diff --name-status -z` / `git diff-tree … -z` → 变更文件条目
 * - parseRemotesV:`git remote -v` → GitRemoteInfo[](fetch/push URL 分列)
 * - layoutCommitGraph:按 parents 给 commit 列表布置泳道(SVG 车道图数据)
 */
import type { GitCommitInfo, GitFileStatus, GitRemoteInfo } from './ipc-types'

/** 解析出的单个文件条目(相对路径,'/' 分隔) */
export interface ParsedStatusEntry {
  relPath: string
  status: GitFileStatus
  /** 重命名前的相对路径(status=R) */
  origRelPath?: string
}

/** `git status --porcelain=v2 --branch` 的完整解析结果 */
export interface ParsedStatus {
  branch: {
    /** HEAD commit(空仓库 (initial) → null) */
    oid: string | null
    /** 分支名;detached HEAD → '(detached)' 原样保留,由调用方判断 */
    head: string | null
    /** upstream 分支名(无 upstream → null) */
    upstream: string | null
    ahead: number
    behind: number
  }
  staged: ParsedStatusEntry[]
  unstaged: ParsedStatusEntry[]
  untracked: ParsedStatusEntry[]
  conflicted: ParsedStatusEntry[]
  /** gitignore 命中('!' 记录;仅 --ignored=matching 时出现,目录整条不展开) */
  ignored: ParsedStatusEntry[]
}

/** porcelain 状态字符 → 徽标字母(T 类型变化归 M;C 拷贝归 A;'.' 无变化 → null) */
function letterFrom(ch: string | undefined): GitFileStatus | null {
  switch (ch) {
    case 'M':
    case 'T':
      return 'M'
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'C':
      return 'A'
    default:
      return null
  }
}

export function parseStatusPorcelainV2(raw: string): ParsedStatus {
  const out: ParsedStatus = {
    branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 0 },
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ignored: []
  }
  // -z 模式:记录之间以 NUL 分隔('2' 记录的 origPath 是紧随其后的独立 NUL 字段)
  const tokens = raw.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i]
    if (rec.length === 0) continue
    if (rec.startsWith('# ')) {
      const parts = rec.slice(2).split(' ')
      const key = parts[0]
      if (key === 'branch.oid') {
        out.branch.oid = parts[1] === '(initial)' ? null : (parts[1] ?? null)
      } else if (key === 'branch.head') {
        out.branch.head = parts.slice(1).join(' ') || null
      } else if (key === 'branch.upstream') {
        out.branch.upstream = parts.slice(1).join(' ') || null
      } else if (key === 'branch.ab') {
        for (const p of parts.slice(1)) {
          const n = Number.parseInt(p.slice(1), 10)
          if (!Number.isFinite(n)) continue
          if (p.startsWith('+')) out.branch.ahead = n
          else if (p.startsWith('-')) out.branch.behind = n
        }
      }
      continue
    }
    const kind = rec[0]
    if (kind === '?') {
      out.untracked.push({ relPath: rec.slice(2), status: 'U' })
      continue
    }
    if (kind === '!') {
      // --ignored=matching 的忽略条目(目录以尾随 '/' 整条给出,不展开内容)
      out.ignored.push({ relPath: rec.slice(2), status: 'I' })
      continue
    }
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue // 其余记录类型跳过
    const parts = rec.split(' ')
    const xy = parts[1] ?? '..'
    // 固定字段数:'1' 8 个 / '2' 9 个(多 Xscore)/ 'u' 10 个,其后为路径(可含空格)
    const skip = kind === '1' ? 8 : kind === '2' ? 9 : 10
    const relPath = parts.slice(skip).join(' ')
    if (relPath.length === 0) continue
    if (kind === 'u') {
      out.conflicted.push({ relPath, status: 'C' })
      continue
    }
    let origRelPath: string | undefined
    if (kind === '2') {
      origRelPath = tokens[i + 1]
      i++
    }
    const stagedLetter = letterFrom(xy[0])
    const unstagedLetter = letterFrom(xy[1])
    if (stagedLetter) {
      out.staged.push(
        origRelPath !== undefined
          ? { relPath, status: stagedLetter, origRelPath }
          : { relPath, status: stagedLetter }
      )
    }
    if (unstagedLetter) out.unstaged.push({ relPath, status: unstagedLetter })
  }
  return out
}

export function parseGitLog(raw: string): GitCommitInfo[] {
  const out: GitCommitInfo[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const f = line.split('\0')
    if (f.length < 7) continue
    const ts = Number.parseInt(f[4], 10)
    out.push({
      hash: f[0],
      shortHash: f[1],
      author: f[2],
      email: f[3],
      timestamp: Number.isFinite(ts) ? ts : 0,
      subject: f[5],
      parents: f[6].length > 0 ? f[6].split(' ') : []
    })
  }
  return out
}

export function parseNameStatusZ(raw: string): ParsedStatusEntry[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0)
  const out: ParsedStatusEntry[] = []
  for (let i = 0; i < tokens.length; ) {
    const st = tokens[i]
    const c = st[0]
    // R<score>/C<score> 后跟两个路径字段(旧 → 新)
    if (c === 'R' || c === 'C') {
      const orig = tokens[i + 1]
      const dest = tokens[i + 2]
      i += 3
      if (dest === undefined || orig === undefined) break
      out.push({ relPath: dest, status: c === 'R' ? 'R' : 'A', origRelPath: orig })
    } else {
      const p = tokens[i + 1]
      i += 2
      if (p === undefined) break
      const letter = letterFrom(c)
      if (letter) out.push({ relPath: p, status: letter })
    }
  }
  return out
}

/**
 * 解析 `git remote -v` 输出为远程仓库列表。
 * 行格式:`<name>\t<url> (fetch)` / `<name>\t<url> (push)`;同名 fetch/push
 * 合并为一条(URL 可不同,如 set-url --push 之后)。缺一侧时以另一侧回填。
 */
export function parseRemotesV(raw: string): GitRemoteInfo[] {
  const map = new Map<string, { fetchUrl: string; pushUrl: string }>()
  const order: string[] = []
  for (const line of raw.split('\n')) {
    const m = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line.trimEnd())
    if (!m) continue
    const [, name, url, kind] = m
    let entry = map.get(name)
    if (!entry) {
      entry = { fetchUrl: '', pushUrl: '' }
      map.set(name, entry)
      order.push(name)
    }
    if (kind === 'fetch') entry.fetchUrl = url
    else entry.pushUrl = url
  }
  return order.map((name) => {
    const e = map.get(name) as { fetchUrl: string; pushUrl: string }
    return {
      name,
      fetchUrl: e.fetchUrl || e.pushUrl,
      pushUrl: e.pushUrl || e.fetchUrl
    }
  })
}

// ---------------------------------------------------------------
// 提交车道图布局(历史视图左侧 SVG)
// ---------------------------------------------------------------

/**
 * 单行车道图数据(行高中点为节点圆心):
 * - passLanes:与本节点无关、全高垂直穿过的泳道
 * - inLanes:上半段汇入节点的泳道(上一行延续/分支汇合;含节点自身泳道)
 * - outLanes:下半段从节点发出的泳道(父提交连线;第一父占节点泳道)
 */
export interface GitGraphRow {
  /** 节点所在泳道 */
  lane: number
  /** 本行涉及的泳道总数(SVG 宽度参考) */
  laneCount: number
  passLanes: number[]
  inLanes: number[]
  outLanes: number[]
}

/**
 * 泳道分配:自上而下扫描,lanes[i] = 该泳道正在等待的父 hash。
 * 节点落在等待它的最左泳道(其余等待泳道汇入并释放);第一父继承节点泳道,
 * 其余父分配空闲泳道(已有等待泳道则连线汇入)。简洁实现,不追求 gitk 级别。
 */
export function layoutCommitGraph(commits: readonly GitCommitInfo[]): GitGraphRow[] {
  const lanes: (string | null)[] = []
  const rows: GitGraphRow[] = []
  for (const c of commits) {
    const inLanes: number[] = []
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.hash) inLanes.push(j)
    let lane: number
    if (inLanes.length > 0) {
      lane = inLanes[0]
    } else {
      const free = lanes.indexOf(null)
      if (free >= 0) lane = free
      else {
        lane = lanes.length
        lanes.push(null)
      }
    }
    for (const j of inLanes) if (j !== lane) lanes[j] = null // 汇入后释放
    const outLanes: number[] = []
    lanes[lane] = c.parents[0] ?? null
    if (c.parents.length > 0) outLanes.push(lane)
    for (let pi = 1; pi < c.parents.length; pi++) {
      const p = c.parents[pi]
      let idx = lanes.indexOf(p)
      if (idx < 0) {
        idx = lanes.indexOf(null)
        if (idx < 0) {
          idx = lanes.length
          lanes.push(p)
        } else {
          lanes[idx] = p
        }
      }
      outLanes.push(idx)
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    const passLanes: number[] = []
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] !== null && !inLanes.includes(j) && !outLanes.includes(j)) {
        passLanes.push(j)
      }
    }
    const laneCount = Math.max(
      lane + 1,
      lanes.length,
      ...inLanes.map((n) => n + 1),
      ...outLanes.map((n) => n + 1)
    )
    rows.push({ lane, laneCount, passLanes, inLanes, outLanes })
  }
  return rows
}
