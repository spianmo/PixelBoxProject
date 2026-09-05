/**
 * probe-perler-boot.mjs — 拆解电子拼豆启动那 2.9s 花在哪
 *
 * 在设备当前 VM 里逐段计时:
 *   1. NVS 读取 (getJSON pattern / media / mode)
 *   2. parsePatternPayload 的逐豆校验循环 (64x64 = 4096 次, 循环里带正则)
 *   3. 首帧 drawImage 解码 (400KB 480x480 图)
 *   4. 一段 ~17KB 源码的 eval 编译耗时 (对照组: 入口脚本本身的编译成本)
 */
import WebSocket from 'ws'

const ip = process.argv[2] ?? '192.168.1.202'
const ws = new WebSocket(`ws://${ip}:8765/devd`, { handshakeTimeout: 10000 })
let id = 1
const pending = new Map()

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const myId = id++
    pending.set(myId, { resolve, reject })
    ws.send(JSON.stringify({ id: myId, method, params }))
    setTimeout(() => { if (pending.delete(myId)) reject(new Error(`${method} 超时`)) }, 60000)
  })
}

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.event) return
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) reject(new Error(m.error.message ?? JSON.stringify(m.error)))
    else resolve(m.result)
  }
})
ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1) })

const STEPS = [
  ['NVS getJSON perler.pattern', `
    const a = Date.now(); const p = px.storage.kv.getJSON('perler.pattern');
    return (JSON.stringify({ ms: Date.now() - a, note: p ? (p.cols + 'x' + p.rows + ', pixels=' + p.pixels.length + ', palette=' + p.palette.length) : 'null' }))`],

  ['NVS getJSON perler.media', `
    const a = Date.now(); const m = px.storage.kv.getJSON('perler.media');
    return (JSON.stringify({ ms: Date.now() - a, note: m ? ('slot=' + m.slot + ' size=' + m.size + ' kind=' + m.kind) : 'null' }))`],

  ['逐豆校验循环 (原实现: 循环内正则字面量)', `
    const p = px.storage.kv.getJSON('perler.pattern');
    const a = Date.now();
    let bad = 0;
    for (let i = 0; i < p.pixels.length; i++) {
      const symbol = p.pixels.charAt(i);
      if (symbol === '.') continue;
      if (!/^[0-9a-z]$/.test(symbol)) { bad++; continue }
      const idx = parseInt(symbol, 36);
      if (idx >= p.palette.length) bad++;
    }
    return (JSON.stringify({ ms: Date.now() - a, note: p.pixels.length + ' 豆位, 非法 ' + bad }))`],

  ['逐豆校验循环 (对照: 正则提到循环外)', `
    const p = px.storage.kv.getJSON('perler.pattern');
    const RE = /^[0-9a-z]$/;
    const a = Date.now();
    let bad = 0;
    for (let i = 0; i < p.pixels.length; i++) {
      const symbol = p.pixels.charAt(i);
      if (symbol === '.') continue;
      if (!RE.test(symbol)) { bad++; continue }
      const idx = parseInt(symbol, 36);
      if (idx >= p.palette.length) bad++;
    }
    return (JSON.stringify({ ms: Date.now() - a, note: '同样 ' + p.pixels.length + ' 豆位' }))`],

  ['逐豆校验循环 (对照: 查表法, 无正则无 parseInt)', `
    const p = px.storage.kv.getJSON('perler.pattern');
    const a = Date.now();
    let bad = 0;
    const n = p.palette.length;
    for (let i = 0; i < p.pixels.length; i++) {
      const c = p.pixels.charCodeAt(i);
      if (c === 46) continue;
      const idx = c >= 48 && c <= 57 ? c - 48 : (c >= 97 && c <= 122 ? c - 87 : -1);
      if (idx < 0 || idx >= n) bad++;
    }
    return (JSON.stringify({ ms: Date.now() - a, note: '同样 ' + p.pixels.length + ' 豆位' }))`],

  ['color 映射 palette.map(colorFromHex)', `
    const p = px.storage.kv.getJSON('perler.pattern');
    const a = Date.now();
    for (let k = 0; k < 100; k++) p.palette.map((h) => parseInt(h.slice(1), 16));
    return (JSON.stringify({ ms: (Date.now() - a) / 100, note: '单次(100 次平均)' }))`],

  ['首帧 drawImage 解码 (媒体图)', `
    const m = px.storage.kv.getJSON('perler.media');
    if (!m) throw new Error('无媒体');
    const path = '/data/perler-' + m.slot + '.bin';
    const a = Date.now(); px.screen.drawImage(path, 0, 0, { w: 480, h: 480 });
    return (JSON.stringify({ ms: Date.now() - a, note: path + ' (' + m.size + ' 字节)' }))`],

  ['drawPattern 全网格 fillRect (64x64)', `
    const p = px.storage.kv.getJSON('perler.pattern');
    const colors = p.palette.map((h) => parseInt(h.slice(1), 16));
    const cell = Math.max(1, Math.floor(Math.min(480 / p.cols, 480 / p.rows)));
    const a = Date.now();
    for (let row = 0; row < p.rows; row++) {
      for (let col = 0; col < p.cols; col++) {
        const s = p.pixels.charAt(row * p.cols + col);
        if (s === '.') continue;
        px.screen.fillRect(col * cell, row * cell, cell, cell, colors[parseInt(s, 36)]);
      }
    }
    return (JSON.stringify({ ms: Date.now() - a, note: p.cols + 'x' + p.rows + ' 格' }))`],

  ['eval 编译 ~17KB 源码 (入口编译成本对照)', `
    let src = '';
    for (let i = 0; i < 300; i++) src += 'function __p' + i + '(a, b) { const c = a + b * ' + i + '; return c > 0 ? c : -c; }\\n';
    const a = Date.now(); eval(src);
    return (JSON.stringify({ ms: Date.now() - a, note: src.length + ' 字节源码' }))`],
]

ws.on('open', async () => {
  try {
    await call('hello')
    console.log('步骤'.padEnd(46), '耗时', '  说明')
    console.log('-'.repeat(100))
    for (const [name, code] of STEPS) {
      let out
      try {
        const r = await call('js.eval', { code: `(() => { ${code} })()` })
        out = r?.result ?? JSON.stringify(r)
      } catch (e) {
        out = 'ERR ' + e.message
      }
      let ms = '?', note = String(out)
      try {
        const o = typeof out === 'string' ? JSON.parse(out) : out
        if (o && o.ms != null) { ms = String(o.ms); note = o.note ?? '' }
      } catch { /* 保留原文 */ }
      console.log(name.padEnd(46), (ms + 'ms').padStart(8), ' ', note)
    }
    ws.close()
    process.exit(0)
  } catch (e) {
    console.error('失败:', e.message)
    process.exit(1)
  }
})
