/**
 * device-sim 特权通道的 preload 封装(挂到 window.api.sim)
 * 与 src/main/simbridge.ts 一一对应;事件订阅返回取消函数
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

/** sim:fetch 请求 / 响应 */
export interface SimFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: ArrayBuffer
  bodyText?: string
  timeoutMs: number
}
export interface SimFetchResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  url: string
  body: ArrayBuffer
}

export interface SimFileEntry {
  path: string
  data: ArrayBuffer
}

export interface SimStorageSnapshot {
  kvJson: string
  files: SimFileEntry[]
}

export type SimNetEvent =
  | { type: 'tcp-data'; id: number; data: ArrayBuffer }
  | { type: 'tcp-close'; id: number }
  | { type: 'tcp-error'; id: number; message: string }
  | { type: 'tcp-conn'; serverId: number; sockId: number; remoteHost: string; remotePort: number }
  | { type: 'udp-msg'; id: number; data: ArrayBuffer; host: string; port: number }

export interface SimMdnsService {
  name: string
  host: string
  ip: string
  port: number
  txt: Record<string, string>
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const simApi = {
  // ---- fetch 代理 ----
  fetch: (req: SimFetchRequest): Promise<SimFetchResponse> => ipcRenderer.invoke('sim:fetch', req),

  // ---- /app 预载(工作区 dist/ 二进制)----
  readTree: (dir: string): Promise<SimFileEntry[]> => ipcRenderer.invoke('sim:read-tree', dir),

  // ---- storage(userData/pixelbox-sim/<ws>)----
  storageLoad: (ws: string): Promise<SimStorageSnapshot> =>
    ipcRenderer.invoke('sim:storage-load', ws),
  storageWrite: (ws: string, path: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('sim:storage-write', ws, path, data),
  storageRemove: (ws: string, path: string): Promise<void> =>
    ipcRenderer.invoke('sim:storage-remove', ws, path),
  storageMkdir: (ws: string, path: string): Promise<void> =>
    ipcRenderer.invoke('sim:storage-mkdir', ws, path),
  storageSaveKv: (ws: string, kvJson: string): Promise<void> =>
    ipcRenderer.invoke('sim:storage-save-kv', ws, kvJson),

  // ---- tcp ----
  tcpConnect: (opts: {
    host: string
    port: number
    tls?: boolean
    timeoutMs?: number
  }): Promise<{ id: number; remoteHost: string; remotePort: number }> =>
    ipcRenderer.invoke('sim:tcp-connect', opts),
  tcpSend: (id: number, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('sim:tcp-send', id, data),
  tcpClose: (id: number): Promise<void> => ipcRenderer.invoke('sim:tcp-close', id),
  tcpListen: (port: number): Promise<{ id: number; port: number }> =>
    ipcRenderer.invoke('sim:tcp-listen', port),
  tcpServerClose: (id: number): Promise<void> => ipcRenderer.invoke('sim:tcp-server-close', id),

  // ---- udp ----
  udpCreate: (bindPort?: number): Promise<{ id: number }> =>
    ipcRenderer.invoke('sim:udp-create', bindPort),
  udpSend: (id: number, data: ArrayBuffer, host: string, port: number): Promise<void> =>
    ipcRenderer.invoke('sim:udp-send', id, data, host, port),
  udpClose: (id: number): Promise<void> => ipcRenderer.invoke('sim:udp-close', id),

  // ---- mdns ----
  mdnsDiscover: (service: string, timeoutMs?: number): Promise<SimMdnsService[]> =>
    ipcRenderer.invoke('sim:mdns-discover', service, timeoutMs),
  mdnsAdvertise: (opts: {
    name: string
    service: string
    port: number
    txt?: Record<string, string>
  }): Promise<{ id: number }> => ipcRenderer.invoke('sim:mdns-advertise', opts),
  mdnsStop: (id: number): Promise<void> => ipcRenderer.invoke('sim:mdns-stop', id),

  // ---- misc ----
  hostname: (): Promise<string> => ipcRenderer.invoke('sim:hostname'),

  // ---- 事件 ----
  onNetEvent: (cb: (ev: SimNetEvent) => void): (() => void) => subscribe('sim:net-event', cb)
}

export type SimBridgeApi = typeof simApi
