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

/** 项目类型(app = TS 应用工程;firmware = ESP-IDF 固件工程;hardware = PCB+外壳硬件设计工程) */
export type ProjectKind = 'app' | 'firmware' | 'hardware'

/** 最近工作区条目(workspace:recents;kind 供标题栏下拉按项目类型显示图标) */
export interface RecentWorkspace {
  /** 绝对路径 */
  path: string
  /** null = 普通目录(非 pixelbox 工程) */
  kind: ProjectKind | null
}

/** 应用 manifest(pixelbox.json,字段见 docs/architecture.md §6) */
export interface PixelboxManifest {
  id: string
  name: string
  version: string
  entry: string
  assets?: string[]
  minFirmware?: string
  /** 项目类型(向后兼容:旧工程无 type 视为 app) */
  type?: ProjectKind
  /** firmware/hardware 工程记录默认目标芯片(ChipId) */
  chip?: string
}

/** 工作区项目信息(project:info) */
export interface ProjectInfo {
  /** null = 非 pixelbox 工程(普通目录,隐藏所有类型化动作) */
  kind: ProjectKind | null
  name: string | null
  /** manifest.chip ?? null */
  chip: string | null
  manifest: PixelboxManifest | null
}

/** 新建项目向导:项目模板(像素动画 Hello / 空白项目,仅 kind=app) */
export type ProjectTemplate = 'hello' | 'blank'

/** 新建项目向导:创建参数(project:create) */
export interface ProjectCreateOptions {
  kind: ProjectKind
  /** 项目名 = 目录名,[a-zA-Z0-9_-] */
  name: string
  /** 父目录绝对路径(目录名拼接在其下) */
  location: string
  /** 应用 ID(kind=app 必填,反域名,如 com.example.myapp) */
  appId?: string
  /** kind=app:'hello' | 'blank' */
  template?: ProjectTemplate
  /** kind=firmware|hardware:目标芯片 ChipId,默认 'esp32s3' */
  chip?: string
}

/** 新建项目向导:创建结果 */
export interface ProjectCreateResult {
  /** 新项目根目录绝对路径 */
  root: string
  kind: ProjectKind
  /** 创建后要在编辑器打开的文件绝对路径(app=src/main.ts,firmware=main/main.c,hardware=design/board.tsx) */
  entryFile: string
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
  /** 硬件设计工程注册的完整硬件外观(3D 板卡+外壳;deviceProfiles isProfileShape 容忍额外字段) */
  hardware3d?: Hardware3D
}

// ---------------------------------------------------------------
// 硬件设计 3D 契约(挂在 DeviceProfile 上,亦被 hardware 面板使用)
// ---------------------------------------------------------------

/**
 * 元件类别(3D 形状工厂选型;buildBoardSpec 按 source_component 名前缀
 * + 焊盘数推断:U 前缀或含 ESP32 且焊盘 ≥40 → module,USB→usb,SW→button,
 * SD→sd,MIC→mic,LED→led,R/C→passive,J→connector,其余 chip)
 */
export type BoardComponentKind =
  | 'module'
  | 'usb'
  | 'button'
  | 'sd'
  | 'mic'
  | 'led'
  | 'passive'
  | 'connector'
  | 'chip'

/** 板上元件盒(简化 3D:挤出盒体) */
export interface BoardComponentBox {
  id: string
  name?: string
  /** 中心,mm,板中心为原点,Y 向上(Circuit JSON 坐标) */
  x: number
  y: number
  /** mm */
  w: number
  h: number
  /** 挤出高度,默认 2.5 */
  heightMM: number
  layer: 'top' | 'bottom'
  /** 元件类别(可选新增字段:旧档案缺省时按 'chip' 渲染,向后兼容) */
  kind?: BoardComponentKind
}

/** 板卡简化 3D 规格(从 Circuit JSON 提炼,自包含 —— 档案脱离工程也能渲染) */
export interface BoardSpec {
  widthMM: number
  heightMM: number
  /** pcb_board.thickness,默认 1.4 */
  thicknessMM: number
  /** 多边形板轮廓(可选,覆盖 width/height) */
  outline?: { x: number; y: number }[]
  components: BoardComponentBox[]
  /** 阻焊色,默认 '#1a7f37' */
  color?: string
}

/** 屏幕在板上的放置(屏幕内容贴图 + 触摸映射) */
export interface ScreenPlacement {
  /** 屏幕中心相对板中心,mm */
  x: number
  y: number
  /** 屏幕可视区,mm */
  w: number
  h: number
  rotationDeg?: 0 | 90 | 180 | 270
}

