/**
 * 宿主网络中转:沙箱 tcp/udp/mdns/hostname/fetch RPC → window.api.sim(main 进程桥)
 * 记录本次应用创建的全部资源 id,应用停止时统一关闭,防止泄漏。
 */
import type { NetEventPayload } from '../protocol'

type NetEventEmit = (ev: NetEventPayload, transfer?: Transferable[]) => void

export class NetRelay {
  private tcpIds = new Set<number>()
  private serverIds = new Set<number>()
  private udpIds = new Set<number>()
  private mdnsAdIds = new Set<number>()
  private unsubNetEvents: (() => void) | null = null

  /** 开始监听 main 的网络事件并转发进沙箱 */
  attach(emit: NetEventEmit): void {
    this.unsubNetEvents = window.api.sim.onNetEvent((ev) => {
      switch (ev.type) {
        case 'tcp-data':
          if (this.tcpIds.has(ev.id)) emit(ev, [ev.data])
          break
        case 'tcp-close':
          if (this.tcpIds.has(ev.id)) {
            this.tcpIds.delete(ev.id)
            emit(ev)
          }
          break
        case 'tcp-error':
          if (this.tcpIds.has(ev.id) || this.udpIds.has(ev.id)) emit(ev)
          break
        case 'tcp-conn':
          if (this.serverIds.has(ev.serverId)) {
            this.tcpIds.add(ev.sockId) // 入站连接也纳入管理
            emit(ev)
          }
          break
        case 'udp-msg':
          if (this.udpIds.has(ev.id)) emit(ev, [ev.data])
          break
      }
    })
  }

  async tcpConnect(opts: {
    host: string
    port: number
    tls?: boolean
    timeoutMs?: number
  }): Promise<{ id: number; remoteHost: string; remotePort: number }> {
    const r = await window.api.sim.tcpConnect(opts)
    this.tcpIds.add(r.id)
    return r
  }

  async tcpSend(id: number, data: ArrayBuffer): Promise<void> {
    await window.api.sim.tcpSend(id, data)
  }

  async tcpClose(id: number): Promise<void> {
    this.tcpIds.delete(id)
    await window.api.sim.tcpClose(id)
  }

  async tcpListen(port: number): Promise<{ id: number; port: number }> {
    const r = await window.api.sim.tcpListen(port)
    this.serverIds.add(r.id)
    return r
  }

  async tcpServerClose(id: number): Promise<void> {
    this.serverIds.delete(id)
    await window.api.sim.tcpServerClose(id)
  }

  async udpCreate(bindPort?: number): Promise<{ id: number }> {
    const r = await window.api.sim.udpCreate(bindPort)
    this.udpIds.add(r.id)
    return r
  }

  async udpSend(id: number, data: ArrayBuffer, host: string, port: number): Promise<void> {
    await window.api.sim.udpSend(id, data, host, port)
  }

  async udpClose(id: number): Promise<void> {
    this.udpIds.delete(id)
    await window.api.sim.udpClose(id)
  }

  async mdnsDiscover(
    service: string,
    timeoutMs: number
  ): Promise<Array<{ name: string; host: string; ip: string; port: number; txt: Record<string, string> }>> {
    return window.api.sim.mdnsDiscover(service, timeoutMs)
  }

  async mdnsAdvertise(opts: {
    name: string
    service: string
    port: number
    txt?: Record<string, string>
  }): Promise<{ id: number }> {
    const r = await window.api.sim.mdnsAdvertise(opts)
    this.mdnsAdIds.add(r.id)
    return r
  }

  async mdnsStop(id: number): Promise<void> {
    this.mdnsAdIds.delete(id)
    await window.api.sim.mdnsStop(id)
  }

  /** 应用停止:关闭全部残留资源 */
  dispose(): void {
    this.unsubNetEvents?.()
    this.unsubNetEvents = null
    for (const id of this.tcpIds) void window.api.sim.tcpClose(id).catch(() => undefined)
    for (const id of this.serverIds) void window.api.sim.tcpServerClose(id).catch(() => undefined)
    for (const id of this.udpIds) void window.api.sim.udpClose(id).catch(() => undefined)
    for (const id of this.mdnsAdIds) void window.api.sim.mdnsStop(id).catch(() => undefined)
    this.tcpIds.clear()
    this.serverIds.clear()
    this.udpIds.clear()
    this.mdnsAdIds.clear()
  }
}
