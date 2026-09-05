/**
 * probe-jsperf.mjs — 逐操作测设备上 JS 解释器的单次成本
 *
 * 目的: 4096 次循环耗 2.1s (≈520us/次) 明显不正常。分别测空循环、
 * charAt/charCodeAt、parseInt、正则 test、正则字面量、对象分配,
 * 定位是"所有 JS 都慢"还是某个内建/分配路径慢。
 *
 * 用法: node probe-jsperf.mjs [ip]
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
    setTimeout(() => { if (pending.delete(myId)) reject(new Error(`${method} 超时`)) }, 120000)
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

/** [名字, 循环次数, 循环体] —— 循环体里 s 是单字符串, i 是下标 */
const OPS = [
  ['空循环 (基线)', 200000, 'sink += i;'],
  ['s.charCodeAt(i & 4095)', 200000, 'sink += str.charCodeAt(i & 4095);'],
  ['s.charAt(i & 4095)  (分配 1 字符串)', 200000, 'sink += str.charAt(i & 4095).length;'],
  ['s[i & 4095]        (分配 1 字符串)', 200000, 'sink += str[i & 4095].length;'],
  ['parseInt("a", 36)', 200000, 'sink += parseInt(CH, 36);'],
  ['+CH  (数字快转换对照)', 200000, 'sink += (CH === "." ? 0 : 1);'],
  ['RE.test(CH)  (预编译正则)', 200000, 'sink += RE.test(CH) ? 1 : 0;'],
  ['/^[0-9a-z]$/.test(CH)  (字面量正则)', 200000, 'sink += /^[0-9a-z]$/.test(CH) ? 1 : 0;'],
  ['{} 对象分配', 200000, 'sink += ({ a: i }).a;'],
  ['[] 数组分配', 200000, 'sink += [i].length;'],
  ['字符串拼接 (2 字符)', 200000, 'sink += ("a" + i).length;'],
  ['空函数调用', 200000, 'sink += nop(i);'],
]

const HARNESS = (n, body) => `
  const str = '0123456789abcdef'.repeat(256);
  const CH = 'a';
  const RE = /^[0-9a-z]$/;
  const nop = (x) => x;
  let sink = 0;
  // 预热一轮小循环, 排除首次 IC/形状建立成本
  for (let i = 0; i < 1000; i++) { ${body} }
  sink = 0;
  const t0 = Date.now();
  for (let i = 0; i < ${n}; i++) { ${body} }
  const dt = Date.now() - t0;
  return JSON.stringify({ dt: dt, n: ${n}, sink: sink });
`

ws.on('open', async () => {
  try {
    await call('hello')
    const mem = await call('js.eval', {
      code: `(() => { return JSON.stringify({ heapFree: px.system.memory ? px.system.memory() : null }) })()`,
    }).catch(() => null)
    if (mem?.result) console.log('内存:', mem.result)

    console.log('\n操作'.padEnd(44), '总耗时'.padStart(9), '单次'.padStart(11), '相对基线')
    console.log('-'.repeat(86))
    let base = null
    for (const [name, n, body] of OPS) {
      let dt = null
      try {
        const r = await call('js.eval', { code: `(() => {${HARNESS(n, body)}})()` })
        const o = JSON.parse(r.result)
        dt = o.dt
      } catch (e) {
        console.log(name.padEnd(44), 'ERR ' + e.message)
        continue
      }
      const per = (dt * 1e6) / n // ns
      if (base == null) base = per
      const rel = base > 0 ? (per / base).toFixed(1) + '×' : '-'
      console.log(
        name.padEnd(44),
        (dt + 'ms').padStart(9),
        (per.toFixed(0) + 'ns').padStart(11),
        rel.padStart(8),
      )
    }
    ws.close()
    process.exit(0)
  } catch (e) {
    console.error('失败:', e.message)
    process.exit(1)
  }
})
