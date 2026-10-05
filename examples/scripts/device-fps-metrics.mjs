/** 真机 FPS 统计的单调时钟与计数校验；不以主机 sleep 时间替代设备经过时间。 */
export const callbackProbe = `
;(() => {
  const original = px.screen.onFrame;
  globalThis.__deviceFps = { callbacks: 0 };
  px.screen.onFrame = function (callback) {
    return original.call(this, function (dt) {
      __deviceFps.callbacks++;
      return callback(dt);
    });
  };
})();
`;
export const snapshotCode = `JSON.stringify({
  at: performance.now(), id:px.app.id,
  callbacks: globalThis.__deviceFps ? __deviceFps.callbacks :
    (globalThis.__pxset ? __pxset.state().frameCallbacks : null),
  stats:px.screen.frameStats()
})`;

/**
 * 在设备热切换/统计对象重建时重新建立采样基线。
 * 采样窗口内的显示错误仍然直接失败，只有可恢复的基线失效会重试。
 */
export async function sampleMetrics(readSnapshot, sleep, durationMs, options = {}) {
  const settleMs = options.settleMs ?? 250;
  const maxAttempts = options.maxAttempts ?? 4;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const before = await readSnapshot();
    await sleep(durationMs);
    const after = await readSnapshot();
    try {
      return { before, after, ...metrics(before, after), attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const recoverable = /应用切换|设备单调时钟无效|统计计数重置|脏矩形规划计数重置|回调计数重置/.test(message);
      if (!recoverable || attempt + 1 >= maxAttempts) throw error;
      await sleep(settleMs);
    }
  }
  throw lastError ?? new Error('FPS 采样失败');
}

export function metrics(before, after) {
  const elapsedMs = after.at - before.at;
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs) || before.id !== after.id)
    throw new Error('采样期间应用切换或设备单调时钟无效');
  const delta = {};
  for (const key of ['frames','updates','errors','convertedPixels','changedPixels',
    'transactions','transmittedPixels','conversionMs','updateMs']) {
    delta[key] = after.stats[key] - before.stats[key];
    if (!Number.isFinite(delta[key]) || delta[key] < 0)
      throw new Error(`统计计数重置或无效: ${key}`);
  }
  if ('planningMs' in before.stats && 'planningMs' in after.stats) {
    delta.planningMs = after.stats.planningMs - before.stats.planningMs;
    if (!Number.isFinite(delta.planningMs) || delta.planningMs < 0)
      throw new Error('脏矩形规划计数重置或无效');
  }
  if (delta.errors) throw new Error(`显示更新失败 ${delta.errors} 次`);
  if (delta.updates > delta.frames || delta.changedPixels > delta.convertedPixels)
    throw new Error('framebuffer 计数关系不一致');
  const callbacks = before.callbacks === null || after.callbacks === null
    ? null : after.callbacks - before.callbacks;
  if (callbacks !== null && (!Number.isSafeInteger(callbacks) || callbacks < 0))
    throw new Error('回调计数重置或无效');
  return { elapsedMs, callbacks, callbackFps: callbacks === null ? null : callbacks * 1000 / elapsedMs,
    flushFps: delta.frames * 1000 / elapsedMs, submittedFps: delta.updates * 1000 / elapsedMs, ...delta };
}
