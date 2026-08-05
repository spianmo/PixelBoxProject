/**
 * 轻量 toast:模块级事件总线,任意位置 showToast(),App 挂一个 <ToastHost/>
 */
import { useEffect, useState } from 'react'

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

/** 弹出一条 toast,默认 3.2s 自动消失 */
export function showToast(text: string, kind: ToastKind = 'info', durationMs = 3200): void {
  const id = nextId++
  items = [...items, { id, kind, text }]
  emit()
  window.setTimeout(() => {
    items = items.filter((it) => it.id !== id)
    emit()
  }, durationMs)
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
