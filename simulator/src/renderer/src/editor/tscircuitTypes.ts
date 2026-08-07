/**
 * tscircuit TSX 智能提示 —— extraLib 惰性注入(硬件设计工程 design/*.tsx)
 *
 * injectTscircuitTypes():把 @tscircuit/core / @tscircuit/props 的 d.ts 与最小
 * react / react/jsx-runtime 类型桩注入 Monaco TS worker,使 <board>/<chip>/... 元素
 * 及其属性获得类型级补全 / 悬停 / 诊断(配套 jsx: ReactJSX 见 monacoSetup.ts)。
 *
 * - 惰性:d.ts 载荷 ~17MB 在独立异步 chunk(tscircuitTypesChunk.ts),EditorHost
 *   首次建 design/*.tsx model 时才拉取,不拖慢常规启动/应用工程路径
 * - 幂等:并发/重复调用共享同一 Promise;失败(chunk 加载异常)后清除缓存,
 *   下次调用可重试
 * - 注入时机不敏感:addExtraLib 触发 worker 重建程序并对全部已开 model 重新
 *   诊断(DiagnosticsAdapter 订阅 onDidExtraLibsChange),model 先建后注入也会收敛
 *
 * syncDesignSiblingLibs():design/ 目录内跨文件相对导入的解析支撑(如模板
 * board.tsx → './esp32-s3-mini'),把同目录其余 .ts/.tsx 注册为 extraLib,
 * 并订阅工作区 fs 事件保持内容新鲜。详见函数头注释。
 */
import { monaco } from './monacoSetup'

let injectPromise: Promise<void> | null = null

/** 是否已成功注入(冒烟/调试观测用) */
export function tscircuitTypesInjected(): boolean {
  return injected
}
let injected = false

/** 注入 tscircuit 类型 extraLibs(幂等,惰性加载 17MB chunk;失败可重试) */
export function injectTscircuitTypes(): Promise<void> {
  if (!injectPromise) {
    injectPromise = doInject().catch((err: unknown) => {
      injectPromise = null // 失败(如 chunk 加载被打断)允许下次重试
      throw err
    })
  }
  return injectPromise
}

async function doInject(): Promise<void> {
  const { TSCIRCUIT_EXTRA_LIBS } = await import('./tscircuitTypesChunk')
  const defaults = monaco.languages.typescript.typescriptDefaults
  for (const lib of TSCIRCUIT_EXTRA_LIBS) {
    defaults.addExtraLib(lib.content, lib.filePath)
  }
  injected = true
}

// ---------------------------------------------------------------
// design/ 兄弟文件跨文件解析(多文件硬件工程,如 board.tsx → './esp32-s3-mini')
// ---------------------------------------------------------------
//
// 机制:把打开文件同目录的其余 design/*.ts(x) 以「真实 file:// 路径」注册为
// extraLib。TS worker 的模块解析(fileExists/readFile)依次查 打开的 model →
// extraLibs,因此:
// - 相对导入按 model uri 解析,命中同路径 extraLib 即成功;
// - 用户把某兄弟文件真正打开(EditorHost 建 model)后,model 恒优先于同路径
//   extraLib —— 未保存的编辑内容不会被本模块覆盖,无需感知编辑器脏状态;
// - addExtraLib 同路径换内容会触发 onDidExtraLibsChange → 全部已开 model 重新
//   诊断,天然解决「改保存了兄弟文件,board.tsx 诊断不刷新」的陈旧问题。

/** 已注册的 design extraLib:uri 字符串 → disposable(unlink 时移除) */
const designLibs = new Map<string, { dispose(): void }>()
/** 已同步过的 design 目录(POSIX 路径);fs 事件按目录过滤 */
const syncedDesignDirs = new Set<string>()
let fsRefreshInstalled = false

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 读盘并把单个 design 文件注册/刷新为 extraLib(读失败静默:删除流程走 unlink) */
async function registerDesignLib(absPath: string): Promise<void> {
  try {
    const content = await window.api.readFile(absPath)
    const uri = monaco.Uri.file(absPath).toString()
    const d = monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri)
    designLibs.set(uri, d)
  } catch {
    // 文件正被删除/暂不可读:忽略,后续 unlink 事件或下次同步兜底
  }
}

/** 工作区 fs 事件 → 刷新受管的 design extraLib(只装一次,常驻) */
function installFsRefresh(): void {
  if (fsRefreshInstalled) return
  fsRefreshInstalled = true
  window.api.onFsEvent((ev) => {
    const p = toPosix(ev.path)
    if (!/\.(tsx|ts)$/i.test(p)) return
    const dir = p.slice(0, p.lastIndexOf('/'))
    if (!syncedDesignDirs.has(dir)) return
    if (ev.type === 'unlink') {
      const uri = monaco.Uri.file(ev.path).toString()
      designLibs.get(uri)?.dispose() // 移除后引用它的 model 立刻报「找不到模块」
      designLibs.delete(uri)
    } else if (ev.type === 'add' || ev.type === 'change') {
      void registerDesignLib(ev.path)
    }
  })
}

/**
 * 把 openedPath(某个 design/*.ts(x) model)同目录的其余 .ts/.tsx 注册为
 * extraLib,使相对导入跨文件解析;并订阅 fs 事件保持新鲜。
 * 幂等、非 design 目录直接返回;与 evaluateDesign 一致只看 design/ 直接子文件。
 */
export async function syncDesignSiblingLibs(openedPath: string): Promise<void> {
  const posix = toPosix(openedPath)
  const dir = posix.slice(0, posix.lastIndexOf('/'))
  if (!dir.endsWith('/design')) return
  syncedDesignDirs.add(dir)
  installFsRefresh()
  try {
    const entries = await window.api.readDir(dir)
    await Promise.all(
      entries
        .filter((e) => !e.isDir && /\.(tsx|ts)$/i.test(e.name) && toPosix(e.path) !== posix)
        .map((e) => registerDesignLib(e.path))
    )
  } catch {
    // 目录暂不可读(工作区切换中):下次打开 design 文件时重试
  }
}
