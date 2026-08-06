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

/** 新建项目向导:项目模板(像素动画 Hello / 空白项目) */
export type ProjectTemplate = 'hello' | 'blank'

/** 新建项目向导:创建参数(project:create) */
export interface ProjectCreateOptions {
  /** 项目名 = 目录名,[a-zA-Z0-9_-] */
  name: string
  /** 父目录绝对路径(目录名拼接在其下) */
  location: string
  template: ProjectTemplate
  /** 应用 ID(反域名,如 com.example.myapp) */
  appId: string
}

/** 新建项目向导:创建结果 */
export interface ProjectCreateResult {
  /** 新项目根目录绝对路径 */
  root: string
  /** src/main.ts 绝对路径(创建后编辑器自动打开) */
  mainTs: string
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

/**
 * 虚拟设备档案(设备管理器,持久化于 userData/pixelbox-sim/devices.json)
 * chip 合法值见 shared/chipCapabilities.ts 的 CHIP_IDS(单一数据源)
 */
export interface DeviceProfile {
  /** 稳定 ID(内置档案为 'pixelbox-s3',用户档案为随机串) */
  id: string
  name: string
  /** esp32s3 / esp32c6 / esp32p4 / esp32 / esp32c3 */
  chip: string
  screenW: number
  screenH: number
  /** PSRAM 容量 MB(0 = 无;不支持 PSRAM 的芯片强制 0) */
  psramMB: number
  /** Flash 容量 MB(4/8/16) */
  flashMB: number
  note: string
  /** Unix 毫秒;内置档案为 0 */
  createdAt: number
}

// ---------------------------------------------------------------
// 固件工具链(阶段 3:IDE 内多芯片 编译/打包/烧录)
// ---------------------------------------------------------------

/** 固件任务类型:构建 / 打包 merged.bin / 烧录 / 清理构建目录 */
export type FirmwareTaskKind = 'build' | 'merge' | 'flash' | 'clean'

/** ESP-IDF 环境检测结果 */
export interface ToolchainInfo {
  /** 环境可用(IDF 存在且 export.sh / firmware 目录齐备) */
  ok: boolean
  /** 实际选用的 ESP-IDF 根目录(设置覆盖 > $IDF_PATH > ~/esp/esp-idf) */
  idfPath: string
  /** IDF 版本号(如 "v5.5.0";解析失败为 null) */
  version: string | null
  /** 仓库 firmware/ 目录绝对路径(构建 cwd) */
  firmwareDir: string
  /** 失败原因错误码(i18n key 后缀) */
  error?: 'idfNotFound' | 'exportMissing' | 'firmwareMissing' | 'unsupportedPlatform'
}

/** 一份固件产物(路径 + 体积) */
export interface FirmwareArtifact {
  /** 绝对路径 */
  path: string
  sizeBytes: number
}

/** 固件任务结束事件(toolchain:done) */
export interface FirmwareTaskResult {
  kind: FirmwareTaskKind
  /** 目标芯片(esp32s3 / esp32c6 / esp32p4 …) */
  target: string
  success: boolean
  /** 用户主动取消(success 恒 false) */
  cancelled: boolean
  /** 进程退出码(被信号杀死时为 null) */
  exitCode: number | null
  durationMs: number
  /** 成功时的产物列表(build → app bin;merge → merged.bin) */
  artifacts: FirmwareArtifact[]
  /** 失败摘要(启动失败等无日志场景) */
  message?: string
}

/** 固件任务运行状态(renderer 重载后恢复 UI 用) */
export interface FirmwareStatus {
  running: FirmwareTaskKind | null
  target: string | null
}

/** 扫描到的串口设备 */
export interface SerialPortInfo {
  /** 设备路径(/dev/cu.usbmodemXXXX 等) */
  path: string
  /** 短名(下拉展示) */
  label: string
}

/** 工具链设置(userData/pixelbox-sim/toolchain.json 持久化) */
export interface ToolchainSettings {
  /** ESP-IDF 路径覆盖(空串 = 自动检测 $IDF_PATH / ~/esp/esp-idf) */
  idfPathOverride: string
  /** 默认目标芯片(标题栏芯片下拉的初始值) */
  defaultTarget: string
  /** 烧录串口波特率 */
  baudRate: number
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
