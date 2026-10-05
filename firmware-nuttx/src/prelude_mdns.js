/* 独立owner的mDNS结果仅在JS线程派发；关闭时拒绝所有未完成Promise。 */
const mdnsNative = native.mdns;
const mdnsPending = new Map();
let mdnsActive = true;
let mdnsTimer = 0;
const mdnsIdle = () => {
  if (!mdnsPending.size && mdnsTimer) { clearInterval(mdnsTimer); mdnsTimer = 0; }
};
const mdnsClose = error => {
  if (!mdnsActive) return;
  mdnsActive = false;
  if (mdnsTimer) clearInterval(mdnsTimer);
  mdnsTimer = 0;
  mdnsNative.shutdown();
  for (const pending of mdnsPending.values()) pending.reject(error);
  mdnsPending.clear();
};
const mdnsPump = () => {
  for (let count = 0; count < 4 && mdnsActive; ++count) {
    let event;
    try { event = mdnsNative.poll(); }
    catch (error) { mdnsClose(error); return; }
    if (!event) break;
    const pending = mdnsPending.get(event.id);
    if (!pending) continue;
    mdnsPending.delete(event.id);
    if (event.error) pending.reject(new Error((event.code || 'MDNS_ERROR') + ': discovery failed (' + event.error + ')'));
    else pending.resolve(event.services);
  }
  mdnsIdle();
};
px.net.mdns = {
  discover(service, options = {}) {
    return new Promise((resolve, reject) => {
      if (!mdnsActive) throw new Error('ECANCELED: mDNS context is closed');
      if (!options || typeof options !== 'object') throw new TypeError('discover options must be an object');
      const timeout = options.timeoutMs === undefined ? 3000 : options.timeoutMs;
      /* getter可能重入退出；timer建立失败时不能留下native查询。 */
      if (!mdnsActive) throw new Error('ECANCELED: mDNS context is closed');
      if (!mdnsTimer) mdnsTimer = setInterval(mdnsPump, 25);
      try {
        const id = mdnsNative.discover(service, timeout);
        mdnsPending.set(id, {resolve, reject});
      } catch (error) { mdnsIdle(); throw error; }
    });
  },
  advertise(options) {
    if (!mdnsActive) throw new Error('ECANCELED: mDNS context is closed');
    if (!options || typeof options !== 'object') throw new TypeError('advertise options must be an object');
    const name = options.name === undefined ? 'pixelbox' : options.name;
    const service = options.service, port = options.port, txt = options.txt;
    if (!mdnsActive) throw new Error('ECANCELED: mDNS context is closed');
    const id = mdnsNative.advertise(name, service, port, txt);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (mdnsActive) mdnsNative.unadvertise(id);
    };
  }
};
exitHandlers.add(() => mdnsClose(new Error('ECANCELED: application exited')));
