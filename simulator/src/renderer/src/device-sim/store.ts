/**
 * 轻量可订阅状态存储(引擎 ⇄ React 外设面板共享状态)
 * React 侧配合 useSyncExternalStore 使用
 */

export interface Store<T> {
  get(): T
  set(patch: Partial<T>): void
  replace(next: T): void
  subscribe(cb: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  const notify = (): void => {
    for (const cb of Array.from(subs)) cb()
  }
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch }
      notify()
    },
    replace: (next) => {
      state = next
      notify()
    },
    subscribe: (cb) => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    }
  }
}
