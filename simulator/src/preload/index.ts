/**
 * preload:通过 contextBridge 暴露类型安全的 window.api
 * 所有事件订阅返回取消函数,与 d.ts 契约的 Unsubscribe 风格一致
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
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
  ToolchainInfo,
  ToolchainSettings
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

  // ---- 固件工具链(阶段 3:编译/打包/烧录) ----
  /** 检测 ESP-IDF 环境(路径 + 版本) */
  toolchainDetect: (): Promise<ToolchainInfo> => ipcRenderer.invoke('toolchain:detect'),
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
  /** 工具链设置读写(IDF 路径覆盖 / 默认目标 / 波特率) */
  toolchainSettingsGet: (): Promise<ToolchainSettings> =>
    ipcRenderer.invoke('toolchain:settings-get'),
  toolchainSettingsSet: (s: ToolchainSettings): Promise<void> =>
    ipcRenderer.invoke('toolchain:settings-set', s),
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
