/**
 * 「复制路径 / 复制相对路径」共用助手(文件树 / 编辑器页签右键菜单)
 * - 剪贴板写入走主进程(见 main/shell.ts 的 shell:copy-text)
 * - 相对路径以工作区根为基准,分隔符沿用原路径写法(Windows 反斜杠 / POSIX 斜杠)
 */
import i18n from '../i18n'
import { showToast } from './toast'

/**
 * 仅用于前缀比较的归一化:分隔符统一为 /,去掉末尾分隔符,Windows 盘符统一小写。
 * 盘符归一是必需的:monaco 的 Uri.fsPath 恒返回小写盘符,而工作区根来自原生对话框
 * (常为大写盘符),不归一会把工程内文件误判成工作区外(见 App.tsx 打开链路同款注释)。
 * 变换保持长度不变,故调用方仍可按原始 root 长度切分,复制出的路径保留原始大小写。
 */
function normalizeForCompare(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

/** 目标路径是否就是工作区根(根行/空白区右键:相对路径无意义,提示语需与「工作区外」区分) */
export function isWorkspaceRoot(root: string | null | undefined, abs: string): boolean {
  if (!root || !abs) return false
  return normalizeForCompare(root) === normalizeForCompare(abs)
}

/**
 * 绝对路径 → 相对工作区根的路径。
 * 返回 null 表示「复制相对路径」不适用:未打开工作区、路径不在工作区内
 * (clangd 跳转打开的工作区外只读文件)、或路径本身就是工作区根。
 */
export function relativeToRoot(root: string | null | undefined, abs: string): string | null {
  if (!root || !abs) return null
  const nRoot = normalizeForCompare(root)
  const nAbs = normalizeForCompare(abs)
  if (nRoot === '' || nAbs === nRoot || !nAbs.startsWith(`${nRoot}/`)) return null
  // 按原始 root 长度切分:root 带不带末尾分隔符都能落在分隔符边界上
  const rel = abs.slice(root.length).replace(/^[\\/]+/, '')
  return rel === '' ? null : rel
}

/** 写入剪贴板并轻提示(高频操作:短时长且不进通知历史) */
export function copyPathToClipboard(path: string): void {
  void window.api.copyText(path)
  showToast(path, 'success', { title: i18n.t('common.pathCopied'), durationMs: 2000, history: false })
}
