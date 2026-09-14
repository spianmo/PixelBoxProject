/** 验证整次求值预算、取消、清理及取消前不启动任务。 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
const { outputFiles } = await build({ entryPoints: [new URL('../src/shared/hardwareEvaluation.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' })
const { evaluateWithDeadline } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let stopped = 0
const stop = () => stopped++
const signal = new AbortController().signal
assert.equal(await evaluateWithDeadline(async () => 42, stop, signal, 20), 42)
await sleep(30)
assert.equal(stopped, 0)
await assert.rejects(evaluateWithDeadline(() => new Promise(() => {}), stop, signal, 10), /evalTimeout/)
assert.equal(stopped, 1)
const cancelled = new AbortController()
const pending = evaluateWithDeadline(() => new Promise(() => {}), stop, cancelled.signal, 30)
cancelled.abort()
await assert.rejects(pending, /evalCancelled/)
await sleep(40)
assert.equal(stopped, 2)
let started = false
await assert.rejects(evaluateWithDeadline(async () => { started = true }, stop, cancelled.signal, 10), /evalCancelled/)
assert.equal(started, false)
await assert.rejects(evaluateWithDeadline(async () => { throw new Error('syntax') }, stop, signal, 10), /syntax/)
await sleep(20)
assert.equal(stopped, 3)
console.log('PASS: 成功清理、总预算截止、主动取消、预取消、失败清理')
