// settings_app.js WiFi 配网真机验收探针 (免触屏, __pxset 驱动)
// 用法: node probe-settings-wifi.mjs [ip] [ssid] [password]
//
// 安全约束: 设备 devd 走的就是被测 WiFi。绝不在 UI 上断开/连别的网 (会失联)。
//   - 键盘流程对「邻居加密 AP」逐键输入但不点连接
//   - 连接链路用 px.wifi.connect 对当前网络原地重连 (短暂掉线, 自动重连核验)
// 结束后恢复像素时钟应用。
import WebSocket from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const IP = process.argv[2] || '192.168.1.202';
const SSID = process.argv[3] || 'MST';
const PASS = process.argv[4] || '20250301';
const SETTINGS_JS = '/Users/finger/Projects/TeamhelperProjects/esp32_devices/firmware/components/appmgr/src/settings_app.js';
const CLOCK_DIR = '/Users/finger/Projects/TeamhelperProjects/esp32_devices/examples/02-pixel-clock';

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else { failures++; console.error('FAIL  ' + msg); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- devd 客户端 (可重连) ----------
let ws = null, seq = 1, expectClose = false;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://${IP}:8765/devd`, { handshakeTimeout: 8000 });
    sock.on('error', (e) => { if (!expectClose) console.error('  (ws error: ' + e.message + ')'); reject(e); });
    sock.on('close', () => { if (!expectClose) console.error('  (ws 断开)'); });
    sock.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    sock.on('open', () => { ws = sock; resolve(); });
  });
}
async function reconnect(tries = 15) {
  expectClose = true;
  try { ws && ws.close(); } catch {}
  for (let i = 0; i < tries; i++) {
    await sleep(2000);
    try { await connect(); expectClose = false; return true; } catch {}
  }
  return false;
}
function rpc(method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = seq++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc ${method} 超时`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalJs = async (code, timeoutMs = 10000) => (await rpc('js.eval', { code }, timeoutMs)).result;
async function evalJson(code) {
  const raw = await evalJs(`JSON.stringify(${code})`);
  let v = raw;
  for (let i = 0; i < 2 && typeof v === 'string'; i++) { try { v = JSON.parse(v); } catch { break; } }
  return v;
}
const st = () => evalJson('globalThis.__pxset.state()');
const tap = async (x, y) => { await evalJs(`globalThis.__pxset.tap(${Math.round(x)}, ${Math.round(y)}); 'tapped'`); };
const keyTap = async (ch) => {
  const k = await evalJson(`globalThis.__pxset.key(${JSON.stringify(ch)})`);
  if (!k) throw new Error(`键 ${ch} 不在当前键盘模式`);
  await tap(k.x, k.y);
};

async function pushFiles(manifest, files) {
  const list = files.map(({ path, body }) => ({ path, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
  const { session } = await rpc('app.push_begin', { manifest, files: list });
  for (const { path, body } of files) {
    for (let off = 0; off < body.length; off += 4096) {
      await rpc('app.push_chunk', { session, path, offset: off, dataB64: body.subarray(off, Math.min(off + 4096, body.length)).toString('base64') });
    }
  }
  await rpc('app.push_end', { session }, 30000);
}

// ---------- 主流程 ----------
await connect();
const h = await rpc('hello', {});
console.log(`hello: app=${h.app} fw=${h.fw} heap=${h.heapFree}`);

console.log('\n[1] 推送设置页为测试应用');
await pushFiles(
  { id: 'com.pixelbox.probe.settings', name: 'settings-test', version: '0.0.1', entry: 'main.js', assets: [], minFirmware: '0.1.0' },
  [{ path: 'main.js', body: Buffer.from(readFileSync(SETTINGS_JS, 'utf8'), 'utf8') }]);
await sleep(3500);
ok((await evalJs('typeof globalThis.__pxset')) === 'object', '__pxset 钩子就绪');
let s = await st();
ok(s.page === 'main', `初始主页 (page=${s.page})`);

console.log('\n[2] 进 WiFi 页 + 真实扫描');
const row = await evalJson('globalThis.__pxset.rows.wifi');
await tap(row.x, row.y);
s = await st();
ok(s.page === 'wifi', '进入 wifi 页');
let waited = 0;
while (s.scanning && waited < 20000) { await sleep(1000); waited += 1000; s = await st(); }
ok(!s.scanning && !s.scanErr, `扫描完成 (${waited}ms, err=${s.scanErr})`);
ok(s.aps > 0, `发现 ${s.aps} 个网络: ${(s.ssids || []).slice(0, 8).join(', ')}`);
const mstIdx = (s.ssids || []).indexOf(SSID);
ok(mstIdx >= 0, `当前网络 ${SSID} 在列表第 ${mstIdx} 行`);
if (mstIdx < 0) { console.error('目标网络不在扫描结果, 终止'); process.exit(1); }

console.log('\n[3] 点已连接网络 → 拦截 toast (不断开)');
let r = await evalJson(`globalThis.__pxset.listRow(${mstIdx})`);
await tap(r.x, r.y);
s = await st();
ok(s.page === 'wifi' && (s.toast || '').includes('已连接'), `已连网络拦截 (toast=${s.toast})`);
await sleep(2800); // 等 toast 过期

console.log('\n[4] 邻居加密 AP → 键盘逐键输入 (不点连接)');
const nIdx = (s.ssids || []).findIndex((name, i) => name !== SSID && s.secures[i] === 1);
if (nIdx < 0) {
  console.log('  (无邻居加密 AP, 跳过键盘真机流)');
} else {
  // 目标行可能在屏外: 该行中心若超出屏高则先滚动
  r = await evalJson(`globalThis.__pxset.listRow(${nIdx})`);
  const Hs = 480;
  if (r.y > Hs - 40) {
    await evalJs(`globalThis.__pxset.swipe(240, ${Math.min(r.y, Hs - 20)}, 240, 100); 'sw'`);
    r = await evalJson(`globalThis.__pxset.listRow(${nIdx})`);
  }
  await tap(r.x, r.y);
  s = await st();
  ok(s.page === 'pass' && s.passSsid === (await st()).passSsid && s.passSsid !== SSID,
     `密码页就绪 (ssid=${s.passSsid})`);
  await keyTap('shift');
  s = await st(); ok(s.kbMode === 'upper', 'shift 切大写');
  await keyTap('shift');
  await keyTap('a'); await keyTap('b');
  await keyTap('num');
  s = await st(); ok(s.kbMode === 'num', '123 切数字页');
  await keyTap('1'); await keyTap('2');
  await keyTap('sym');
  s = await st(); ok(s.kbMode === 'sym', '#+= 切符号页');
  await keyTap('_');
  await keyTap('abc');
  await keyTap('bksp');
  s = await st();
  ok(s.passLen === 4, `键盘输入+退格 → 4 字符 (实际 ${s.passLen})`);

  // 渲染抽查: 连接键此时应为绿色填充 (RGB565 往返容差)
  const okKey = await evalJson(`globalThis.__pxset.key('ok')`);
  const pix = await evalJson(`px.screen.getPixel(${okKey.x}, ${okKey.y - 18})`);
  const near = (a, b) => Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) <= 8
    && Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= 8 && Math.abs((a & 255) - (b & 255)) <= 8;
  ok(near(Number(pix), 0x39c26d), `连接键绿色渲染 (getPixel=0x${Number(pix).toString(16)})`);
  // 键盘背景抽查
  const bgPix = await evalJson(`px.screen.getPixel(2, 478)`);
  ok(near(Number(bgPix), 0x0e1420) || near(Number(bgPix), 0x161e2b) || near(Number(bgPix), 0x33445c),
     `键盘区渲染 (getPixel=0x${Number(bgPix).toString(16)})`);

  await tap(10, 10); // 返回 (不连接)
  s = await st();
  ok(s.page === 'wifi', '密码页返回列表');
}

console.log('\n[5] 连接链路: px.wifi.connect 原地重连当前网络 (devd 将短暂掉线)');
expectClose = true;
try {
  await evalJs(`void px.wifi.connect(${JSON.stringify(SSID)}, ${JSON.stringify(PASS)}, {timeoutMs: 20000}).catch(function(e){}); 'kicked'`);
} catch { console.log('  (发起期间断线, 继续)'); }
await sleep(12000);
let re = true;
if (!ws || ws.readyState !== WebSocket.OPEN) re = await reconnect();
else expectClose = false;
ok(re, '重连后 devd 恢复');
if (re) {
  const wst = await evalJson('px.wifi.status()');
  ok(wst.connected === true && wst.ssid === SSID, `WiFi 已重连 ${wst.ssid} @ ${wst.ip}`);
}

console.log('\n[6] 恢复像素时钟应用');
if (re && existsSync(`${CLOCK_DIR}/dist/main.js`)) {
  await pushFiles(JSON.parse(readFileSync(`${CLOCK_DIR}/pixelbox.json`, 'utf8')),
    [{ path: 'main.js', body: readFileSync(`${CLOCK_DIR}/dist/main.js`) }]);
  console.log('  已恢复 像素时钟');
} else if (!re) {
  console.log('  (devd 未恢复, 跳过)');
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
expectClose = true;
try { ws && ws.close(); } catch {}
process.exit(failures === 0 ? 0 : 1);
