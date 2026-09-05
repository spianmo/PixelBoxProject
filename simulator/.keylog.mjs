import WebSocket from 'ws'
import { appendFileSync, writeFileSync } from 'node:fs'
const OUT = '/tmp/keylog.txt'
writeFileSync(OUT, '--- 按键日志监听开始 ' + new Date().toISOString() + ' ---\n')
const ws = new WebSocket('ws://192.168.1.202:8765/devd', { handshakeTimeout: 10000 })
let id = 1
ws.on('open', () => {
  ws.send(JSON.stringify({ id: id++, method: 'hello', params: {} }))
  ws.send(JSON.stringify({ id: id++, method: 'logs.subscribe', params: {} }))
  // 同时在 JS 层挂按键事件记录
  setTimeout(() => {
    ws.send(JSON.stringify({ id: id++, method: 'js.eval', params: { code:
      `globalThis.__k=[]; px.input.onButton(e=>{ globalThis.__k.push(e.id+':'+e.type); console.log('[keytest] '+e.id+' '+e.type); }); 'armed'` } }))
  }, 500)
  setTimeout(() => { ws.close(); process.exit(0) }, 90000)
})
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.event === 'log') {
    const l = m.data.tag + ': ' + m.data.msg
    if (/keytest|syskeys|px\.btn|button|设置|应用页|息屏|关机/.test(l)) appendFileSync(OUT, l + '\n')
  }
})
ws.on('error', (e) => { appendFileSync(OUT, 'WS err: ' + e.message + '\n'); process.exit(1) })
