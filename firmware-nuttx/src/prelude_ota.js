/* 只读 OTA 清单查询；在 prelude_http.js 之后放入 g / px / firmwareVersion /
 * exitHandlers 共享闭包。firmwareVersion 由初始化静态信息提供，不调用有探测副作用的 info。
 * 不下载固件、不写 Flash；otaApply 仍由独立安全升级实现负责。
 */
const otaFetch = g.fetch;
const otaPending = new Set();
let otaActive = true;

/* 与 ESP-IDF opt_str_prop 相同：空值用空串，其余值转字符串，转换失败视为空串。 */
const otaString = value => {
  try { return typeof value === 'symbol' ? '' : String(value); }
  catch (_) { return ''; }
};
const otaProperty = (object, name) => {
  if (!object || typeof object !== 'object') return '';
  const value = object[name];
  return value === undefined || value === null ? '' : otaString(value);
};

/* 兼容原三段比较、v/V 前缀、缺段补零、忽略后缀；按十进制串比较以避免整数溢出。 */
const otaVersionParts = version => {
  const parts = ['0', '0', '0'];
  let offset = version[0] === 'v' || version[0] === 'V' ? 1 : 0;
  for (let part = 0; part < 3 && offset < version.length; ++part) {
    const start = offset;
    while (offset < version.length && version[offset] >= '0' && version[offset] <= '9') ++offset;
    parts[part] = version.slice(start, offset).replace(/^0+/, '') || '0';
    if (version[offset] !== '.') break;
    ++offset;
  }
  return parts;
};
const otaVersionCompare = (left, right) => {
  const a = otaVersionParts(left), b = otaVersionParts(right);
  for (let part = 0; part < 3; ++part) {
    if (a[part].length !== b[part].length) return a[part].length > b[part].length ? 1 : -1;
    if (a[part] !== b[part]) return a[part] > b[part] ? 1 : -1;
  }
  return 0;
};

px.system.otaCheck = function (manifestUrl) {
  if (!arguments.length) throw new Error('otaCheck(manifestUrl) 缺少 URL');
  const url = otaString(manifestUrl);
  return new Promise((resolve, reject) => {
    if (!otaActive) { reject(new Error('ECANCELED: OTA context is closed')); return; }
    const request = {resolve, reject};
    otaPending.add(request);
    const finish = (failed, value) => {
      if (!otaPending.delete(request)) return;
      if (failed) reject(value); else resolve(value);
    };
    const query = async () => {
      let response;
      try {
        /* fetch 对 DNS、连接、响应体和重定向共用截止时间，退出由网络 owner 统一关闭。 */
        response = await otaFetch(url, {timeoutMs: 10000});
      } catch (error) {
        const message = error instanceof Error ? error.message : otaString(error);
        throw new Error('OTA manifest 获取失败: ' + message);
      }
      if (!otaPending.has(request)) return;
      if (response.status !== 200) throw new Error('OTA manifest 获取失败: HTTP ' + response.status);
      /* JSON 语法错误保持原异常，不误包装成 HTTP 错误。 */
      const manifest = await response.json();
      if (!otaPending.has(request)) return;
      const version = otaProperty(manifest, 'version'), firmwareUrl = otaProperty(manifest, 'url');
      const notes = otaProperty(manifest, 'notes');
      if (!version || !firmwareUrl) throw new Error('manifest 缺少 version/url 字段');
      if (otaVersionCompare(version, firmwareVersion) <= 0) return null;
      const result = {version, url: firmwareUrl};
      if (notes) result.notes = notes;
      return result;
    };
    query().then(value => finish(false, value), error => finish(true, error));
  });
};

/* 退出先使查询失效；迟到响应只消费内部 Promise，不能再次完成旧应用的请求。 */
exitHandlers.add(() => {
  otaActive = false;
  const error = new Error('ECANCELED: application exited');
  for (const request of otaPending) request.reject(error);
  otaPending.clear();
});