/** 外壳侧壁开孔(USB / 按键等) */
export interface EnclosurePort {
  wall: 'north' | 'south' | 'east' | 'west'
  x: number
  y: number
  w: number
  h: number
  r?: number
}

/** 参数化外壳(默认值常量 DEFAULT_ENCLOSURE 见 shared/hardwareDefaults.ts) */
export interface EnclosureParams {
  /** 壁厚,默认 2 */
  wallMM: number
  /** 板与内壁间隙,默认 1 */
  clearanceMM: number
  /** 底盒内腔高(板下表面以上),默认 12 */
  baseHeightMM: number
  /** 顶盖内腔高,默认 3 */
  lidHeightMM: number
  /** 支撑柱高,默认 4 */
  standoffHeightMM: number
  /** 默认 3 */
  standoffOuterR: number
  /** 螺孔半径,默认 1.1(M2 自攻) */
  standoffInnerR: number
  /** 外壳圆角,默认 2 */
  cornerR: number
  /** 顶盖开屏幕窗(需 screen 放置) */
  screenWindow: boolean
  ports: EnclosurePort[]
  /** 外壳颜色 '#rrggbb'(base+lid 材质色;缺省用查看器内置灰色) */
  colorHex?: string
  /** 电池占位(底盒内腔可视化,w/h 足印 × t 厚,mm;仅 3D 展示,不参与 STL 打印导出) */
  batteryMM?: { w: number; h: number; t: number }
}

/**
 * OpenSCAD 外壳契约元数据(enclosure.scad 的 PB_META echo,IDE 从编译日志解析;
 * 用户删掉 echo 行时为 null,查看器回退包围盒推导)
 */
export interface EnclosureScadMeta {
  /** 板顶面 z(scad Z-up;three 场景即 y)—— 板卡抬高契约 */
  boardTopZ: number
  /** 屏幕贴图面 z(顶盖外表面 − 微沉) */
  screenFaceZ: number | null
  /** 壳体总高 */
  lidTopZ: number | null
  /** 底盒顶缘 z */
  baseTopZ: number | null
  outerW: number | null
  outerD: number | null
  screenWindow: boolean
  /** 电池占位盒 [w, d, t](scad 侧已按内腔/支撑柱/板底钳制;null = 关闭) */
  battery: [number, number, number] | null
  /** 电池底面 z(底盒内腔地面 = 底板厚) */
  batteryZ: number | null
  /** 预览色(base 原色;lid 由查看器自动提亮) */
  colorHex: string | null
}

/**
 * OpenSCAD 编译产物(base64 STL:需 JSON 序列化进设备档案 devices.json,
 * ArrayBuffer 会被 stringify 吞掉)
 */
export interface EnclosureScadPayload {
  baseStlB64: string
  lidStlB64: string
  meta: EnclosureScadMeta | null
}

/** 设备档案携带的完整硬件外观 */
export interface Hardware3D {
  board: BoardSpec
  /**
   * 参数化外壳(旧档案兼容:scad 之前的档案仅有此字段,Sim 3D 走参数化渲染;
   * 新档案已不写 —— enclosure.json 退役后工作区流程只产出 scad)
   */
  enclosure?: EnclosureParams
  /** OpenSCAD 外壳(design/enclosure.scad 编译产物;存在时几何优先) */
  scad?: EnclosureScadPayload
  screen?: ScreenPlacement
  /** 来源工程(仅提示用) */
  designRoot?: string
}

// ---------------------------------------------------------------
// 打印机(OctoPrint / Moonraker,main 进程 printer.ts)
// ---------------------------------------------------------------

export type PrinterType = 'octoprint' | 'moonraker' | 'bambu'

/** 归一化打印任务状态(printer:job) */
export interface PrinterJobStatus {
  /** 'printing'|'operational'|'paused'|'complete'|'error'|... 原样透传 */
  state: string
  /** 0..1 */
  completion: number
  printTimeLeftSec?: number
  fileName?: string
}

export interface PrinterUploadResult {
  printStarted: boolean
  remoteName: string
}

// ---------------------------------------------------------------
// 硬件导出(hardware:export,写 <root>/export/<kind>/)
// ---------------------------------------------------------------

export interface HardwareExportFile {
  name: string
  dataB64: string
}

export interface HardwareExportResult {
  dir: string
  files: string[]
}

