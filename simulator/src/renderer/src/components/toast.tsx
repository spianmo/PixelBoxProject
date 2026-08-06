/**
 * 轻量 toast:模块级事件总线,任意位置 showToast(),App 挂一个 <ToastHost/>
 * 每条 toast 同时记入通知历史(标题栏 🔔 通知面板消费)
 */
import { useEffect, useState } from 'react'
import { createStore, type Store } from '../device-sim/store'

export type ToastKind = 'info' | 'warn' | 'error'

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

type Listener = (items: ToastItem[]) => void

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l(items)
}

// ---------------------------------------------------------------
// 通知历史(标题栏铃铛)
// ---------------------------------------------------------------

export interface NotificationItem {
  id: number
  kind: ToastKind
  text: string
  ts: number
}

export interface NotificationState {
  items: NotificationItem[]
  /** 未读数(打开通知面板时清零) */
  unread: number
}

const NOTIFY_MAX = 50

export const notificationStore: Store<NotificationState> = createStore<NotificationState>({
  items: [],
  unread: 0
})

export function markNotificationsRead(): void {
  if (notificationStore.get().unread > 0) notificationStore.set({ unread: 0 })
}

export function clearNotifications(): void {
  notificationStore.replace({ items: [], unread: 0 })
}

/** 弹出一条 toast,默认 3.2s 自动消失;同时记入通知历史 */
export function showToast(text: string, kind: ToastKind = 'info', durationMs = 3200): void {
  const id = nextId++
  items = [...items, { id, kind, text }]
  emit()
  window.setTimeout(() => {
    items = items.filter((it) => it.id !== id)
    emit()
  }, durationMs)

  const ns = notificationStore.get()
  notificationStore.set({
    items: [{ id, kind, text, ts: Date.now() }, ...ns.items].slice(0, NOTIFY_MAX),
    unread: ns.unread + 1
  })
}

const KIND_STYLE: Record<ToastKind, string> = {
  info: 'border-accent/60 text-gray-100',
  warn: 'border-yellow-500/70 text-yellow-200',
  error: 'border-red-500/70 text-red-200'
}

export function ToastHost(): React.JSX.Element {
  const [list, setList] = useState<ToastItem[]>(items)
  useEffect(() => {
    const l: Listener = (v) => setList(v)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return (
    <div className="pointer-events-none fixed right-4 top-12 z-[1000] flex flex-col gap-2">
      {list.map((it) => (
        <div
          key={it.id}
          className={`pointer-events-auto max-w-md rounded border bg-ink-800/95 px-3 py-2 text-sm shadow-lg backdrop-blur ${KIND_STYLE[it.kind]}`}
        >
          {it.text}
        </div>
      ))}
    </div>
  )
}
