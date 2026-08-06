/**
 * 3D 打印流程(硬件设计面板「打印」tab 内联内容,非模态)
 *
 * 步骤:1) 打印机设置概览 + 测试连接(printer:test)
 *       2) 导出 STL(复用面板导出通道)+ 切片软件提示(打印机只吃 G-code)
 *       3) 选择 .gcode(printer:pick-gcode)→ 上传(printer:upload,可选立即开打)
 *       4) 任务进度:printer:job 2.5s 轮询(串行调度,tab 卸载即停),进度条 + 剩余时间
 * 打印机错误码(printer:unreachable|badKey|conflict|unsupportedFile|notConfigured)→ i18n
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { LuFileUp, LuLoaderCircle, LuPlugZap, LuUpload } from 'react-icons/lu'
import type { PrinterJobStatus } from '../../../shared/ipc-types'
import { showToast } from '../components/toast'
import type { HardwarePartId } from './types'

/** STL 导出部件('all' = 底盒+顶盖+板卡一次导出) */
export type StlPart = HardwarePartId | 'all'

const POLL_INTERVAL_MS = 2500

/** 打印机设置镜像(settings.printer 段) */
interface PrinterCfg {
  type: string
  baseUrl: string
}

const BTN_CLASS =
  'flex h-7 items-center gap-1.5 rounded border border-ink-600 px-2 text-[12px] text-jb-muted hover:bg-ink-800 hover:text-jb-text disabled:cursor-not-allowed disabled:text-ink-500 disabled:hover:bg-transparent'

/** printer:<code> → i18n 文案(未知码回落原始信息) */
function printerErrText(t: TFunction, err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0]
  const m = /printer:([A-Za-z]+)/.exec(msg)
  return m ? t(`hw.printer.errors.${m[1]}`, { defaultValue: msg }) : msg
}