// ---------------------------------------------------------------
// 项目内容检索(search:content,IDEA ⇧⌘F Find in Files)
// ---------------------------------------------------------------

export interface ContentSearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/** 单处命中(行/列 1-based;lineText 超长已截断) */
export interface ContentSearchMatch {
  path: string
  relPath: string
  line: number
  column: number
  matchLen: number
  lineText: string
}

export interface ContentSearchResult {
  matches: ContentSearchMatch[]
  /** 命中超上限(2000)或超时间预算:结果不完整,提示收窄查询 */
  truncated: boolean
  filesScanned: number
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
  /** clangd 可执行文件路径覆盖(空串 = PATH 中的 clangd → /usr/bin/clangd) */
  clangdPath: string
}

// ---------------------------------------------------------------
// clangd LSP(固件工程 C/C++ 补全/悬停/诊断,main 进程 clangd.ts)
// ---------------------------------------------------------------

/**
 * clangd 会话状态:
 * - running:会话已就绪,可收发 LSP 请求/通知
 * - noClangd:未找到 clangd 可执行文件(设置页可配置路径)
 * - noCompileCommands:工作区缺 build/compile_commands.json(先构建一次固件)
 * - failed:连续崩溃超过重启上限
 * - stopped:已停止(clangd:stop / 工作区切换)
 */
export type ClangdState = 'running' | 'noClangd' | 'noCompileCommands' | 'failed' | 'stopped'

/** clangd:start 返回值 / clangd:status 广播载荷 */
export interface ClangdStatus {
  state: ClangdState
  /** 实际选用的 clangd 可执行文件(state=running 时给出) */
  clangdPath?: string
}

/** clangd:event 广播载荷(白名单内的服务器通知,当前仅 publishDiagnostics) */
export interface ClangdServerNotification {
  method: string
  params: unknown
}

// ---------------------------------------------------------------
// ---- Git 集成 ----(main 进程 git.ts;JetBrains 式版本控制工具窗)
// ---------------------------------------------------------------

/** 文件变更徽标字母:M 修改 / A 新增 / D 删除 / R 重命名 / U 未跟踪 / C 冲突 / I 忽略(gitignore 命中) */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | 'C' | 'I'

/** 一个变更文件(git:status / git:commit-files) */
export interface GitFileChange {
  /** 绝对路径 */
  path: string
  /** 相对工作区根的路径('/' 分隔,列表展示用) */
  relPath: string
  status: GitFileStatus
  /** 重命名前的相对路径(status=R;diff 左侧取该路径的旧版本) */
  origRelPath?: string
}

/** git:status 结果(porcelain v2 解析;同一文件可同时出现在 staged 与 unstaged) */
export interface GitStatusResult {
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  conflicted: GitFileChange[]
  /** gitignore 命中条目(--ignored=matching 的 '!' 记录;目录整条列出不展开) */
  ignored: GitFileChange[]
}

/** 冲突解决策略(git:resolve):ours=采用我方 / theirs=采用对方 / mark=仅标记已解决(add) */
export type GitResolveStrategy = 'ours' | 'theirs' | 'mark'

/** 一个远程仓库(git:remotes;`git remote -v` 解析,fetch/push URL 可不同) */
export interface GitRemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
}

/** 系统原生 Git 菜单动作(main menu.ts → menu:git-action 广播) */
export type GitMenuAction =
  | 'commit'
  | 'push'
  | 'pull'
  | 'stageAll'
  | 'newBranch'
  | 'checkout'
  | 'remotes'
  | 'show'

/** menu:git-action 广播载荷(checkout 时 arg = 目标分支名) */
export interface GitMenuActionEvent {
  action: GitMenuAction
  arg?: string
}

/** 仓库概览(git:info) */
export interface GitInfo {
  /** root/.git 是否存在(false 时其余字段为默认值) */
  isRepo: boolean
  /** 当前分支名(detached HEAD → 短 hash;空仓库无提交 → 分支名仍给出) */
  branch: string | null
  /** upstream 分支名(如 origin/main;无 upstream → null) */
  upstream: string | null
  /** 相对 upstream 领先/落后提交数(无 upstream 恒 0) */
  ahead: number
  behind: number
  /** 已找到 git 可执行文件(false → 提示设置 git.executablePath) */
  gitFound: boolean
}

/** 一条提交记录(git:log;parents 供历史视图车道图布局) */
export interface GitCommitInfo {
  hash: string
  shortHash: string
  author: string
  email: string
  /** 作者时间(Unix 秒,%at) */
  timestamp: number
  subject: string
  /** 父提交完整 hash(合并提交多个;根提交空) */
  parents: string[]
}

