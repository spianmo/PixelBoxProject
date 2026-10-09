#!/usr/bin/env node
// 真实 WebSocket 帧顺序回归：订阅响应后的同批回放不能被静默窗口吞掉。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { once } from 'node:events'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const handlers = new Map()
const emitted = []
const electron = {
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel, payload) => emitted.push({ channel, payload }) } }] }
}
const bundle = await build({
  entryPoints: [join(root, 'src/main/devd.ts')], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent'
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: name => name === 'electron' ? electron : require(name),
  Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval
})
const devd = module.exports
devd.registerDevdIpc()

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await once(server, 'listening')
let subscriptions = 0
server.on('connection', socket => socket.on('message', raw => {
  const { id, method } = JSON.parse(String(raw))
  if (method !== 'logs.subscribe') return
  subscriptions++
  const log = (seq, msg) => socket.send(JSON.stringify({ event: 'log', data: { seq, level: 'info', tag: 'app', msg, ts: seq } }))
  if (subscriptions === 2) log(3, 'stale-before-response')
  socket.send(JSON.stringify({ id, result: { ok: true, last_seq: 2, boot: 1 } }))
  log(1, 'history-1')
  log(2, 'history-2')
}))

async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('日志回放等待超时')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const rows = () => emitted.filter(e => e.channel === 'devd:log').flatMap(e => e.payload).map(row => row.msg)
try {
  const opts = { key: '127.0.0.1:test', host: '127.0.0.1', port: server.address().port }
  handlers.get('devd:logs-subscribe')(null, opts)
  await until(() => rows().includes('history-2'))
  emitted.length = 0
  handlers.get('devd:logs-subscribe')(null, opts)
  await until(() => subscriptions === 2 && rows().includes('history-2'))
  assert.deepEqual(rows().filter(msg => msg.startsWith('history-')), ['history-1', 'history-2'])
  assert.ok(!rows().includes('stale-before-response'))
  assert.ok(emitted.some(e => e.channel === 'devd:log-reset'))
  console.log('[OK] 重订阅响应与历史事件连续到达时，IDE 保留完整回放并丢弃旧实时帧')
  handlers.get('devd:logs-unsubscribe')(null, { key: opts.key })
} finally {
  devd.disposeDevd()
  for (const socket of server.clients) socket.terminate()
  await new Promise(resolve => server.close(resolve))
}
