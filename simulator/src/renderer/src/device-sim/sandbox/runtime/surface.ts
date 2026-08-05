/**
 * px shim 表面完整性自检(验收红线守卫)
 *
 * 运行时在执行用户代码前调用 verifySurface():
 * 逐一核对 d.ts 契约要求的 16 个 px 命名空间与全部标准全局,缺一即抛错,
 * 应用不会在残缺的 shim 上启动。selfcheck 脚本亦以本清单做静态核对。
 */

/** d.ts PixelBox 接口的全部命名空间 */
export const PX_NAMESPACES = [
  'system',
  'app',
  'storage',
  'screen',
  'input',
  'audio',
  'voice',
  'wifi',
  'net',
  'ble',
  'camera',
  'gps',
  'sensors',
  'led',
  'util',
  'color'
] as const

/** d.ts 要求的标准全局 */
export const STD_GLOBALS = [
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'fetch',
  'WebSocket',
  'TextEncoder',
  'TextDecoder',
  'atob',
  'btoa',
  'performance'
] as const

export function verifySurface(px: Record<string, unknown>): void {
  const missing: string[] = []
  for (const ns of PX_NAMESPACES) {
    const v = px[ns]
    if (v === undefined || v === null) missing.push(`px.${ns}`)
  }
  const g = globalThis as unknown as Record<string, unknown>
  for (const name of STD_GLOBALS) {
    if (g[name] === undefined || g[name] === null) missing.push(name)
  }
  if (missing.length > 0) {
    throw new Error(`px shim 表面不完整,缺失: ${missing.join(', ')}`)
  }
}
