// 修复验收探针:死锁回归 / 推送时钟 / 热重启轰炸(UAF) / 停机窗口 / 画面抽查
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const IP = process.argv[2] || '192.168.1.202';
const CLOCK_DIR = '/Users/finger/Projects/TeamhelperProjects/esp32_devices/examples/02-pixel-clock';
const ws = new WebSocket(`ws://${IP}:8765/devd`, { handshakeTimeout: 8000 });
let seq = 1;
const pending = new Map();
let bootAtStart = -1;
let sawNtpOk = false, sawWeather = false;

ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(2); });
ws.on('close', () => { console.error('WS 意外断开(设备重启/崩溃?)'); process.exit(3); });
ws.on('message', (data) => {
  let m; try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  const p = m.params;
  if (m.method === 'log' && p && p.tag !== 'devd') {
    const line = String(p.msg ?? p.message ?? '');
    if (/NTP|天气|clock|settings|crash|异常|错误|E \(/.test(line)) console.log(`  [dev:${p.tag}] ${line}`);
    if (/NTP 对时成功/.test(line)) sawNtpOk = true;
    if (/天气更新/.test(line)) sawWeather = true;
  }
});

function rpc(method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = seq++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc ${method} 超时(${timeoutMs}ms)`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalJs = async (code, timeoutMs = 10000) => (await rpc('js.eval', { code }, timeoutMs)).result;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const heartbeat = async (label) => {
  const t0 = Date.now();
  const v = await evalJs(`1 + 1`);
  console.log(`  心跳[${label}]: ${v === '2' || v === 2 ? 'OK' : '异常:' + v} (${Date.now() - t0}ms)`);
};

async function pushClock() {
  const manifest = JSON.parse(readFileSync(`${CLOCK_DIR}/pixelbox.json`, 'utf8'));
  const body = readFileSync(`${CLOCK_DIR}/dist/main.js`);
  const sha = createHash('sha256').update(body).digest('hex');
  const { session } = await rpc('app.push_begin', {
    manifest, files: [{ path: 'main.js', size: body.length, sha256: sha }],
  });
  for (let off = 0; off < body.length; off += 4096) {
    await rpc('app.push_chunk', {
      session, path: 'main.js', offset: off,
      dataB64: body.subarray(off, Math.min(off + 4096, body.length)).toString('base64'),
    });
  }
  await rpc('app.push_end', { session });
  console.log('  推送完成: 像素时钟 v1.0.0');
}

ws.on('open', async () => {
  try {
    const h = await rpc('hello', {});
    console.log(`hello: app=${h.app} fw=${h.fw} heap=${h.heapFree}`);
    const sub = await rpc('logs.subscribe', { since: 0 });
    bootAtStart = sub.boot;
    console.log(`boot id = ${bootAtStart}`);

    // ---- A. 死锁回归: 连续 6 发 ntpSync (旧固件两发即死) ----
    console.log('\n[A] SNTP 死锁回归测试: 连发 6 次 ntpSync');
    for (let i = 0; i < 6; i++) {
      const srv = ['ntp.aliyun.com', 'pool.ntp.org', 'cn.pool.ntp.org'][i % 3];
      await evalJs(`void px.system.ntpSync('${srv}').catch(() => {}); 'kicked ${i}'`);
      await sleep(300);
      await heartbeat(`A${i}`);
    }

    // ---- B. 推送修好的 pixel-clock ----
    console.log('\n[B] 推送 02-pixel-clock (http 天气 + aliyun NTP 永续重试)');
    await pushClock();
    await sleep(4000);
    await heartbeat('B-推送后');

    // ---- C. UAF 回归: 在途异步 + 连续热重启 (等价键1/键2 切页) ----
    console.log('\n[C] VM 热重启轰炸: 时钟运行中 (NTP/fetch 在途) 连续 restart ×5');
    for (let i = 0; i < 5; i++) {
      await evalJs(`void px.system.ntpSync('10.255.255.1').catch(() => {}); void fetch('http://wttr.in/?format=%25t', {timeoutMs: 9000}).catch(() => {}); 'inflight'`);
      await rpc('app.restart', {});
      await sleep(1500);
      await heartbeat(`C${i}`);
    }
    console.log('  等 18s 让全部在途 15s 超时定时器打进新 VM...');
    await sleep(18000);
    await heartbeat('C-定时器到期后');

    // ---- D. 停机窗口: 在途定时器 + app.stop ----
    console.log('\n[D] 停机窗口测试: kick 15s 定时器 → stop → 等 17s → restart');
    await evalJs(`void px.system.ntpSync('10.255.255.1').catch(() => {}); 'kicked'`);
    await rpc('app.stop', {});
    await sleep(17000);
    const h2 = await rpc('hello', {});
    console.log(`  停机 17s 后 devd 存活: heap=${h2.heapFree}`);
    await rpc('app.restart', {});
    await sleep(3000);
    await heartbeat('D-重启后');

    // ---- E. 业务验证: NTP/天气/画面 ----
    console.log('\n[E] 业务验证 (等时钟对时+取天气, 最多 40s)');
    for (let i = 0; i < 20 && !(sawNtpOk && sawWeather); i++) await sleep(2000);
    console.log(`  NTP 对时成功日志: ${sawNtpOk ? '✓' : '✗ 未见'}`);
    console.log(`  天气更新日志:     ${sawWeather ? '✓' : '✗ 未见'}`);
    const px1 = await evalJs(
      `(() => { let lit = 0; for (let x = 40; x < 440; x += 8) { if ((px.screen.getPixel(x, 155) & 0xFFFFFF) > 0x101010) lit++; } return lit; })()`);
    console.log(`  画面抽查 (y=155 时钟数字行亮像素列): ${px1}/50 ${Number(px1) > 3 ? '✓ 非黑屏' : '✗ 疑似黑屏'}`);

    const sub2 = await rpc('logs.subscribe', { since: 0 });
    console.log(`\nboot id 前后: ${bootAtStart} → ${sub2.boot} ${sub2.boot === bootAtStart ? '✓ 全程零重启/零崩溃' : '✗ 设备曾重启!'}`);
    console.log('全部测试完成');
  } catch (e) {
    console.error('\n✗ 验收失败:', e.message);
    process.exitCode = 1;
  } finally {
    ws.removeAllListeners('close'); ws.close(); setTimeout(() => process.exit(), 500);
  }
});
