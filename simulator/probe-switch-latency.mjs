/**
 * probe-switch-latency.mjs — 定位「设置页 → 应用页」切换 6~7s 的耗时归属
 *
 * 用法:
 *   node probe-switch-latency.mjs [ip] [--restart] [--watch=秒]
 *
 *   --restart  自动发 app.restart(复现 teardown(app)+boot(app), 不需要按键)
 *   --watch=N  只被动监听 N 秒, 期间由人按键1/键2, 用来看真实切换时间线
 *
 * 输出: 按设备侧 ts(ms) 排出时间线, 每行带相邻间隔 Δ, 大间隔标 ★。
 */
import WebSocket from 'ws'

const ip = process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? '192.168.1.202'
const doRestart = process.argv.includes('--restart')
const watchArg = process.argv.find((a) => a.startsWith('--watch='))
const watchSec = watchArg ? Number(watchArg.split('=')[1]) : (doRestart ? 25 : 60)

const ws = new WebSocket(`ws://${ip}:8765/devd`, { handshakeTimeout: 10000 })
let id = 1
const pending = new Map()
const logs = []

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const myId = id++
    pending.set(myId, { resolve, reject })
    ws.send(JSON.stringify({ id: myId, method, params }))
    setTimeout(() => {
      if (pending.delete(myId)) reject(new Error(`${method} 超时`))
    }, 30000)
  })
}

/** 在设备 VM 里跑一段代码并取回结果 */
async function evalJs(code) {
  const r = await call('js.eval', { code })
  return r
}

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.event === 'log') {
    logs.push(m.data)
    return
  }
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) reject(new Error(m.error.message ?? JSON.stringify(m.error)))
    else resolve(m.result)
  }
})

ws.on('error', (e) => {
  console.error('WS 错误:', e.message)
  process.exit(1)
})

function printTimeline(title, since) {
  const rows = logs.filter((l) => l.ts >= since).sort((a, b) => a.seq - b.seq)
  console.log(`\n===== ${title} (${rows.length} 行) =====`)
  let prev = null
  for (const l of rows) {
    const d = prev == null ? 0 : l.ts - prev
    prev = l.ts
    const mark = d >= 300 ? ' ★' : ''
    console.log(`${String(l.ts).padStart(10)}  +${String(d).padStart(5)}ms  ${l.level[0]} ${l.tag.padEnd(12)} ${l.msg}${mark}`)
  }
}

ws.on('open', async () => {
  try {
    const hello = await call('hello')
    console.log('已连接:', JSON.stringify(hello))
    await call('logs.subscribe')

    // ---- 1. 微基准: 应用启动里那几个可疑的同步调用各花多久 ----
    console.log('\n----- 微基准 (在当前 VM 内直接计时) -----')
    const bench = await evalJs(`(() => {
      const out = {};
      const t = () => Date.now();
      let a = t();
      try { const s = px.net.listenTcp({ port: 8099, onConnection(){} }); out.listenTcp = t() - a;
            a = t(); s.close(); out.serverClose = t() - a; }
      catch (e) { out.listenTcp = 'ERR ' + String(e); }
      a = t();
      try { const stop = px.net.mdns.advertise({ name: 'probe', service: '_probe._tcp', port: 8099, txt: { k: 'v' } });
            out.mdnsAdvertise = t() - a;
            a = t(); stop(); out.mdnsRemove = t() - a; }
      catch (e) { out.mdnsAdvertise = 'ERR ' + String(e); }
      a = t(); px.wifi.status(); out.wifiStatus = t() - a;
      a = t(); try { px.net.hostname() } catch(e){}; out.hostname = t() - a;
      a = t(); try { px.storage.kv.get('probe.none') } catch(e){}; out.kvGet = t() - a;
      a = t(); try { px.storage.fs.stat('/data/perler-0.bin') } catch(e){}; out.fsStat = t() - a;
      return JSON.stringify(out);
    })()`)
    console.log(bench?.value ?? JSON.stringify(bench))

    const t0 = Date.now()
    if (doRestart) {
      console.log('\n----- 发 app.restart (= teardown(app) + boot(app)) -----')
      await call('app.restart')
    } else {
      console.log(`\n----- 被动监听 ${watchSec}s: 请现在按键1 进设置页, 停 3 秒, 再按键2 回应用 -----`)
    }

    setTimeout(() => {
      printTimeline(doRestart ? 'app.restart 时间线' : '按键切换时间线', 0)
      // 汇总最大间隔
      const rows = logs.slice().sort((a, b) => a.seq - b.seq)
      let worst = []
      for (let i = 1; i < rows.length; i++) {
        worst.push({ d: rows[i].ts - rows[i - 1].ts, from: rows[i - 1], to: rows[i] })
      }
      worst.sort((a, b) => b.d - a.d)
      console.log('\n===== 最大间隔 Top 8 =====')
      for (const w of worst.slice(0, 8)) {
        console.log(`${String(w.d).padStart(6)}ms  「${w.from.tag}: ${w.from.msg}」 → 「${w.to.tag}: ${w.to.msg}」`)
      }
      ws.close()
      process.exit(0)
    }, watchSec * 1000)
  } catch (e) {
    console.error('失败:', e.message)
    process.exit(1)
  }
})
