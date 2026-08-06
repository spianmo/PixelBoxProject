/**
 * preload:通过 contextBridge 暴露类型安全的 window.api
 * 所有事件订阅返回取消函数,与 d.ts 契约的 Unsubscribe 风格一致
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  BuildLogLine,
  BuildResult,
  DevdDevice,
  DeviceProfile,
  FirmwareStatus,
  FirmwareTaskKind,
  FirmwareTaskResult,
  FsEntry,
  FsWatchEvent,
  ProjectCreateOptions,
  ProjectCreateResult,
  PushProgress,
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
  ToolchainInfo
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
  /** 读取工作区 git 分支(非 git 仓库返回 null) */
  gitBranch: (root: string): Promise<string | null> => ipcRenderer.invoke('shell:git-branch', root),
  /** 截图 PNG 字节落盘到 ~/Downloads,返回完整路径 */
  saveScreenshot: (png: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('shell:save-screenshot', png),
  /** 外部链接交给系统浏览器(仅 http(s)/mailto;Markdown 预览用) */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),

  // ---- 新建项目向导 ----
  /** 默认项目位置(~/PixelBoxProjects) */
  projectDefaultLocation: (): Promise<string> => ipcRenderer.invoke('project:default-location'),
  /** 系统目录选择对话框(「浏览…」),取消返回 null */
  chooseDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:choose-directory', defaultPath),
  /** 校验并生成项目骨架,返回根目录与 src/main.ts 路径 */
  projectCreate: (opts: ProjectCreateOptions): Promise<ProjectCreateResult> =>
    ipcRenderer.invoke('project:create', opts),

  // ---- 工作区 / 文件系统 ----
  openWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-workspace'),
  /** 按路径直接打开工作区(最近列表);目录不存在返回 null */
  openWorkspacePath: (root: string): Promise<string | null> =>
    ipcRenderer.invoke('workspace:open-path', root),
  /** 最近打开过的工作区(仍存在的目录) */
  recentWorkspaces: (): Promise<string[]> => ipcRenderer.invoke('workspace:recents'),
  /** 工作区文件全量列举(相对路径,Cmd+P 快速打开) */
  listWorkspaceFiles: (): Promise<string[]> => ipcRenderer.invoke('workspace:list-files'),
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

  // ---- 会话恢复(阶段 2:窗口状态 / 上次工作区 / 编辑器标签) ----
  /** 启动恢复信息(restore 开关位 + 上次工作区 + 编辑器会话;App 挂载时查询一次) */
  sessionStartup: (): Promise<SessionStartupInfo> => ipcRenderer.invoke('session:startup'),
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
  /** 启动固件任务(build/merge/flash/clean);完成经 onFirmwareDone 事件回报 */
  firmwareStart: (opts: {
    kind: FirmwareTaskKind
    target: string
    port?: string
    baud?: number
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

  // ---- 真机(devd) ----
  devdDiscover: (timeoutMs?: number): Promise<DevdDevice[]> =>
    ipcRenderer.invoke('devd:discover', timeoutMs),
  devdPush: (opts: { root: string; host: string; port: number }): Promise<void> =>
    ipcRenderer.invoke('devd:push', opts),
  onDevdDevices: (cb: (devices: DevdDevice[]) => void): (() => void) =>
    subscribe('devd:devices', cb),
  onPushProgress: (cb: (p: PushProgress) => void): (() => void) =>
    subscribe('devd:push-progress', cb),

  // ---- 设备模拟特权通道(device-sim,见 src/preload/simApi.ts) ----
  sim: simApi
}

export type SimulatorApi = typeof api

contextBridge.exposeInMainWorld('api', api)
