/**
 * 沙箱侧 RPC / 事件链路(与宿主 engine.ts 对话)
 * 协议信封见 ../../protocol.ts
 */
import { isSimMessage, type RpcReplyMsg, type SimMessage } from '../../protocol'
import { NamedEmitter } from './events'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class HostLink {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private events = new NamedEmitter()

  constructor() {
    window.addEventListener('message', (ev: MessageEvent) => {
      const msg: unknown = ev.data
      if (!isSimMessage(msg)) return
      this.dispatch(msg)
    })
  }

  private dispatch(msg: SimMessage): void {
    if (msg.kind === 'rpc-reply') {
      const reply = msg as RpcReplyMsg
      const p = this.pending.get(reply.id)
      if (!p) return
      this.pending.delete(reply.id)
      if (reply.ok) p.resolve(reply.data)
      else p.reject(new Error(String(reply.data)))
    } else if (msg.kind === 'event') {
      this.events.emit(msg.name, msg.data)
    }
  }

  /** 调用宿主 RPC(特权操作) */
  call<T = unknown>(method: string, params: unknown, transfer?: Transferable[]): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      window.parent.postMessage(
        { __px: true, kind: 'rpc-call', id, method, params },
        '*',
        transfer ?? []
      )
    })
  }

  /** 单向事件上报宿主 */
  emit(name: string, data?: unknown, transfer?: Transferable[]): void {
    window.parent.postMessage({ __px: true, kind: 'event', name, data }, '*', transfer ?? [])
  }

  /** 订阅宿主事件 */
  on<T = unknown>(name: string, cb: (data: T) => void): () => void {
    return this.events.on(name, cb as (data: unknown) => void)
  }
}