/** 秒 → mm:ss */
function fmtTimeLeft(sec: number | undefined): string | null {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return null
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/** 步骤块:序号圆点 + 标题 + 内容 */
function Step(props: { n: number; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-700 text-[11px] font-medium text-jb-text">
        {props.n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-[13px] font-medium text-jb-text">{props.title}</div>
        {props.children}
      </div>
    </div>
  )
}

export function PrintDialog(props: { onExportStl: (part: StlPart) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [cfg, setCfg] = useState<PrinterCfg | null>(null)
  const [testing, setTesting] = useState(false)
  const [gcodePath, setGcodePath] = useState<string | null>(null)
  const [startPrint, setStartPrint] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [job, setJob] = useState<PrinterJobStatus | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)

  // 打印机设置概览(挂载读取 + 变更广播即时刷新)
  useEffect(() => {
    let cancelled = false
    const apply = (settings: { printer?: { type?: string; baseUrl?: string } }): void => {
      if (cancelled) return
      setCfg({ type: settings.printer?.type ?? 'octoprint', baseUrl: settings.printer?.baseUrl ?? '' })
    }
    window.api
      .settingsGetAll()
      .then(apply)
      .catch(() => {})
    const off = window.api.onSettingsChanged((ev) => apply(ev.settings))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  // 任务进度轮询:串行 setTimeout 链(上一次请求返回后才排下一次),卸载即停
  const baseUrl = cfg?.baseUrl ?? ''
  useEffect(() => {
    if (!baseUrl) {
      setJob(null)
      setJobError(null)
      return
    }
    let cancelled = false
    let timer = 0
    const tick = async (): Promise<void> => {
      try {
        const status = await window.api.printerJob()
        if (cancelled) return
        setJob(status)
        setJobError(null)
      } catch (err) {
        if (cancelled) return
        setJob(null)
        setJobError(printerErrText(t, err))
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick()
        }, POLL_INTERVAL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [baseUrl, t])

  const onTest = async (): Promise<void> => {
    setTesting(true)
    try {
      const info = await window.api.printerTest()
      showToast(t('hw.print.testOk', { info }), 'success')
    } catch (err) {
      showToast(printerErrText(t, err), 'error')
    } finally {
      setTesting(false)
    }
  }

  const onPickGcode = async (): Promise<void> => {
    const path = await window.api.printerPickGcode().catch(() => null)
    if (path) setGcodePath(path)
  }

  const onUpload = async (): Promise<void> => {
    if (!gcodePath) return
    setUploading(true)
    try {
      const res = await window.api.printerUpload({ path: gcodePath, startPrint })
      showToast(
        t(res.printStarted ? 'hw.print.printStarted' : 'hw.print.uploaded', { name: res.remoteName }),
        'success'
      )
    } catch (err) {
      showToast(printerErrText(t, err), 'error')
    } finally {
      setUploading(false)
    }
  }

  const configured = Boolean(cfg?.baseUrl)
  const timeLeft = fmtTimeLeft(job?.printTimeLeftSec)
  const percent = Math.round(clamp01(job?.completion ?? 0) * 100)

  return (
    <div className="max-w-[560px] space-y-5">
      {/* 1. 打印机设置 */}
      <Step n={1} title={t('hw.print.step1')}>
        {configured && cfg ? (
          <div className="text-xs text-jb-muted">
            {cfg.type === 'moonraker' ? 'Moonraker' : 'OctoPrint'}
            {' · '}
            <span className="selectable text-jb-text">{cfg.baseUrl}</span>
          </div>
        ) : (
          <div className="text-xs text-yellow-300/90">{t('hw.print.notConfigured')}</div>
        )}
        <div className="mt-1 text-[11px] text-ink-500">{t('hw.print.configureHint')}</div>
        <button onClick={() => void onTest()} disabled={testing || !configured} className={`${BTN_CLASS} mt-1.5`}>
          {testing ? <LuLoaderCircle className="animate-spin text-[12px]" /> : <LuPlugZap className="text-[12px]" />}
          <span>{t('hw.print.test')}</span>
        </button>
      </Step>

      {/* 2. 导出 STL */}
      <Step n={2} title={t('hw.print.step2')}>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'base', 'lid', 'board'] as StlPart[]).map((part) => (
            <button key={part} onClick={() => props.onExportStl(part)} className={BTN_CLASS}>
              {`STL · ${t(`hw.parts.${part}`)}`}
            </button>
          ))}
        </div>
        <div className="mt-1.5 text-[11px] leading-4 text-ink-500">{t('hw.print.sliceHint')}</div>
      </Step>

      {/* 3. 上传 G-code */}
      <Step n={3} title={t('hw.print.step3')}>
        <div className="flex items-center gap-2">
          <button onClick={() => void onPickGcode()} className={BTN_CLASS}>
            <LuFileUp className="text-[12px]" />
            <span>{t('hw.print.pickGcode')}</span>
          </button>
          <span
            className={`min-w-0 flex-1 truncate text-xs ${gcodePath ? 'text-jb-text' : 'text-ink-500'}`}
            title={gcodePath ?? undefined}
          >
            {gcodePath ?? t('hw.print.noFile')}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-jb-muted">
            <input
              type="checkbox"
              checked={startPrint}
              onChange={(e) => setStartPrint(e.target.checked)}
              className="accent-[#3574F0]"
            />
            <span>{t('hw.print.startPrint')}</span>
          </label>
          <button
            onClick={() => void onUpload()}
            disabled={!gcodePath || uploading || !configured}
            className={BTN_CLASS}
          >
            {uploading ? (
              <LuLoaderCircle className="animate-spin text-[12px]" />
            ) : (
              <LuUpload className="text-[12px]" />
            )}
            <span>{t('hw.print.upload')}</span>
          </button>
        </div>
      </Step>

      {/* 4. 任务进度 */}
      <Step n={4} title={t('hw.print.step4')}>
        {jobError ? (
          <div className="selectable text-xs text-red-400">{jobError}</div>
        ) : job ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-jb-muted">
              <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[11px] text-jb-text">{job.state}</span>
              {job.fileName && (
                <span className="min-w-0 truncate text-jb-text" title={job.fileName}>
                  {job.fileName}
                </span>
              )}
              {timeLeft && <span className="shrink-0">{t('hw.print.timeLeft', { time: timeLeft })}</span>}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-ink-700">
              <div
                className="h-full rounded bg-accent transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="text-[11px] text-ink-500">{percent}%</div>
          </div>
        ) : (
          <div className="text-xs text-ink-500">{t('hw.print.noJob')}</div>
        )}
      </Step>
    </div>
  )
}
