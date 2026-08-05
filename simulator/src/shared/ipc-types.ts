/**
 * main / preload / renderer 三端共享的 IPC 数据类型(纯类型,无运行时代码)
 */

/** 文件树条目 */
export interface FsEntry {
  name: string
  /** 绝对路径 */
  path: string
  isDir: boolean
}

/** chokidar 文件系统变更事件 */
export interface FsWatchEvent {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
  /** 绝对路径 */
  path: string
}

/** 应用 manifest(pixelbox.json,字段见 docs/architecture.md §6) */
export interface PixelboxManifest {
  id: string
  name: string
  version: string
  entry: string
  assets?: string[]
  minFirmware?: string
}

/** 构建日志行 */
export interface BuildLogLine {
  level: 'info' | 'warn' | 'error'
  text: string
  ts: number
}

/** 一次构建的结果 */
export interface BuildResult {
  success: boolean
  /** 打包产物 main.js 的完整代码(成功时) */
  code?: string
  manifest?: PixelboxManifest
  /** dist 输出目录绝对路径(成功时) */
  outDir?: string
  errors: string[]
  durationMs: number
}

/** mDNS 发现的 devd 设备 */
export interface DevdDevice {
  name: string
  host: string
  ip: string
  port: number
  txt: Record<string, string>
}

/** 真机推送进度 */
export interface PushProgress {
  phase: 'connect' | 'hello' | 'upload' | 'finalize' | 'done' | 'error'
  /** 0-100 */
  percent: number
  /** 当前正在传输的文件(upload 阶段) */
  file?: string
  message?: string
}
