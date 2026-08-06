/**
 * 独立工具窗渲染入口(视图模式 Window;main.tsx 检测 ?toolwindow=<id> 分流)
 *
 * 深色壳同主题:顶部 36px 拖拽条(macOS 红绿灯让位 80px;Windows/Linux 自绘 最小化/关闭),
 * 下方复用 ToolWindow 容器(不传 toolId —— 独立窗口内不再提供视图模式切换,
 * 回停靠 = 关闭本窗口,main 广播 toolwindow:closed 后主窗将其回 Dock Pinned)。
 *
 * - terminal:完整终端 UI(会话在 main 进程 PtyService,数据 broadcast 全窗口;
 *   本窗经 terminal:list 恢复会话列表,与主窗输入输出实时互通)
 * - build:构建输出只读镜像(build:log / toolchain:log 均为全窗口广播),
 *   复用 LogsToolWindow 的构建页(ANSI 解析 + 清空 + 滚动锁定)
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuHammer, LuMinus, LuSquareTerminal, LuX } from 'react-icons/lu'
import { ToolWindow } from './ToolWindow'
import { LogsToolWindow, type LogLine } from './LogsToolWindow'
import { TerminalHeader, TerminalHeaderActions, TerminalPanel } from '../terminal/TerminalToolWindow'
import { initTerminals } from '../terminal/store'

const MAX_LOG_LINES = 2000

/** 构建输出镜像页(订阅广播;窗口自持日志缓冲,与主窗互不影响) */
function BuildOutputPane(): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])

  useEffect(() => {
    const append = (add: LogLine[]): void => {
      if (add.length === 0) return
      setLines((prev) => {
        const next = [...prev, ...add]
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
      })
    }
    const unsubs = [
      // esbuild 构建日志(单行)
      window.api.onBuildLog((line) => append([{ level: line.level, text: line.text, ts: line.ts }])),
      // 固件工具链输出(批量行)
      window.api.onFirmwareLog((batch) =>
        append(batch.map((l) => ({ level: l.level, text: l.text, ts: l.ts })))
      )
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  return (
    <LogsToolWindow
      activeTab="build"
      appLogs={[]}
      buildLogs={lines}
      problems={[]}
      onClear={() => setLines([])}
    />
  )
}

export function StandaloneToolWindow({ toolId }: { toolId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const isMac = window.api.platform === 'darwin'

  // 终端:进入即初始化(订阅数据流 + terminal:list 恢复主窗已有会话)
  useEffect(() => {
    if (toolId === 'terminal') initTerminals()
  }, [toolId])

  /** 关闭本窗口(main 侧 closed 广播 → 主窗该工具窗回 Dock Pinned) */
  const close = (): void => window.api.windowClose()

  const title =
    toolId === 'terminal'
      ? t('terminal.title')
      : toolId === 'build'
        ? t('console.buildOutput')
        : toolId

  return (
    <div className="flex h-full flex-col bg-ink-900 text-jb-text">
      {/* 顶部拖拽条(深色壳;macOS 红绿灯让位) */}
      <div
        className="app-drag flex h-9 shrink-0 items-center gap-1.5 border-b border-ink-700 bg-ink-850"
        style={{ paddingLeft: isMac ? 80 : 10 }}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-jb-text">
          <span className="text-jb-muted">
            {toolId === 'terminal' ? <LuSquareTerminal /> : <LuHammer />}
          </span>
          {title}
          <span className="text-jb-muted">— PixelBox</span>
        </span>
        {/* Windows/Linux 自绘窗口控制(macOS 走原生红绿灯) */}
        {!isMac && (
          <div className="app-no-drag ml-auto flex h-full items-stretch">
            <button
              title={t('titlebar.minimize')}
              onClick={() => window.api.windowMinimize()}
              className="flex w-11 items-center justify-center text-jb-muted hover:bg-ink-800 hover:text-jb-text"
            >
              <LuMinus />
            </button>
            <button
              title={t('titlebar.close')}
              onClick={close}
              className="flex w-11 items-center justify-center text-jb-muted hover:bg-red-600 hover:text-white"
            >
              <LuX />
            </button>
          </div>
        )}
      </div>

      {/* 工具窗主体(隐藏 — 按钮 = 关窗回停靠) */}
      <div className="min-h-0 flex-1">
        {toolId === 'terminal' ? (
          <ToolWindow
            title={t('terminal.title')}
            header={<TerminalHeader />}
            actions={<TerminalHeaderActions />}
            onHide={close}
          >
            <TerminalPanel />
          </ToolWindow>
        ) : toolId === 'build' ? (
          <ToolWindow title={t('console.buildOutput')} icon={<LuHammer />} onHide={close}>
            <BuildOutputPane />
          </ToolWindow>
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-ink-500">
            {t('toolwindow.unknownStandalone', { id: toolId })}
          </div>
        )}
      </div>
    </div>
  )
}
