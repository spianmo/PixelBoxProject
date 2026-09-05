// 真机网络诊断探针: fetch(wttr.in / baidu / http) + ntpSync (aliyun / pool)
// 用法: node probe-netdiag.mjs [ip]
import WebSocket from 'ws';

const IP = process.argv[2] || '192.168.1.202';
const ws = new WebSocket(`ws://${IP}:8765/devd`, { handshakeTimeout: 8000 });
let seq = 1;
const pending = new Map();

ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(2); });
ws.on('message', (data) => {
  let m; try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'log' && m.params) {
    const p = m.params;
    if (p.tag !== 'devd') console.log(`  [dev:${p.tag}] ${p.msg ?? p.message ?? JSON.stringify(p)}`);
  }
});

function rpc(method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = seq++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc ${method} 超时`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evalJs = async (code, timeoutMs = 10000) => {
  const r = await rpc('js.eval', { code }, timeoutMs);
  if (r.error) throw new Error(`eval 错误: ${JSON.stringify(r.error)}`);
  return r.result?.value ?? JSON.stringify(r.result);
};

// 异步探测: 启动写 globalThis.__p, 轮询读取
async function asyncProbe(name, kickoff, timeoutMs) {
  await evalJs(`globalThis.__p = 'pending'; (${kickoff})()
    .then(v => { globalThis.__p = 'ok: ' + v; })
    .catch(e => { globalThis.__p = 'err: ' + (e && e.message || e); }); 'started'`);
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    const v = await evalJs(`globalThis.__p`);
    if (v !== 'pending' && v !== '"pending"') {
      console.log(`${name}: ${v}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return;
    }
    if (Date.now() - t0 > timeoutMs) { console.log(`${name}: 轮询超时 (>${timeoutMs / 1000}s, 仍 pending)`); return; }
  }
}

ws.on('open', async () => {
  try {
    const h = await rpc('hello', {});
    console.log('hello:', JSON.stringify(h.result));
    await rpc('logs.subscribe', { since: 0 }).catch(() => {});
    console.log('wifi:', await evalJs('JSON.stringify(px.wifi.status())'));
    console.log('now:', await evalJs('new Date(px.system.now()).toISOString()'));

    // --- fetch 三连测 (先测网络, NTP 最后测避免死锁风险打断) ---
    await asyncProbe('fetch http(明文对照)',
      `async () => { const r = await fetch('http://wttr.in/?format=%25t', {timeoutMs: 8000}); return r.status + ' ' + (await r.text()).trim().slice(0, 40); }`, 15000);
    await asyncProbe('fetch https://wttr.in',
      `async () => { const r = await fetch('https://wttr.in/?format=${encodeURIComponent('%t|%C')}&lang=zh', {timeoutMs: 10000}); return r.status + ' ' + (await r.text()).trim().slice(0, 40); }`, 20000);
    await asyncProbe('fetch https://www.baidu.com (TLS 对照)',
      `async () => { const r = await fetch('https://www.baidu.com/', {timeoutMs: 8000}); return r.status + ' len=' + (await r.text()).length; }`, 15000);

    // --- NTP: 先国内源, 再默认 pool ---
    await asyncProbe('ntpSync ntp.aliyun.com',
      `async () => { await px.system.ntpSync('ntp.aliyun.com'); return new Date(px.system.now()).toISOString(); }`, 20000);
    await asyncProbe('ntpSync pool.ntp.org (默认)',
      `async () => { await px.system.ntpSync(); return new Date(px.system.now()).toISOString(); }`, 20000);

    console.log('now(终):', await evalJs('new Date(px.system.now()).toISOString()'));
  } catch (e) {
    console.error('探测失败:', e.message);
  } finally {
    ws.close(); process.exit(0);
  }
});
