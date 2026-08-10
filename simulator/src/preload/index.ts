/**
 * preload:通过 contextBridge 暴露类型安全的 window.api
 * 所有事件订阅返回取消函数,与 d.ts 契约的 Unsubscribe 风格一致
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  BuildLogLine,
  BuildResult,
  ClangdServerNotification,
  ClangdStatus,
  DevdDevice,
  DevdLogEvent,
  DeviceProfile,
  EffectiveTheme,
  FirmwareStatus,
  FirmwareTaskKind,
  FirmwareTaskResult,
  FsEntry,
  FsWatchEvent,
  GitBranchInfo,
  GitCommitInfo,
  GitDetectResult,
  GitFileChange,
  GitInfo,
  GitMenuActionEvent,
  GitOpOutput,
  GitRemoteInfo,
  GitResolveStrategy,
  GitStatusResult,
  ContentSearchOptions,
  ContentSearchResult,
  HardwareExportFile,
  HardwareExportResult,
  PrinterJobStatus,
  PrinterUploadResult,
  ProjectCreateOptions,
  ProjectCreateResult,
  ProjectInfo,
  PushProgress,
  RecentWorkspace,
  SerialPortInfo,
  SessionStartupInfo,
  SessionUpdatePayload,
  SettingsChangedEvent,
  StandaloneToolId,
  TerminalBackend,
  TerminalCreateOptions,
  TerminalDataChunk,
  TerminalExitEvent,
  TerminalSessionInfo,
  ToolWindowClosedEvent,
  ToolchainInfo,
  WorkspaceSession
} from '../shared/ipc-types'
import { simApi } from './simApi'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  platform: process.platform,

  // ---- IDE 外壳(自绘标题栏 / 系统集成) ----
  windowMinimize: (): void => ipcRenderer.send('win:minimize'),
  windowToggleMaximize: (): void => ipcRenderer.send('win:maximize-toggle'),
  windowClose: (): void => ipcRenderer.send('win:close'),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:is-maximized'),
  onWindowMaximized: (cb: (maximized: boolean) => void): (() => void) =>
    subscribe('win:maximized', cb),
  /** 查询当前窗口全屏态(macOS/Win/Linux 均为原生 isFullScreen) */
  windowIsFullScreen: (): Promise<boolean> => ipcRenderer.invoke('win:is-fullscreen'),
  /** 全屏态变化订阅(TitleBar 原生全屏下切换 假红绿灯/80px 预留区) */
  onWindowFullScreen: (cb: (fullscreen: boolean) => void): (() => void) =>
    subscribe('win:fullscreen', cb),
  /** 设置窗口全屏(假红绿灯绿键=退出全屏;走原生 setFullScreen) */
  windowSetFullScreen: (flag: boolean): void => ipcRenderer.send('win:set-fullscreen', flag),
  /** 读取工作区 git 分支(非 git 仓库返回 null) */
  gitBranch: (root: string): Promise<string | null> => ipcRenderer.invoke('shell:git-branch', root),
  /** 截图 PNG 字节落盘到 ~/Downloads,返回完整路径 */
  saveScreenshot: (png: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('shell:save-screenshot', png),
  /** 外部链接交给系统浏览器(仅 http(s)/mailto;Markdown 预览用) */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  /** 在系统文件管理器中定位文件/目录(macOS=Finder,Windows=资源管理器,Linux=文件管理器) */
  revealInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal-in-folder', path),
  /** 复制文本到系统剪贴板(右键菜单「复制路径 / 复制相对路径」) */
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('shell:copy-text', text),

  // ---- Git 集成 ----
  /** 检测 git 可执行文件(设置页实时回显;可传草稿路径不落盘试探) */
  gitDetect: (overridePath?: string): Promise<GitDetectResult> =>
    ipcRenderer.invoke('git:detect', overridePath),
  /** 仓库概览(是否 git 仓库 / 分支 / upstream / ahead-behind;顺带重挂 .git watcher) */
  gitInfo: (root: string): Promise<GitInfo> => ipcRenderer.invoke('git:info', root),
  /** 初始化仓库(addAll=true 时顺带 git add -A) */
  gitInit: (root: string, addAll?: boolean): Promise<void> =>
    ipcRenderer.invoke('git:init', root, addAll),
  /** 变更列表(staged/unstaged/untracked/conflicted 四组,路径为绝对路径) */
  gitStatus: (root: string): Promise<GitStatusResult> => ipcRenderer.invoke('git:status', root),
  /** 暂存指定文件(绝对路径数组) */
  gitStage: (root: string, paths: string[]): Promise<void> =>
    ipcRenderer.invoke('git:stage', root, paths),
  /** 取消暂存指定文件 */
  gitUnstage: (root: string, paths: string[]): Promise<void> =>
    ipcRenderer.invoke('git:unstage', root, paths),
  /** 丢弃工作区修改(untracked=true 走 clean 删除未跟踪文件;调用前须经用户确认) */
  gitDiscard: (root: string, paths: string[], untracked?: boolean): Promise<void> =>
    ipcRenderer.invoke('git:discard', root, paths, untracked),
  /** 提交暂存区(空暂存区抛 git:nothingToCommit) */
  gitCommit: (root: string, message: string): Promise<void> =>
    ipcRenderer.invoke('git:commit', root, message),
  /** 推送(流式输出经 onGitOpOutput;无 upstream 自动 -u origin <branch>) */
  gitPush: (root: string): Promise<void> => ipcRenderer.invoke('git:push', root),
  /** 拉取(流式输出经 onGitOpOutput;冲突抛 git:conflict) */
  gitPull: (root: string): Promise<void> => ipcRenderer.invoke('git:pull', root),
  /** 取消进行中的 push/pull(杀进程组) */
  gitCancelOp: (): Promise<void> => ipcRenderer.invoke('git:cancel-op'),
  /** 提交历史(最近 200 条;parents 供车道图布局) */
  gitLog: (root: string): Promise<GitCommitInfo[]> => ipcRenderer.invoke('git:log', root),
  /** 某 commit 的变更文件列表(diff-tree 相对第一父) */
  gitCommitFiles: (root: string, hash: string): Promise<GitFileChange[]> =>
    ipcRenderer.invoke('git:commit-files', root, hash),
  /** 某版本的文件内容(该版本无此文件返回空串;diff 页签数据源) */
  gitShowFile: (root: string, rev: string, relPath: string): Promise<string> =>
    ipcRenderer.invoke('git:show-file', root, rev, relPath),
  /** 本地分支列表(current 标记当前分支) */
  gitBranches: (root: string): Promise<GitBranchInfo[]> =>
    ipcRenderer.invoke('git:branches', root),
  /** 切分支(create=true 时新建;脏工作区冲突抛 git:dirtyWorktree) */
  gitCheckout: (root: string, branch: string, create?: boolean): Promise<void> =>
    ipcRenderer.invoke('git:checkout', root, branch, create),
  /** 冲突解决(ours/theirs 先 checkout 对应侧再 add;mark 仅 add 标记已解决) */
  gitResolve: (root: string, paths: string[], strategy: GitResolveStrategy): Promise<void> =>
    ipcRenderer.invoke('git:resolve', root, paths, strategy),
  /** Remote 列表(`git remote -v` 解析;fetch/push URL 分列) */
  gitRemotes: (root: string): Promise<GitRemoteInfo[]> => ipcRenderer.invoke('git:remotes', root),
  /** 添加 remote(名称 [A-Za-z0-9_.-]+ 且不以 - 开头;URL 非空不以 - 开头) */
  gitRemoteAdd: (root: string, name: string, url: string): Promise<void> =>
    ipcRenderer.invoke('git:remote-add', root, name, url),
  /** 删除 remote */
  gitRemoteRemove: (root: string, name: string): Promise<void> =>
    ipcRenderer.invoke('git:remote-remove', root, name),
  /** 修改 remote URL */
  gitRemoteSetUrl: (root: string, name: string, url: string): Promise<void> =>
    ipcRenderer.invoke('git:remote-set-url', root, name, url),
  /** 仓库变化订阅(.git 目录 watcher 去抖广播;外部 git 操作也触发) */
  onGitChanged: (cb: (ev: { root: string }) => void): (() => void) =>
    subscribe('git:changed', cb),
  /** push/pull 流式输出订阅(kind=done 为结束标记,exitCode 有效) */
  onGitOpOutput: (cb: (ev: GitOpOutput) => void): (() => void) =>
    subscribe('git:op-output', cb),
  /** 原生 Git 菜单动作订阅(main menu.ts 广播;git/menuBridge.ts 消费) */
  onGitMenuAction: (cb: (ev: GitMenuActionEvent) => void): (() => void) =>
    subscribe('menu:git-action', cb),
  /** 请求重建原生应用菜单(语言切换后菜单文案即时跟随) */
  menuRefresh: (): Promise<void> => ipcRenderer.invoke('menu:refresh'),
  /** File 菜单 ⌘W → 关闭当前编辑器页签(仅主窗收到) */
  onMenuCloseTab: (cb: () => void): (() => void) => subscribe('menu:close-tab', cb),

  // ---- 新建项目向导 ----
  /** 默认项目位置(~/PixelBoxProjects) */
  projectDefaultLocation: (): Promise<string> => ipcRenderer.invoke('project:default-location'),
  /** 系统目录选择对话框(「浏览…」),取消返回 null */
  chooseDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:choose-directory', defaultPath),
  /** 校验并按 kind 生成三类项目骨架,返回 { root, kind, entryFile } */
  projectCreate: (opts: ProjectCreateOptions): Promise<ProjectCreateResult> =>
    ipcRenderer.invoke('project:create', opts),
  /** 工作区项目信息(kind/name/chip/manifest;非 pixelbox 工程 kind 为 null) */
  projectInfo: (root: string): Promise<ProjectInfo> => ipcRenderer.invoke('project:info', root),

  // ---- 工作区 / 文件系统 ----
  openWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-workspace'),
  /** 按路径直接打开工作区(最近列表);目录不存在返回 null */
  openWorkspacePath: (root: string): Promise<string | null> =>
    ipcRenderer.invoke('workspace:open-path', root),
  /** 最近打开过的工作区(仍存在的目录;含项目类型供下拉显示图标) */
  recentWorkspaces: (): Promise<RecentWorkspace[]> => ipcRenderer.invoke('workspace:recents'),
  /** 工作区文件全量列举(相对路径,Cmd+P 快速打开) */
  listWorkspaceFiles: (): Promise<string[]> => ipcRenderer.invoke('workspace:list-files'),
  /** 项目内容检索(IDEA ⇧⌘F Find in Files;遍历规则同 ⌘P,命中上限/超时见 main/search.ts) */
  searchContent: (query: string, opts: ContentSearchOptions): Promise<ContentSearchResult> =>
    ipcRenderer.invoke('search:content', query, opts),
  readDir: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke('fs:read-dir', dir),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke('fs:read-file', p),
  /** 二进制读取(Markdown 预览的相对路径图片) */
  readFileBinary: (p: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('fs:read-file-binary', p),
  writeFile: (p: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fs:write-file', p, content),
  mkdir: (p: string): Promise<void> => ipcRenderer.invoke('fs:mkdir', p),
  createFile: (p: string): Promise<void> => ipcRenderer.invoke('fs:create-file', p),
  rename: (oldPath: string, newPath: string): Promise<void> =>
    ipcRenderer.invoke('fs:rename', oldPath, newPath),
  remove: (p: string): Promise<void> => ipcRenderer.invoke('fs:delete', p),
  watchWorkspace: (root: string): Promise<void> => ipcRenderer.invoke('workspace:watch', root),
  /** 工作区根的真实路径(符号链接解析;未打开工作区返回 null) */
  workspaceRealRoot: (): Promise<string | null> => ipcRenderer.invoke('workspace:real-root'),
  unwatchWorkspace: (): Promise<void> => ipcRenderer.invoke('workspace:unwatch'),
  onFsEvent: (cb: (ev: FsWatchEvent) => void): (() => void) =>
    subscribe('workspace:fs-event', cb),

  // ---- 构建 ----
  build: (root: string): Promise<BuildResult> => ipcRenderer.invoke('build:run', root),
  buildWatchStart: (root: string): Promise<void> => ipcRenderer.invoke('build:watch-start', root),
  buildWatchStop: (): Promise<void> => ipcRenderer.invoke('build:watch-stop'),
  onBuildLog: (cb: (line: BuildLogLine) => void): (() => void) => subscribe('build:log', cb),
  onBuildDone: (cb: (result: BuildResult) => void): (() => void) => subscribe('build:done', cb),

  // ---- IDE 设置(SettingsService,单一 JSON 落盘 + 全窗口广播) ----
  /** 全量读取设置 */
  settingsGetAll: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get-all'),
  /** dot-path 补丁写入(如 {'editor.minimap': false});返回最新全量设置 */
  settingsSetMany: (patch: Record<string, unknown>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set-many', patch),
  /** 全量重置为默认值 */
  settingsReset: (): Promise<AppSettings> => ipcRenderer.invoke('settings:reset'),
  /** 设置变更广播(全窗口;消费方订阅即时生效) */
  onSettingsChanged: (cb: (ev: SettingsChangedEvent) => void): (() => void) =>
    subscribe('settings:changed', cb),
  /** 打开(或聚焦)IDE 设置独立窗口 */
  settingsWindowOpen: (): Promise<void> => ipcRenderer.invoke('settings:window-open'),
  /** 设置窗口:确认后强制关闭(草稿由 renderer 自行丢弃) */
  settingsWindowClose: (): Promise<void> => ipcRenderer.invoke('settings:window-close'),
  /** 设置窗口 ✕ 拦截:main 请求 renderer 决定(有未应用修改时弹确认框) */
  onSettingsCloseRequest: (cb: () => void): (() => void) =>
    subscribe('settings:close-request', cb),

  // ---- 主题(appearance.theme = system 时经 main 侧 nativeTheme 解析) ----
  /** 查询系统主题(nativeTheme.shouldUseDarkColors) */
  themeGetSystem: (): Promise<EffectiveTheme> => ipcRenderer.invoke('theme:get-system'),
  /** 系统主题变化推送(nativeTheme updated,全窗口广播;仅「跟随系统」时影响有效主题) */
  onSystemThemeChanged: (cb: (mode: EffectiveTheme) => void): (() => void) =>
    subscribe('theme:system-changed', cb),
  /** renderer 已应用主题回报:main 打日志([theme] 前缀,冒烟断言)+ 同步窗口底色 */
  themeApplied: (text: string): void => ipcRenderer.send('theme:applied', text),

  // ---- 会话恢复(阶段 2:窗口状态 / 上次工作区 / 编辑器标签) ----
  /** 启动恢复信息(restore 开关位 + 上次工作区 + 编辑器会话;App 挂载时查询一次) */
  sessionStartup: (): Promise<SessionStartupInfo> => ipcRenderer.invoke('session:startup'),
  /** 指定工作区的编辑器会话(<root>/.ide/session.json,含旧 userData 会话迁移兜底;无则 null) */
  sessionForRoot: (root: string): Promise<WorkspaceSession | null> =>
    ipcRenderer.invoke('session:for-root', root),
  /** 会话状态去抖推送(fire-and-forget;main 内存即时 + 去抖落盘 + 退出双保险) */
  sessionUpdate: (payload: SessionUpdatePayload): void =>
    ipcRenderer.send('session:update', payload),
  /** 恢复摘要 → 主进程终端日志(前缀 [session-restore],dev 冒烟断言证据) */
  sessionReport: (text: string): void => ipcRenderer.send('session:report', text),
  /** 冒烟钩子:main 请求 renderer 打开指定工作区与文件(PIXELBOX_SMOKE_SESSION=1) */
  onSmokeSessionPrepare: (cb: (payload: { root: string; file: string }) => void): (() => void) =>
    subscribe('smoke:session-prepare', cb),

  // ---- 固件工具链(阶段 3:编译/打包/烧录) ----
  /** 检测 ESP-IDF 环境(路径 + 版本);可传设置窗口草稿路径做不落盘试探 */
  toolchainDetect: (overridePath?: string): Promise<ToolchainInfo> =>
    ipcRenderer.invoke('toolchain:detect', overridePath),
  /**
   * 启动固件任务(build/merge/flash/clean);完成经 onFirmwareDone 事件回报。
   * cwd = 固件工程目录(IDE v3:作用于当前工作区,须含 CMakeLists.txt);
   * 缺省保持旧行为(仓库 firmware/)
   */
  firmwareStart: (opts: {
    kind: FirmwareTaskKind
    target: string
    port?: string
    baud?: number
    cwd?: string
  }): Promise<void> => ipcRenderer.invoke('toolchain:start', opts),
  /** 取消当前固件任务(杀进程树) */
  firmwareCancel: (): Promise<void> => ipcRenderer.invoke('toolchain:cancel'),
  /** 查询当前固件任务运行状态(renderer 重载后恢复 UI) */
  firmwareStatus: (): Promise<FirmwareStatus> => ipcRenderer.invoke('toolchain:status'),
  /** 扫描串口设备(烧录对话框轮询) */
  serialPorts: (): Promise<SerialPortInfo[]> => ipcRenderer.invoke('toolchain:ports'),
  /** 固件任务输出流(批量行,「构建」tab 消费) */
  onFirmwareLog: (cb: (lines: BuildLogLine[]) => void): (() => void) =>
    subscribe('toolchain:log', cb),
  /** 固件任务结束事件 */
  onFirmwareDone: (cb: (result: FirmwareTaskResult) => void): (() => void) =>
    subscribe('toolchain:done', cb),

  // ---- clangd LSP(固件工程 C/C++ 补全/悬停/诊断) ----
  /** 惰性启动 clangd 会话(root 缺省 = main 侧当前工作区);返回状态供 renderer 提示 */
  clangdStart: (root?: string): Promise<ClangdStatus> =>
    ipcRenderer.invoke('clangd:start', root === undefined ? undefined : { root }),
  /** 停止会话(杀 clangd 进程) */
  clangdStop: (): Promise<void> => ipcRenderer.invoke('clangd:stop'),
  /** LSP 请求转发(白名单:completion/hover/signatureHelp/definition) */
  clangdRequest: (method: string, params: unknown): Promise<unknown> =>
    ipcRenderer.invoke('clangd:request', { method, params }),
  /** 文档同步通知(didOpen/didChange/didClose/didSave;fire-and-forget) */
  clangdNotify: (method: string, params: unknown): void =>
    ipcRenderer.send('clangd:notify', { method, params }),
  /** 定义跳转目标的只读读取(工作区外 IDF/工具链头文件;越界/不可读返回 null) */
  clangdReadSource: (path: string): Promise<string | null> =>
    ipcRenderer.invoke('clangd:read-source', path),
  /** 服务器通知(白名单内,当前仅 textDocument/publishDiagnostics) */
  onClangdEvent: (cb: (ev: ClangdServerNotification) => void): (() => void) =>
    subscribe('clangd:event', cb),
  /** 异步状态变化(崩溃重启成功 running / 到达上限 failed / stopped) */
  onClangdStatus: (cb: (status: ClangdStatus) => void): (() => void) =>
    subscribe('clangd:status', cb),

  // ---- 虚拟设备档案(设备管理器) ----
  /** 列出全部档案(内置档案恒在首位) */
  deviceProfilesList: (): Promise<DeviceProfile[]> => ipcRenderer.invoke('devices:list'),
  /** 新建/编辑档案(id 为空则新建);返回更新后的完整列表 */
  deviceProfilesSave: (p: DeviceProfile): Promise<DeviceProfile[]> =>
    ipcRenderer.invoke('devices:save', p),
  /** 删除档案(内置档案拒绝);返回更新后的完整列表 */
  deviceProfilesDelete: (id: string): Promise<DeviceProfile[]> =>
    ipcRenderer.invoke('devices:delete', id),

  // ---- 集成终端(PtyService,阶段 1/2) ----
  /** 新建终端会话(cwd 传工作区根;返回会话信息含后端类型) */
  terminalCreate: (opts?: TerminalCreateOptions): Promise<TerminalSessionInfo> =>
    ipcRenderer.invoke('terminal:create', opts),
  /** 键盘输入 → shell(send 通道,高频无往返) */
  terminalWrite: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
  /** 尺寸变化(fit 后回传 cols/rows) */
  terminalResize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  /** 关闭会话(杀 shell 进程;退出经 onTerminalExit 回流) */
  terminalClose: (id: string): Promise<void> => ipcRenderer.invoke('terminal:close', id),
  /** 重命名会话 */
  terminalRename: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke('terminal:rename', id, name),
  /** 存活会话列表(renderer 重载后恢复 tab) */
  terminalList: (): Promise<TerminalSessionInfo[]> => ipcRenderer.invoke('terminal:list'),
  /** 后端探测结果(pipe 模式 UI 提示体验受限) */
  terminalBackend: (): Promise<{ backend: TerminalBackend; error: string }> =>
    ipcRenderer.invoke('terminal:backend'),
  /** 终端输出流(16ms 批量聚合) */
  onTerminalData: (cb: (chunks: TerminalDataChunk[]) => void): (() => void) =>
    subscribe('terminal:data', cb),
  /** 会话退出事件 */
  onTerminalExit: (cb: (ev: TerminalExitEvent) => void): (() => void) =>
    subscribe('terminal:exit', cb),

  // ---- 工具窗独立窗口(视图模式 Window,阶段 2/2) ----
  /** 打开(或聚焦)独立工具窗;非白名单 id 返回 false */
  toolwindowOpen: (id: StandaloneToolId): Promise<boolean> =>
    ipcRenderer.invoke('toolwindow:open', id),
  /** 关闭独立工具窗(closed 广播回流后该工具窗回 Dock Pinned) */
  toolwindowClose: (id: StandaloneToolId): Promise<void> =>
    ipcRenderer.invoke('toolwindow:close', id),
  /** 当前打开的独立工具窗(renderer 重载后对账恢复 window 视图模式) */
  toolwindowList: (): Promise<StandaloneToolId[]> => ipcRenderer.invoke('toolwindow:list'),
  /** 独立工具窗关闭事件 */
  onToolWindowClosed: (cb: (ev: ToolWindowClosedEvent) => void): (() => void) =>
    subscribe('toolwindow:closed', cb),

  // ---- 硬件设计(STL/Gerber 导出) ----
  /** 导出文件到 <root>/export/<kind>/(base64 内容;完成后文件管理器定位目录) */
  hardwareExport: (opts: {
    root: string
    kind: 'print' | 'gerber'
    files: HardwareExportFile[]
  }): Promise<HardwareExportResult> => ipcRenderer.invoke('hardware:export', opts),

  // ---- 3D 打印机(OctoPrint / Moonraker,配置见设置 printer 段) ----
  /** 连接测试,返回版本/状态描述(失败 throw printer:<code>) */
  printerTest: (): Promise<string> => ipcRenderer.invoke('printer:test'),
  /** 选择 G-code 文件(.gcode/.gco/.g;取消返回 null) */
  printerPickGcode: (): Promise<string | null> => ipcRenderer.invoke('printer:pick-gcode'),
  /** 上传 G-code(startPrint 请求立即开打;printStarted 以服务器回执为准) */
  printerUpload: (opts: { path: string; startPrint: boolean }): Promise<PrinterUploadResult> =>
    ipcRenderer.invoke('printer:upload', opts),
  /** 任务状态轮询(completion 统一 0..1) */
  printerJob: (): Promise<PrinterJobStatus> => ipcRenderer.invoke('printer:job'),

  // ---- 真机(devd) ----
  devdDiscover: (timeoutMs?: number): Promise<DevdDevice[]> =>
    ipcRenderer.invoke('devd:discover', timeoutMs),
  devdPush: (opts: { root: string; host: string; port: number }): Promise<void> =>
    ipcRenderer.invoke('devd:push', opts),
  onDevdDevices: (cb: (devices: DevdDevice[]) => void): (() => void) =>
    subscribe('devd:devices', cb),
  onPushProgress: (cb: (p: PushProgress) => void): (() => void) =>
    subscribe('devd:push-progress', cb),
  /** 订阅真机日志(main 建立常驻连接并断线重连;日志经 onDevdLog 批量到达) */
  devdLogsSubscribe: (opts: { key: string; host: string; port: number }): Promise<void> =>
    ipcRenderer.invoke('devd:logs-subscribe', opts),
  devdLogsUnsubscribe: (key: string): Promise<void> =>
    ipcRenderer.invoke('devd:logs-unsubscribe', { key }),
  onDevdLog: (cb: (events: DevdLogEvent[]) => void): (() => void) => subscribe('devd:log', cb),
  /** 全量回放前的清屏信号(老固件重连 / 设备重启),渲染端应清掉该设备旧行 */
  onDevdLogReset: (cb: (p: { key: string }) => void): (() => void) =>
    subscribe('devd:log-reset', cb),

  // ---- 设备模拟特权通道(device-sim,见 src/preload/simApi.ts) ----
  sim: simApi
}

export type SimulatorApi = typeof api

contextBridge.exposeInMainWorld('api', api)
