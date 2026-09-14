/** 硬件检查复用 IDE 的构建输出与通知历史，预览区不再承载完整报告。 */
import type { BuildLogLine } from '../../../shared/ipc-types'
import { HARDWARE_EVAL_TIMEOUT_MS } from '../../../shared/hardwareEvaluation'
import i18n from '../i18n'
import { showToast, type ToastKind } from '../components/toast'
import type { HardwareValidation } from './validation'

export function openHardwareBuildOutput(): void {
  window.dispatchEvent(new Event('pixelbox:open-build-output'))
}

export function hardwareErrorText(message: string): string {
  const keys: Record<string, string> = {
    'hardware:evalTimeout': 'hw.errors.evalTimeout',
    'hardware:evalCancelled': 'hw.errors.evalCancelled',
    'hardware:noBoardEntry': 'hw.errors.noBoardEntry',
    'hw:noBoard': 'hw.errors.noBoard'
  }
  return keys[message] ? i18n.t(keys[message], { seconds: HARDWARE_EVAL_TIMEOUT_MS / 1000 }) : message
}

export function writeHardwareBuildLog(root: string, lines: Array<Pick<BuildLogLine, 'level' | 'text'>>): void {
  const project = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
  // 日志传输失败只报告一次独立错误，不让成功的电路求值变成失败或触发递归上报。
  void window.api.reportBuildLogs(lines.map(line => ({ ...line, text: `[${project}] ${line.text}` })))
    .catch(error => showToast(String(error), 'error', { title: i18n.t('hw.build.outputFailed') }))
}

function notifyResult(root: string, text: string, kind: ToastKind): void {
  const project = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
  showToast(`${project} · ${text}`, kind, {
    title: i18n.t('hw.build.title'),
    action: { label: i18n.t('hw.build.viewOutput'), onClick: openHardwareBuildOutput }
  })
}

export function reportHardwareFailure(root: string, stage: 'pcb' | 'enclosure', message: string): void {
  const cancelled = message === 'hardware:evalCancelled'
  const text = `${i18n.t(`hw.build.${stage}`)}：${hardwareErrorText(message)}`
  writeHardwareBuildLog(root, [{ level: cancelled ? 'info' : 'error', text }])
  notifyResult(root, text.split('\n')[0], cancelled ? 'info' : 'error')
}

export function reportHardwareValidation(root: string, report: HardwareValidation): void {
  const issues = report.errors.length + report.printErrors.length
  const summary = i18n.t('hw.build.summary', { ...report.counts, issues, notes: report.warnings.length })
  writeHardwareBuildLog(root, [
    { level: issues ? 'error' : 'info', text: summary },
    ...report.errors.map(text => ({ level: 'error' as const, text: `${i18n.t('hw.build.manufacturing')}：${text}` })),
    ...report.printErrors.map(text => ({ level: 'error' as const, text: `${i18n.t('hw.build.assembly')}：${text}` })),
    ...report.warnings.map(text => ({ level: 'warn' as const, text: `${i18n.t('hw.build.note')}：${text}` }))
  ])
  // 有未验证项时使用黄色通知；不以绿色成功掩盖报告中的边界条件。
  notifyResult(root, i18n.t(issues ? 'hw.build.failed' : 'hw.build.passed', { issues, notes: report.warnings.length }),
    issues ? 'error' : report.warnings.length ? 'warn' : 'success')
}
