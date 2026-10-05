/* NTP Promise只在JS主循环派发；没有任务时移除轮询timer，退出时关闭整个owner。 */
const systemNetNative = native.systemNet;
const systemNetPending = new Map();
const systemNetTimeout = 16000;
let systemNetTimer = 0;
let systemNetActive = true;
const systemNetIdle = () => {
  if (!systemNetPending.size && systemNetTimer) { clearInterval(systemNetTimer); systemNetTimer = 0; }
};
const systemNetClose = error => {
  if (!systemNetActive) return;
  systemNetActive = false;
  if (systemNetTimer) clearInterval(systemNetTimer);
  systemNetTimer = 0;
  for (const pending of systemNetPending.values()) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }
  systemNetNative.shutdown();
  systemNetPending.clear();
};
const systemNetPump = () => {
  for (let count = 0; count < 8 && systemNetActive; ++count) {
    let event;
    try { event = systemNetNative.poll(); }
    catch (error) { systemNetClose(error); return; }
    if (!event) break;
    const pending = systemNetPending.get(event.id);
    if (!pending) continue;
    systemNetPending.delete(event.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (event.error) pending.reject(new Error((event.code || 'SYSTEM_ERROR') + ': NTP synchronization failed (' + event.error + ')'));
    else pending.resolve();
  }
  systemNetIdle();
};
px.system.ntpSync = server => new Promise((resolve, reject) => {
  if (!systemNetActive) throw new Error('ECANCELED: system network context is closed');
  /* 先创建timer，避免timer容量不足时留下永远没人消费的native任务。 */
  if (!systemNetTimer) systemNetTimer = setInterval(systemNetPump, 25);
  let id = 0;
  let pending = null;
  try {
    id = systemNetNative.start(server, 15000);
    pending = { resolve, reject, timer: 0 };
    systemNetPending.set(id, pending);
    /* libc DNS在部分NuttX网络状态下可能迟迟不返回；不能让上层Promise永久挂起。 */
    try {
      pending.timer = setTimeout(() => {
        if (systemNetPending.get(id) !== pending) return;
        try { systemNetNative.cancel(id); }
        catch (_) {
          /* native上下文已失效时不会再有取消事件，立即释放JS pending和轮询timer。 */
          systemNetPending.delete(id);
          systemNetIdle();
        }
        pending.reject(new Error('ETIMEDOUT: NTP synchronization'));
        /* 保留pending，等待cancel事件被pump消费后再停掉轮询timer。 */
      }, systemNetTimeout);
    } catch (error) {
      /* JS timer容量耗尽时也要等待native取消事件，释放NTP worker和任务槽。 */
      try { systemNetNative.cancel(id); }
      catch (_) { systemNetPending.delete(id); systemNetIdle(); }
      pending.reject(error);
      return;
    }
  } catch (error) {
    if (pending) systemNetPending.delete(id);
    if (id) {
      try { systemNetNative.cancel(id); } catch (_) {}
    }
    systemNetIdle(); throw error;
  }
});
px.system.temperature = () => {
  if (!systemNetActive) throw new Error('ECANCELED: system network context is closed');
  return systemNetNative.temperature();
};
exitHandlers.add(() => systemNetClose(new Error('ECANCELED: application exited')));
