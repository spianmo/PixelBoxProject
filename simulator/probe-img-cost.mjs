/**
 * probe-img-cost.mjs — 拆 px.screen.drawImage(path) 的耗时构成
 *
 * 结论 (真机 480x480 PNG, 408174 字节):
 *   fs.readBytes  = 152ms   (LittleFS ~2.7MB/s)
 *   PNG 解码+绘制 = 861ms   ← 切回应用页剩余延迟的主要来源
 *   合计         = 965ms   (重复调用不变: 固件不缓存已解码图)
 *
 * 用法: node probe-img-cost.mjs [ip]
 */
import WebSocket from 'ws'
const ip = process.argv[2] ?? '192.168.1.202'
const ws = new WebSocket(`ws://${ip}:8765/devd`, { handshakeTimeout: 10000 })
let id = 1; const pending = new Map()
const call = (method, params = {}) => new Promise((res, rej) => {
  const myId = id++; pending.set(myId, { res, rej })
  ws.send(JSON.stringify({ id: myId, method, params }))
  setTimeout(() => { if (pending.delete(myId)) rej(new Error('超时')) }, 120000)
})
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.event) return
  const p = pending.get(m.id); if (!p) return; pending.delete(m.id)
  m.error ? p.rej(new Error(m.error.message ?? JSON.stringify(m.error))) : p.res(m.result) })
ws.on('error', (e) => { console.error('WS:', e.message); process.exit(1) })
ws.on('open', async () => {
  await call('hello')
  const code = `(() => {
    const m = px.storage.kv.getJSON('perler.media');
    const path = '/data/perler-' + m.slot + '.bin';
    const out = { size: m.size, w: m.width, h: m.height };
    let a = Date.now(); const buf = px.storage.fs.readBytes(path); out.readMs = Date.now() - a;
    out.readBytes = buf.byteLength;
    a = Date.now(); px.screen.drawImage(buf, 0, 0, { w: 480, h: 480 }); out.decodeDrawMs = Date.now() - a;
    a = Date.now(); px.screen.drawImage(path, 0, 0, { w: 480, h: 480 }); out.pathTotalMs = Date.now() - a;
    a = Date.now(); px.screen.drawImage(path, 0, 0, { w: 480, h: 480 }); out.pathTotal2Ms = Date.now() - a;
    a = Date.now(); px.screen.clear(0); out.clearMs = Date.now() - a;
    const head = new Uint8Array(buf.slice(0, 4));
    out.magic = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return JSON.stringify(out);
  })()`
  try { console.log(JSON.parse((await call('js.eval', { code })).result)) }
  catch (e) { console.error('失败:', e.message) }
  ws.close(); process.exit(0)
})
import WebSocket from 'ws'
const ip = process.argv[2] ?? '192.168.1.202'
const ws = new WebSocket(`ws://${ip}:8765/devd`, { handshakeTimeout: 10000 })
let id = 1; const pending = new Map()
const call = (method, params = {}) => new Promise((res, rej) => {
  const myId = id++; pending.set(myId, { res, rej })
  ws.send(JSON.stringify({ id: myId, method, params }))
  setTimeout(() => { if (pending.delete(myId)) rej(new Error('超时')) }, 120000)
})
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.event) return
  const p = pending.get(m.id); if (!p) return; pending.delete(m.id)
  m.error ? p.rej(new Error(m.error.message ?? JSON.stringify(m.error))) : p.res(m.result) })
ws.on('error', (e) => { console.error('WS:', e.message); process.exit(1) })
ws.on('open', async () => {
  await call('hello')
  const code = `(() => {
    const m = px.storage.kv.getJSON('perler.media');
    const path = '/data/perler-' + m.slot + '.bin';
    const out = { size: m.size, w: m.width, h: m.height };
    let a = Date.now(); const buf = px.storage.fs.readBytes(path); out.readMs = Date.now() - a;
    out.readBytes = buf.byteLength;
    a = Date.now(); px.screen.drawImage(buf, 0, 0, { w: 480, h: 480 }); out.decodeDrawMs = Date.now() - a;
    a = Date.now(); px.screen.drawImage(path, 0, 0, { w: 480, h: 480 }); out.pathTotalMs = Date.now() - a;
    a = Date.now(); px.screen.drawImage(path, 0, 0, { w: 480, h: 480 }); out.pathTotal2Ms = Date.now() - a;
    a = Date.now(); px.screen.clear(0); out.clearMs = Date.now() - a;
    const head = new Uint8Array(buf.slice(0, 4));
    out.magic = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return JSON.stringify(out);
  })()`
  try { console.log(JSON.parse((await call('js.eval', { code })).result)) }
  catch (e) { console.error('失败:', e.message) }
  ws.close(); process.exit(0)
})
