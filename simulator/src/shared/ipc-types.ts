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

/** 工具链设置(settings.json 的 toolchain 段;旧 toolchain.json 已迁移弃用) */
export interface ToolchainSettings {
  /** ESP-IDF 路径覆盖(空串 = 自动检测 $IDF_PATH / ~/esp/esp-idf) */
  idfPathOverride: string
  /** 默认目标芯片(标题栏芯片下拉的初始值) */
  defaultTarget: string
  /** 烧录串口波特率 */
  baudRate: number
}

// ---------------------------------------------------------------
// IDE 设置(SettingsService,userData/pixelbox-sim/settings.json 单一落盘)
// ---------------------------------------------------------------

/** 界面语言 */
export type UiLanguage = 'zh-CN' | 'en'

/**
 * 全量 IDE 设置(类型化 schema;默认值与逐项校验见 shared/settingsSchema.ts)。
 * 读写走 dot-path 补丁(如 'editor.fontSize'),新增设置项在 settingsSchema.ts
 * 登记默认值 + 校验器即可,IPC/落盘/广播框架零改动。
 */
export interface AppSettings {
  /** 外观与行为 › 外观 */
  appearance: {
    /** 界面语言(设置窗口内立即预览,Apply 落盘) */
    language: UiLanguage
    /** 主题(当前仅深色;亮色规划中) */
    theme: 'dark'
  }
  /** 外观与行为 › 系统设置 */
  system: {
    /** 启动时恢复上次会话(工作区/标签/窗口;阶段 2 消费) */
    restoreSession: boolean
    /** 关闭主窗口时退出应用(macOS 默认驻留 Dock) */
    quitOnMainWindowClose: boolean
  }
  /** 编辑器(Monaco) */
  editor: {
    /** 代码缩略图 */
    minimap: boolean
    /** 字号 12-20 */
    fontSize: number
    /** Tab 宽度 2/4 */
    tabSize: number
    /** 编辑器字体族(默认 JetBrains Mono;字体文件阶段 2 引入) */
    fontFamily: string
  }
  /** 工具 › 固件工具链(迁移自旧 toolchain.json,能力等价) */
  toolchain: ToolchainSettings
  /** 工具 › 终端 */
  terminal: {
    /** shell 覆盖(空串 = $SHELL;仅对新建会话生效) */
    shellOverride: string
    /** 终端字号(对已打开会话即时生效) */
    fontSize: number
  }
}

/** settings:changed 全窗口广播事件 */
export interface SettingsChangedEvent {
  /** 变更后的全量设置 */
  settings: AppSettings
  /** 实际发生变化的 dot-path 键(如 'editor.minimap') */
  changedKeys: string[]
}

// ---------------------------------------------------------------
// 会话恢复(阶段 2:窗口状态 / 上次工作区 / 编辑器标签;受 system.restoreSession 控制)
// ---------------------------------------------------------------

/** 编辑器会话中的一个标签(viewState = Monaco saveViewState() 的 JSON 序列化,滚动/光标) */
export interface SessionTab {
  /** 文件绝对路径(恢复时已删除的文件静默跳过) */
  path: string
  viewState: unknown | null
}

/**
 * 按工作区持久化的编辑器会话(userData/pixelbox-sim/sessions/ws-<hash>.json)。
 * 脏文件内容不落盘(以最后保存到磁盘的内容为准),只记打开的标签与视图状态。
 */
export interface WorkspaceSession {
  /** 工作区根(绝对路径) */
  root: string
  /** 打开的标签(有序) */
  tabs: SessionTab[]
  /** 激活标签路径(无则 null) */
  activePath: string | null
  /** 落盘时间(Unix 毫秒) */
  savedAt: number
}

/** session:update 载荷(renderer 去抖推送;main 内存即时 + 去抖落盘 + 退出双保险) */
export interface SessionUpdatePayload {
  /** 当前工作区根(null = 欢迎页,启动不再恢复工作区) */
  workspaceRoot: string | null
  /** 当前工作区的编辑器会话(workspaceRoot 非空时携带) */
  session?: WorkspaceSession
}

/** 启动恢复信息(session:startup;renderer 据此恢复上次会话或回欢迎页) */
export interface SessionStartupInfo {
  /** 设置「启动时恢复上次会话」当前值(false = 回默认布局欢迎页) */
  restore: boolean
  /** 上次工作区根(目录仍存在);无记录或已不存在为 null */
  lastWorkspace: string | null
  /** 有记录但目录已不存在(renderer 通知用户后回欢迎页) */
  lastWorkspaceMissing: boolean
  /** 上次工作区的编辑器会话(无则 null) */
  session: WorkspaceSession | null
}

// ---------------------------------------------------------------
// 集成终端(JetBrains 式底部终端工具窗,阶段 1/2)
// ---------------------------------------------------------------

/** 终端后端:pty = node-pty 真伪终端;pipe = child_process 管道兜底(TERM=dumb,体验受限) */
export type TerminalBackend = 'pty' | 'pipe'

/** 一个终端会话(main 进程 PtyService 持有真实进程) */
export interface TerminalSessionInfo {
  /** 会话 ID(term-<自增>) */
  id: string
  /** 显示名:Local、Local (2)…(可重命名) */
  name: string
  backend: TerminalBackend
  /** 实际启动的 shell 可执行文件 */
  shell: string
  /** 工作目录(工作区根,无工作区为 HOME) */
  cwd: string
  /** shell 进程 pid(自检脚本断言进程回收用) */
  pid: number
}

/** 终端创建参数 */
export interface TerminalCreateOptions {
  /** 工作目录(renderer 传当前工作区根;缺省 HOME) */
  cwd?: string
  cols?: number
  rows?: number
}

/** 终端数据块(main → renderer,16ms 批量聚合下发) */
export interface TerminalDataChunk {
  id: string
  data: string
}

/** 终端会话退出事件 */
export interface TerminalExitEvent {
  id: string
  /** 进程退出码(被信号杀死为 null) */
  exitCode: number | null
}

// ---------------------------------------------------------------
// 工具窗独立窗口(视图模式 Window,阶段 2/2)
// ---------------------------------------------------------------

/**
 * 支持「独立窗口」的工具窗 id(main 进程白名单):
 * 终端(PTY 数据)与构建输出(build:log / toolchain:log)在 main 侧均为全窗口广播,
 * 因此可完整跨窗;其余工具窗状态在主窗 renderer 内,菜单项置灰
 */
export type StandaloneToolId = 'terminal' | 'build'

/** 独立工具窗关闭事件(toolwindow:closed 广播;renderer 将该工具窗回 Dock Pinned) */
export interface ToolWindowClosedEvent {
  id: StandaloneToolId
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