/** 一个本地分支(git:branches) */
export interface GitBranchInfo {
  name: string
  current: boolean
}

/** push/pull 流式输出行(git:op-output 广播) */
export interface GitOpOutput {
  /** 操作结束标记行(done 时 text 为空串,exitCode 有效) */
  kind: 'line' | 'done'
  op: 'push' | 'pull'
  text: string
  exitCode?: number | null
}

/** git 可执行检测结果(设置页 git:detect) */
export interface GitDetectResult {
  found: boolean
  path: string
  version: string | null
}

// ---------------------------------------------------------------
// IDE 设置(SettingsService,userData/pixelbox-sim/settings.json 单一落盘)
// ---------------------------------------------------------------

/** 界面语言 */
export type UiLanguage = 'zh-CN' | 'en'

/** 主题设置值(system = 跟随操作系统,经 main 侧 nativeTheme 解析) */
export type AppTheme = 'dark' | 'light' | 'system'

/** 解析后的有效主题(驱动 <html data-theme> 与 Monaco/xterm 主题切换) */
export type EffectiveTheme = 'dark' | 'light'

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
    /** 主题:深色 / 亮色 / 跟随系统(nativeTheme 解析,updated 事件全窗口推送) */
    theme: AppTheme
    /** 3D 视图左下角坐标轴指示器(硬件 3D / 模拟器 3D,实时生效) */
    show3dAxes: boolean
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
    /** 终端字体族(默认 JetBrains Mono;缺字回退链见 xtermRegistry;即时生效) */
    fontFamily: string
    /** 行高倍数 1.0-2.0,0.1 步进(xterm lineHeight;即时生效) */
    lineHeight: number
  }
  /** 工具 › 3D 打印机(OctoPrint / Moonraker / 拓竹 Bambu LAN 联机) */
  printer: {
    /** 驱动类型 */
    type: PrinterType
    /** 服务地址(OctoPrint/Moonraker 为 http URL;拓竹为打印机 IP;空串 = 未配置) */
    baseUrl: string
    /** API Key(OctoPrint 必填;Moonraker 可选;拓竹不用) */
    apiKey: string
    /** 拓竹机身序列号(MQTT 主题路径;设备信息页可查) */
    bambuSerial: string
    /** 拓竹 LAN 访问码(打印机屏幕 网络设置 页) */
    bambuAccessCode: string
  }
  /** 工具 › Git(版本控制) */
  git: {
    /** git 可执行路径覆盖(空串 = 自动:PATH 中的 git → /usr/bin/git) */
    executablePath: string
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
 * 按工程持久化的编辑器会话(JetBrains .idea 式:<root>/.ide/session.json,
 * 落盘时去掉 root 字段 —— 工程整体移动后仍可解析;旧版 userData
 * sessions/ws-<hash>.json 首次读取时一次性迁移写穿)。
 * 脏文件内容不落盘(以最后保存到磁盘的内容为准),只记打开的标签与视图状态。
 * 读取:session:startup(IDE 启动)与 session:for-root(切换工作区)。
 */
/** 编辑器组会话(分屏;组 0 与旧字段 tabs/activePath 同值,旧版 IDE 兼容) */
export interface SessionGroup {
  tabs: SessionTab[]
  activePath: string | null
}

export interface WorkspaceSession {
  /** 工作区根(绝对路径;IPC 往返携带,.ide/session.json 不落盘此字段) */
  root: string
  /** 打开的标签(有序;分屏时 = 组 0,完整分组见 groups) */
  tabs: SessionTab[]
  /** 激活标签路径(无则 null;分屏时 = 组 0) */
  activePath: string | null
  /** 分屏会话(1-2 组;缺省 = 单组,tabs/activePath 即全部) */
  groups?: SessionGroup[]
  /** 分屏方向(groups 长度 > 1 时有效) */
  splitDir?: 'row' | 'col' | null
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

/** 真机日志行(devd logs.subscribe 事件;main 常驻订阅后经 devd:log 批量广播) */
export interface DevdLogEvent {
  /** 来源设备 key(ip:port,与外壳 store 的 deviceKey 一致) */
  deviceKey: string
  level: 'debug' | 'info' | 'warn' | 'error'
  tag: string
  msg: string
  /** 设备侧毫秒时间戳(未同步 NTP 时接近 1970,渲染端回退用接收时间) */
  ts: number
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
