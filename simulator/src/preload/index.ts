/**
 * preload:通过 contextBridge 暴露类型安全的 window.api
 * 所有事件订阅返回取消函数,与 d.ts 契约的 Unsubscribe 风格一致
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BuildLogLine,
  BuildResult,
  DevdDevice,
  FsEntry,
  FsWatchEvent,
  PushProgress
} from '../shared/ipc-types'
import { simApi } from './simApi'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  platform: process.platform,

  // ---- 工作区 / 文件系统 ----
  openWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-workspace'),
  readDir: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke('fs:read-dir', dir),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke('fs:read-file', p),
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
