/**
 * 迷你事件发射器(沙箱运行时内部使用)
 * 订阅返回取消函数,与 d.ts 的 Unsubscribe 风格一致
 */

export type Listener<T> = (data: T) => void

export class Emitter<T = void> {
  private listeners = new Set<Listener<T>>()

  on(cb: Listener<T>): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  emit(data: T): void {
    // 拷贝一份,允许回调中退订
    for (const cb of Array.from(this.listeners)) {
      try {
        cb(data)
      } catch (err) {
        // 回调异常不打断其他订阅者;交给全局错误上报
        setTimeout(() => {
          throw err
        }, 0)
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }

  clear(): void {
    this.listeners.clear()
  }
}

/** 多事件名的发射器(voice.on / wifi.on 等按事件名订阅的场景) */
export class NamedEmitter {
  private map = new Map<string, Emitter<unknown>>()

  on(name: string, cb: (data: unknown) => void): () => void {
    let em = this.map.get(name)
    if (!em) {
      em = new Emitter<unknown>()
      this.map.set(name, em)
    }
    return em.on(cb)
  }

  emit(name: string, data?: unknown): void {
    this.map.get(name)?.emit(data)
  }
}
