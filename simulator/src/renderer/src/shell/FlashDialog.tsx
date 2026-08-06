/**
 * 烧录对话框(阶段 3)—— 串口扫描 + 端口选择 + 波特率
 *
 * - 打开期间每 2s 轮询 main 进程 toolchain:ports(usbmodem/wchusbserial/SLAB 等)
 * - 无设备时给出下载模式指引(按住 BOOT 插线),并保持扫描
 * - 「开始烧录」在固件任务进行中禁用(防重入);实际烧录由 App 经 IPC 启动,
 *   输出流到底部「构建」tab
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCircleAlert, LuRefreshCw, LuUsb } from 'react-icons/lu'
import type { SerialPortInfo } from '../../../shared/ipc-types'
import { chipLabel } from './store'

/** 常用烧录波特率档位 */
export const BAUD_OPTIONS = [115200, 230400, 460800, 921600] as const

const SELECT_CLASS =
  'w-full rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[13px] text-jb-text outline-none focus:border-accent'

/** 表单行(与设备向导同密度) */
function FormRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="w-20 shrink-0 pt-1.5 text-right text-xs text-jb-muted">{props.label}</div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

interface Props {
  /** 目标芯片(标题展示) */
  target: string
  /** 固件任务进行中(禁用开始按钮防重入) */
  busy: boolean
  /** 默认波特率(设置页持久化值) */
  defaultBaud: number
  onFlash: (port: string, baud: number) => void
  onClose: () => void
}

export function FlashDialog(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null) // null = 首扫未完成
  const [selected, setSelected] = useState<string>('')
  const [baud, setBaud] = useState(props.defaultBaud)

  // 打开期间轮询串口(2s);设备拔插即时反映
  useEffect(() => {
    let alive = true
    const scan = async (): Promise<void> => {
      try {
        const list = await window.api.serialPorts()
        if (!alive) return
        setPorts(list)
        // 自动选中:原选择失效(拔出)或尚未选择时取第一个
        setSelected((cur) => (list.some((p) => p.path === cur) ? cur : (list[0]?.path ?? '')))
      } catch {
        if (alive) setPorts([])
      }
    }
    void scan()
    const timer = window.setInterval(() => void scan(), 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const scanned = ports !== null
  const empty = scanned && ports.length === 0

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose()
      }}
    >
      <div className="w-[460px] rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        {/* 标题 */}
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5 text-sm font-medium text-jb-text">
          <LuUsb className="text-jb-muted" />
          {t('fw.flashDialog.title', { chip: chipLabel(props.target) })}
        </div>

        <div className="space-y-3 px-4 py-4">
          {/* 端口列表 */}
          <FormRow label={t('fw.flashDialog.port')}>
            <div className="max-h-40 overflow-auto rounded border border-ink-600 bg-ink-900">
              {!scanned ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-jb-muted">
                  <LuRefreshCw className="animate-spin" />
                  {t('fw.flashDialog.scanning')}
                </div>
              ) : empty ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-jb-muted">
                  <LuRefreshCw className="animate-spin" />
                  {t('fw.flashDialog.noPorts')}
                </div>
              ) : (
                ports.map((p) => (
                  <button
                    key={p.path}
                    onClick={() => setSelected(p.path)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
                      selected === p.path ? 'bg-jb-selection text-jb-text' : 'text-jb-muted hover:bg-ink-800'
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full border ${
                        selected === p.path ? 'border-accent bg-accent' : 'border-ink-500'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono">{p.path}</span>
                  </button>
                ))
              )}
            </div>
            {/* 无设备:下载模式指引(持续扫描中) */}
            {empty && (
              <div className="mt-1.5 flex items-start gap-1.5 rounded border border-yellow-600/40 bg-yellow-500/10 px-2 py-1.5 text-[11px] leading-4 text-yellow-300/90">
                <LuCircleAlert className="mt-0.5 shrink-0" />
                <span>{t('fw.flashDialog.bootHint')}</span>
              </div>
            )}
          </FormRow>

          {/* 波特率 */}
          <FormRow label={t('fw.flashDialog.baud')}>
            <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} className={SELECT_CLASS}>
              {BAUD_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </FormRow>
        </div>

        {/* 按钮行 */}
        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-2.5">
          <button
            onClick={props.onClose}
            className="rounded border border-ink-500 px-3 py-1 text-[13px] text-gray-300 hover:bg-ink-700"
          >
            {t('common.cancel')}
          </button>
          <button
            // 防重入:任务进行中 / 无端口 时禁用
            disabled={props.busy || selected.length === 0}
            onClick={() => props.onFlash(selected, baud)}
            className="rounded bg-accent-dim px-3 py-1 text-[13px] text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('fw.flashDialog.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
