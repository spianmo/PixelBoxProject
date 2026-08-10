/**
 * 全局通知 toast(JetBrains 气泡风,窗口右下角、状态栏上方,向上堆叠)
 *
 * - 任意位置 showToast(),App 挂一个 <ToastHost/>
 * - 排版:标题 12px/500 主色,正文 11px 次级色;图标 14px 按级别着色
 *   (info 蓝 / success 绿 / warn 黄 / error 红)
 * - 自动消失 4s(错误 8s),悬停暂停计时,✕ 手动关,点击展开长文本
 * - 每条 toast 同时记入通知历史(标题栏 🔔 通知面板消费;history:false 的除外)
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleCheck, LuCircleX, LuInfo, LuTriangleAlert, LuX } from 'react-icons/lu'
import { createStore, type Store } from '../device-sim/store'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface ToastOptions {
  /** 自定义标题(缺省用级别名:信息/成功/警告/错误) */
  title?: string
  /** 覆盖自动消失时长(缺省按级别:错误 8s,其余 4s) */
  durationMs?: number
  /** 是否记入通知历史(缺省 true);「复制路径」这类高频轻操作传 false,避免刷掉历史里的真事件 */
  history?: boolean
}

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  title?: string
  durationMs: number
}

type Listener = (items: ToastItem[]) => void

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l(items)
}

function dismissToast(id: number): void {
  items = items.filter((it) => it.id !== id)
  emit()
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

/** 级别默认时长:错误 8s,其余 4s */
const KIND_DURATION: Record<ToastKind, number> = {
  info: 4000,
  success: 4000,
  warn: 4000,
  error: 8000
}

/** 弹出一条 toast(自动消失按级别,见 KIND_DURATION);同时记入通知历史 */
export function showToast(text: string, kind: ToastKind = 'info', opts?: ToastOptions): void {
  const id = nextId++
  items = [...items, { id, kind, text, title: opts?.title, durationMs: opts?.durationMs ?? KIND_DURATION[kind] }]
  emit()

  if (opts?.history === false) return
  const ns = notificationStore.get()
  notificationStore.set({
    items: [{ id, kind, text, ts: Date.now() }, ...ns.items].slice(0, NOTIFY_MAX),
    unread: ns.unread + 1
  })
}

// ---------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------

/** 级别图标(14px)与着色 */
const KIND_ICON: Record<ToastKind, { node: React.JSX.Element; cls: string }> = {
  info: { node: <LuInfo />, cls: 'text-accent' },
  success: { node: <LuCircleCheck />, cls: 'text-green-400' },
  warn: { node: <LuTriangleAlert />, cls: 'text-yellow-400' },
  error: { node: <LuCircleX />, cls: 'text-red-400' }
}

function ToastCard({ item }: { item: ToastItem }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  // 剩余存活时长(悬停暂停:离开时从剩余处继续计时)
  const remainRef = useRef(item.durationMs)

  useEffect(() => {
    if (hovered) return
    const startedAt = Date.now()
    const timer = window.setTimeout(() => dismissToast(item.id), remainRef.current)
    return () => {
      window.clearTimeout(timer)
      // 悬停打断:记录剩余时长,离开后至少再停留 800ms 便于看清
      remainRef.current = Math.max(800, remainRef.current - (Date.now() - startedAt))
    }
  }, [hovered, item.id])

  const icon = KIND_ICON[item.kind]
  return (
    <div
      className="pointer-events-auto w-[312px] cursor-default rounded-md border border-ink-700 bg-ink-850 px-3 py-2 shadow-2xl"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-px shrink-0 text-[14px] ${icon.cls}`}>{icon.node}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium leading-4 text-jb-text">
            {item.title ?? t(`notifications.kind.${item.kind}`)}
          </div>
          {/* 正文默认最多 2 行,点击卡片展开长文本 */}
          <div
            className={`selectable mt-0.5 text-[11px] leading-4 text-jb-muted ${
              expanded ? 'break-all' : 'line-clamp-2 break-all'
            }`}
          >
            {item.text}
          </div>
        </div>
        <button
          title={t('notifications.close')}
          className="-mr-1 -mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-jb-muted hover:bg-ink-800 hover:text-jb-text"
          onClick={(e) => {
            e.stopPropagation()
            dismissToast(item.id)
          }}
        >
          <LuX className="text-[12px]" />
        </button>
      </div>
    </div>
  )
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
    // 右下角:状态栏(26px)上方 8px、右缘 12px;新通知出现在底部,旧的向上堆叠
    <div className="pointer-events-none fixed bottom-[34px] right-3 z-[1000] flex flex-col items-end gap-2">
      {list.map((it) => (
        <ToastCard key={it.id} item={it} />
      ))}
    </div>
  )
}
