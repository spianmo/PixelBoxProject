/** 电路求值预算覆盖加载、执行、布线和结果传回；不是空闲超时。 */
export const HARDWARE_EVAL_TIMEOUT_MS = 120_000
export type HardwareEvalPhase = 'loading' | 'executing' | 'routing' | 'reading'

/** 超时与取消都必须先打断 Worker，再结束本次调用，防止旧结果回写。 */
export async function evaluateWithDeadline<T>(work: () => Promise<T>, stop: () => void,
  signal: AbortSignal, timeoutMs = HARDWARE_EVAL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        const fail = (message: string): void => { stop(); reject(new Error(message)) }
        onAbort = () => fail('hardware:evalCancelled')
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => fail('hardware:evalTimeout'), timeoutMs)
      }),
      signal.aborted ? new Promise<T>(() => {}) : work()
    ])
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
