/**
 * 通用小工具:日志 / sleep / 信号合并 / PCM 能量计算
 */

/** 带时间戳与标签的日志 */
export function log(tag: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${ts} [${tag}]`, ...args);
}

export function logWarn(tag: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.warn(`${ts} [${tag}]`, ...args);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 合并外部中止信号与超时:任一触发即中止。
 * Node 20.3+ 提供 AbortSignal.any / AbortSignal.timeout。
 */
export function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const list: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) list.push(signal);
  return AbortSignal.any(list);
}

/** 计算一段 PCM16LE 单声道数据的 RMS 能量(0~32767) */
export function pcm16Rms(buf: Buffer): number {
  const n = Math.floor(buf.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** 从未知错误中提取可读消息 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 判断是否为主动中止(AbortController / 超时)导致的异常 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
