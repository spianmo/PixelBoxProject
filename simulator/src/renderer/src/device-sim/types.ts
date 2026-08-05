/**
 * 设备模拟引擎 ↔ IDE 外壳(sim-shell)之间的接口契约
 *
 * 本文件由 sim-shell 定义并被外壳代码引用,device-sim 实现方【不得修改已有签名】,
 * 可以在文件末尾追加自己的内部类型。详见同目录 README.md。
 */

/** 应用 manifest(与 docs/architecture.md §6 的 pixelbox.json 一致) */
export interface SimManifest {
  id: string
  name: string
  version: string
  entry: string
  assets?: string[]
  minFirmware?: string
}

/** 模拟器运行状态 */
export type SimRunState = 'running' | 'stopped' | 'crashed'

/**
 * 设备模拟引擎全局 API —— 引擎就绪后必须挂到 window.__pixelboxSim
 * 外壳工具栏「运行 / 停止 / 热重载」都通过它驱动
 */
export interface PixelboxSimApi {
  /**
   * 加载并运行一个应用包
   * @param bundleCode esbuild 打包出的单文件 ES2020 代码(dist/main.js 内容)
   * @param manifest   应用 manifest(pixelbox.json 解析结果)
   * 重复调用 = 热重载(先停旧应用再起新应用)
   */
  load(bundleCode: string, manifest: SimManifest): Promise<void>
  /** 停止当前应用(卸载沙箱 iframe,触发 px.app.onExit) */
  stop(): void
  /** 当前是否有应用在运行 */
  readonly running: boolean
}

/** 引擎 → 外壳的日志事件负载(经 window CustomEvent 派发) */
export interface SimLogDetail {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  /** 已格式化的单行文本 */
  text: string
  ts: number
}

/** 引擎 → 外壳的运行状态事件负载 */
export interface SimStateDetail {
  state: SimRunState
  /** crashed 时的错误说明 */
  error?: string
}

declare global {
  interface Window {
    /** 设备模拟引擎就绪后挂载;外壳每次使用前做存在性检查 */
    __pixelboxSim?: PixelboxSimApi
    /**
     * 【device-sim 追加,已知会 sim-shell】运行上下文:
     * 外壳在每次调用 __pixelboxSim.load 之前设置(运行与 watch 热重载均需),
     * 引擎据此预载 dist/(/app 只读包)并定位 userData 存储目录
     */
    __pixelboxSimContext?: SimRunContext
  }
  interface WindowEventMap {
    /** 引擎完成初始化(window.__pixelboxSim 可用)后派发 */
    'pixelbox-sim:ready': Event
    /** 应用内 console.* 输出(外壳显示在「应用日志」页) */
    'pixelbox-sim:log': CustomEvent<SimLogDetail>
    /** 应用运行状态变化 */
    'pixelbox-sim:state': CustomEvent<SimStateDetail>
  }
}

// ---------------------------------------------------------------
// 以下为 device-sim 追加类型(按 README §2 约定,不改动上方已有签名)
// ---------------------------------------------------------------

/** 一次 load 的运行上下文(外壳在 load 前写入 window.__pixelboxSimContext) */
export interface SimRunContext {
  /** 工作区根目录绝对路径(用于派生存储目录名与设备 ID) */
  workspaceRoot: string
  /** 构建产物 dist/ 绝对路径(/app 只读包来源) */
  outDir: string
}
