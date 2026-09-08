import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/renderer/src/device-sim/sandbox/runtime/speech.ts'],
  bundle: true, format: 'esm', platform: 'node', write: false })
const { SpeechImpl, pcmWav } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const response = (data, status = 200) => ({ status, body: typeof data === 'string' ? new TextEncoder().encode(data).buffer : data })
function harness(fetcher = async () => response('{"RecognitionStatus":"Success","DisplayText":"1.5 加 2"}')) {
  const calls = [], events = new Map()
  let consume, stops = 0
  const link = {
    on: (name, cb) => { events.set(name, cb); return () => events.delete(name) },
    call: async (name, params) => {
      calls.push({ name, params })
      if (name === 'fetch') return fetcher(params)
      if (name === 'player.stream.open') return { id: 7 }
      return undefined
    }
  }
  const mic = { start: (_rate, _ms, cb) => { consume = cb; return { stop: () => { stops++; consume = null } } } }
  const speech = new SpeechImpl(link, mic)
  speech.configure({ region: 'eastasia', key: 'test-key' })
  const frame = (amplitude) => consume?.(new Int16Array(512).fill(amplitude).buffer)
  return { speech, calls, events, frame, stops: () => stops }
}

const wav = pcmWav(new Uint8Array([1, 2, 3, 4]))
assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF')
assert.equal(new DataView(wav).getUint32(24, true), 16000)
assert.equal(new DataView(wav).getUint32(40, true), 4)
console.log('[OK] PCM16LE WAV 声道、采样率和长度')

{
  const h = harness()
  await assert.rejects(h.speech.wakeword.start({ phrase: '你好小川', pinyin: 'ni hao xiao chuan', threshold: 0.30, onWake() {} }), /ENOTSUP/)
  assert.equal(h.calls.length, 0)
  const result = h.speech.recognize({ silenceMs: 300 })
  assert.equal(h.calls.length, 0)
  for (let i = 0; i < 4; i++) h.frame(2000)
  for (let i = 0; i < 10; i++) h.frame(0)
  assert.equal(await result, '1.5 加 2')
  const request = h.calls.find(c => c.name === 'fetch').params
  assert.equal(request.redirect, 'error')
  assert.equal(request.headers['Ocp-Apim-Subscription-Key'], 'test-key')
  assert(!request.url.includes('test-key'))
  assert(h.stops() > 0)
  h.speech.dispose()
  console.log('[OK] 本地 VAD 截断后才请求 Azure；桌面唤醒不冒充 ESP-SR')
}
{
  const h = harness()
  const result = h.speech.recognize({ maxMs: 1000 })
  for (let i = 0; i < 32; i++) h.frame(0)
  await assert.rejects(result, /未检测到语音/)
  assert.equal(h.calls.length, 0)
  h.speech.dispose()
  console.log('[OK] 纯静音不上传 Azure')
}
{
  let resolveHttp
  const h = harness(() => new Promise(resolve => { resolveHttp = resolve }))
  const result = h.speech.recognize({ silenceMs: 300 })
  for (let i = 0; i < 4; i++) h.frame(2000)
  for (let i = 0; i < 10; i++) h.frame(0)
  await flush()
  h.speech.cancel()
  await assert.rejects(result, /已取消/)
  resolveHttp(response('{"RecognitionStatus":"Success","DisplayText":"旧结果"}'))
  await flush()
  assert.equal(h.calls.length, 1)
  h.speech.dispose()
  console.log('[OK] 识别在途取消立即完成，迟到响应不产生后续操作')
}
{
  const h = harness(async () => response(new Int16Array(1600).buffer))
  let finished = false
  const result = h.speech.speak('a < b & "c"').then(() => { finished = true })
  await flush()
  assert.equal(finished, false)
  const request = h.calls.find(c => c.name === 'fetch').params
  assert(request.bodyText.includes('a &lt; b &amp; &quot;c&quot;'))
  assert.equal(request.redirect, 'error')
  assert(h.calls.some(c => c.name === 'player.stream.end'))
  h.events.get('player-ended')({ id: 6 })
  await flush()
  assert.equal(finished, false)
  h.events.get('player-ended')({ id: 7 })
  await result
  h.speech.dispose()
  console.log('[OK] SSML 转义且等待对应播放器实际结束')
}
{
  const h = harness(async () => response(new Int16Array(1600).buffer))
  const result = h.speech.speak('取消播报')
  await flush()
  h.speech.cancel()
  await assert.rejects(result, /已取消/)
  assert(h.calls.some(c => c.name === 'player.ctl' && c.params.op === 'stop'))
  h.speech.dispose()
  console.log('[OK] 播报取消停止实际播放并拒绝 Promise')
}
{
  const net = await build({ entryPoints: ['src/renderer/src/device-sim/sandbox/runtime/net.ts'],
    bundle: true, format: 'esm', platform: 'node', write: false })
  const { createFetch } = await import(`data:text/javascript;base64,${Buffer.from(net.outputFiles[0].text).toString('base64')}`)
  let sent
  const fetch = createFetch({ call: async (_method, params) => { sent = params; return response('{}') } })
  await fetch('https://example.invalid/login', { redirect: 'error' })
  assert.equal(sent.redirect, 'error')
  await assert.rejects(fetch('https://example.invalid', { redirect: 'unsafe' }), /redirect/)
  console.log('[OK] fetch 桥保留拒绝重定向选项并拒绝无效值')
}
console.log('Speech 模拟器检查通过：7 项（无外部网络请求）')
