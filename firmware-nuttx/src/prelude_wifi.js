/* 主线程轮询只在有作业/订阅时保活；连接跨应用存活，凭据在拿到 IP 后原子保存。 */
const wifiListeners = { connected: new Set(), disconnected: new Set(), gotIp: new Set() };
const wifiCredentialsPath = '/data/.pixelbox-wifi.json';
let wifiTimer = 0, wifiPending = null;
const wifiStatus = () => {
  const status = native.wifiStatus();
  if (!status.mac) status.mac = native.mac;
  return status;
};
const wifiError = code => Object.assign(new Error('Wi-Fi operation failed (' + code + ')'), { code });
const wifiRefreshTimer = () => {
  const needed = wifiPending || Object.values(wifiListeners).some(set => set.size);
  if (needed && !wifiTimer) wifiTimer = setInterval(wifiPoll, 25);
  if (!needed && wifiTimer) { clearInterval(wifiTimer); wifiTimer = 0; }
};
const wifiPoll = () => {
  const result = native.wifiPoll();
  if (!result) return;
  const current = wifiPending;
  if (current && result.operation && result.id === current.id) {
    wifiPending = null;
    if (result.error) current.reject(wifiError(result.error));
    else {
      try {
        if (current.credentials) native.atomicWrite(wifiCredentialsPath, JSON.stringify(current.credentials));
        current.resolve(result.operation === 1 ? result.aps : result.status);
      } catch (error) { current.reject(error); }
    }
  }
  for (const [bit, event] of [[1, 'connected'], [2, 'disconnected'], [4, 'gotIp']]) {
    if (result.events & bit) for (const callback of [...wifiListeners[event]]) callback(result.status);
  }
  wifiRefreshTimer();
};
const wifiBegin = (start, credentials) => new Promise((resolve, reject) => {
  if (wifiPending) throw new Error('EBUSY: Wi-Fi operation in progress');
  const id = start();
  wifiPending = { id, credentials, resolve, reject };
  wifiRefreshTimer();
});
px.wifi = {
  scan: () => wifiBegin(() => native.wifiScan(10000), null),
  connect(ssid, password = '', opts = {}) {
    return Promise.resolve().then(() => {
      if (!opts || typeof opts !== 'object') throw new TypeError('Wi-Fi options must be an object');
      const timeout = opts.timeoutMs === undefined ? 15000 : Number(opts.timeoutMs);
      const save = opts.save !== false;
      return wifiBegin(() => native.wifiConnect(ssid, password, timeout), save ? { ssid, password } : null);
    });
  },
  disconnect: () => native.wifiDisconnect(),
  status: wifiStatus,
  on(event, callback) {
    if (!Object.hasOwn(wifiListeners, event)) throw new TypeError('invalid Wi-Fi event');
    if (typeof callback !== 'function') throw new TypeError('Wi-Fi listener must be a function');
    wifiListeners[event].add(callback); wifiRefreshTimer();
    return () => { wifiListeners[event].delete(callback); wifiRefreshTimer(); };
  },
  startAP: unsupported,
  stopAP: noop
};
exitHandlers.add(() => {
  if (wifiTimer) clearInterval(wifiTimer);
  wifiTimer = 0;
  /* 未完成操作属于当前应用；撤销后由 C worker 清理，旧 Promise 不再触碰新 VM。 */
  if (wifiPending) native.wifiAbandon();
  wifiPending = null;
  for (const listeners of Object.values(wifiListeners)) listeners.clear();
});
if (native.model === 'pixelbox-nuttx-esp32s3' && !wifiStatus().connected && native.fs.exists(wifiCredentialsPath)) {
  try {
    const saved = JSON.parse(native.fs.readText(wifiCredentialsPath));
    if (saved && typeof saved.ssid === 'string' && typeof saved.password === 'string')
      px.wifi.connect(saved.ssid, saved.password, { save: false }).catch(() => console.warn('[pixelbox] Wi-Fi auto-connect failed'));
  } catch (_) { console.warn('[pixelbox] Wi-Fi credentials could not be read'); }
}
