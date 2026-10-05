/* 真实 JS 麦克风/record fragment：共享采集、跨帧重采样与退出回收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/prelude_mic.js', import.meta.url), 'utf8');
function fixture() {
  let available = true, active = false, busy = false, timerId = 0, failure = null, writeError = null;
  const calls = [], events = [], intervals = new Map(), files = new Map(), logs = [];
  const native = {
    micAvailable: () => available, micActive: () => active, micBusy: () => busy,
    micStart(rate, duration) {
      if (failure) throw failure;
      assert(!busy);
      /* 对齐真实 C 的会话初始化：旧队列不能靠 mock 保留到重启之后。 */
      events.length = 0;
      active = busy = true;
      calls.push(['start', rate, duration]);
    },
    micStop() { active = false; events.length = 0; calls.push(['stop']); },
    micSetGain(value) { calls.push(['gain', value]); },
    micPoll() { const next = events.shift(); if (next instanceof Error) throw next; return next ?? null; },
    fs: {writeBytes(path, bytes) { if (writeError) throw writeError; files.set(path, new Uint8Array(bytes)); }}
  };
  const px = {audio: {}};
  const exitHandlers = new Set();
  const hub = vm.runInNewContext(source + '\nmicHub;', {
    native, px, exitHandlers, Uint8Array, ArrayBuffer, DataView,
    u8: value => value instanceof Uint8Array ? value : new Uint8Array(value),
    console: {error: value => logs.push(String(value))},
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; },
    clearInterval: id => intervals.delete(id)
  });
  return {
    px, hub, calls, events, files, intervals, logs,
    set available(value) { available = value; }, set failure(value) { failure = value; },
    set writeError(value) { writeError = value; },
    get active() { return active; },
    cleaned() { busy = active = false; },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    frame(first = 0, count = 160) {
      const bytes = new Uint8Array(count * 2), view = new DataView(bytes.buffer);
      for (let i = 0; i < count; ++i) view.setInt16(i * 2, first + i, true);
      events.push({sampleRate: 16000, data: bytes.buffer});
      this.tick();
    },
    exit() { for (const callback of exitHandlers) callback(); }
  };
}

let passed = 0;
async function test(name, run) { await run(); ++passed; console.log('PASS ' + name); }

await test('worker 已退出的错误先交付，不能被自动重启清掉', () => {
  for (const name of ['EIO', 'ETIMEDOUT', 'EOVERFLOW']) {
    const f = fixture(), errors = [];
    f.hub.subscribe(() => {}, error => errors.push(error.message));
    f.cleaned(); f.events.push(new Error(name)); f.tick();
    assert.deepEqual(errors, [name]);
    assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
    assert.equal(f.intervals.size, 0); assert(!f.active);
  }
});

await test('界面阻塞 300ms 后一次轮询完整收取积压音频', () => {
  const f = fixture(), frames = [];
  f.px.audio.mic.start({frameMs: 10, onData: data => frames.push(new DataView(data).getInt16(0, true))});
  for (let i = 0; i < 30; ++i) {
    const samples = new Int16Array(160); samples.fill(i);
    f.events.push({sampleRate: 16000, data: samples.buffer});
  }
  f.tick();
  assert.deepEqual(frames, Array.from({length: 30}, (_, i) => i));
  assert.equal(f.events.length, 0); assert(f.active); f.exit();
});


await test('批量读取按音频时长让出轮询，公开MIC仍按请求的128ms拆帧', () => {
  const f=fixture(), frames=[];
  f.px.audio.mic.start({frameMs:128,onData:data=>frames.push(new Uint8Array(data))});
  for(let i=0;i<20;i++){
    const values=new Int16Array(1600);for(let j=0;j<1600;j++)values[j]=i*1600+j;
    f.events.push({sampleRate:16000,data:values.buffer});
  }
  f.tick();assert.equal(f.events.length,10);assert.equal(frames.length,7);
  f.tick();assert.equal(f.events.length,0);assert.equal(frames.length,15);
  const joined=Buffer.concat(frames.map(Buffer.from));assert.equal(joined.length,15*4096);
  for(let i=0;i<joined.length/2;i++)assert.equal(joined.readInt16LE(i*2),i);
  f.exit();
});

await test('内部语音订阅互不抢占，公开 MIC 修改帧不污染其他消费者', () => {
  const f = fixture(), a = [], b = [], errors = [];
  const stopA = f.hub.subscribe(bytes => { a.push(bytes[0]); bytes.fill(255); },error => errors.push(error));
  const stopB = f.hub.subscribe(bytes => b.push(bytes[0]),error => errors.push(error));
  f.px.audio.mic.start({frameMs:10,onData: bytes => new Uint8Array(bytes).fill(99)});
  f.frame(7); assert.deepEqual(a,[7]); assert.deepEqual(b,[7]);
  f.px.audio.mic.stop(); stopA(); f.frame(8); assert.deepEqual(a,[7]); assert.deepEqual(b,[7,8]);
  assert(f.active); stopB(); assert(!f.active); assert.equal(errors.length,0);
});
await test('内部订阅失败与退出仅通知一次并清理原生采集', () => {
  const f = fixture(), errors = [];
  f.hub.subscribe(() => {},error => errors.push(error.message));
  f.events.push(new Error('EOVERFLOW')); f.tick(); f.exit();
  assert.deepEqual(errors,['EOVERFLOW']); assert(!f.active); assert.equal(f.intervals.size,0);
});

await test('默认 32ms 帧、单声道符号和订阅停止', () => {
  const f = fixture(), frames = [];
  f.px.audio.mic.start({onData: data => frames.push(data)});
  assert.equal(f.px.audio.mic.active, true);
  assert.deepEqual(f.calls[0], ['start', 16000, 10]);
  for (let i = 0; i < 4; ++i) f.frame(-2000 + i * 160);
  assert.equal(frames.length, 1); assert.equal(frames[0].byteLength, 1024);
  const view = new DataView(frames[0]);
  for (let i = 0; i < 512; ++i) assert.equal(view.getInt16(i * 2, true), -2000 + i);
  f.px.audio.mic.stop(); assert.equal(f.px.audio.mic.active, false);
  assert.equal(f.intervals.size, 0); assert.equal(f.active, false);
});
await test('六种采样率的跨物理帧相位和完整输出帧', () => {
  for (const rate of [8000, 16000, 24000, 32000, 44100, 48000]) {
    const f = fixture(), frames = [];
    f.px.audio.mic.start({sampleRate: rate, frameMs: 10, onData: data => frames.push(data)});
    for (let i = 0; i < 4; ++i) f.frame(-12000 + i * 160);
    assert(frames.length >= 3);
    let outIndex = 0;
    for (const frame of frames) {
      assert.equal(frame.byteLength, rate / 100 * 2);
      const view = new DataView(frame);
      for (let i = 0; i < frame.byteLength / 2; ++i, ++outIndex) {
        const phase = outIndex * 16000, index = Math.floor(phase / rate), fraction = phase % rate;
        const expected = Math.trunc(((-12000 + index) * (rate - fraction) + (-11999 + index) * fraction) / rate);
        assert.equal(view.getInt16(i * 2, true), expected);
      }
    }
    f.exit();
  }
});
await test('重复 start 替换回调，stop 后等待 DMA 回收再启动', () => {
  const f = fixture(); let old = 0, current = 0;
  f.px.audio.mic.start({frameMs: 10, onData: () => ++old});
  f.px.audio.mic.start({frameMs: 10, onData: () => ++current});
  f.frame(); assert.equal(old, 0); assert.equal(current, 1);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  f.px.audio.mic.stop(); f.px.audio.mic.start({frameMs: 10, onData: () => ++current});
  f.tick(); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  f.cleaned(); f.tick(); assert.equal(f.calls.filter(call => call[0] === 'start').length, 2);
  f.frame(); assert.equal(current, 2); f.exit();
});
await test('用户回调异常与在回调内停止不会破坏采集状态', () => {
  const f = fixture();
  f.px.audio.mic.start({frameMs: 10, onData() { throw new Error('callback'); }});
  f.frame(); assert(f.logs.some(log => log.includes('callback'))); assert(f.px.audio.mic.active);
  let called = 0;
  f.px.audio.mic.start({frameMs: 10, onData() { ++called; f.px.audio.mic.stop(); }});
  f.frame(0, 500); assert.equal(called, 1); assert(!f.px.audio.mic.active);
});
await test('同率批量合帧支持奇数byteOffset且回调重订阅不重放旧物理帧', () => {
  const f=fixture(), old=[], current=[];
  f.px.audio.mic.start({sampleRate:16000,frameMs:10,onData(data){
    old.push(new Uint8Array(data));
    f.px.audio.mic.start({sampleRate:16000,frameMs:10,onData:next=>current.push(new Uint8Array(next))});
  }});
  const owner=new Uint8Array(1003).fill(0xa5), bytes=owner.subarray(1,1001);
  for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  f.events.push({sampleRate:16000,data:bytes});f.tick();
  assert.equal(old.length,1);assert.equal(current.length,0);
  assert.deepEqual(old[0],bytes.slice(0,320));assert.equal(owner[0],0xa5);assert.equal(owner[1001],0xa5);
  f.frame(99);assert.equal(current.length,1);assert.equal(new DataView(current[0].buffer).getInt16(0,true),99);
  old[0].fill(0);assert.equal(bytes[1],1);f.exit();
});
await test('同率record最后一块仅复制剩余样本，mic用户修改帧不影响WAV', async () => {
  const f=fixture();f.px.audio.mic.start({sampleRate:16000,frameMs:10,onData:data=>new Uint8Array(data).fill(255)});
  const recording=f.px.audio.record('/data/exact.wav',{sampleRate:16000,maxMs:101});
  for(let i=0;i<11;i++)f.frame(-500+i*160);
  assert.equal(await recording,101);
  const wav=f.files.get('/data/exact.wav'), view=new DataView(wav.buffer);
  assert.equal(wav.length,44+1616*2);
  for(let i=0;i<1616;i++)assert.equal(view.getInt16(44+i*2,true),-500+i);
  assert(f.active);f.exit();
});
await test('record 写真实 PCM16 WAV 并返回采样时长', async () => {
  const f = fixture(); const record = f.px.audio.record('/data/record.wav', {maxMs: 100});
  for (let i = 0; i < 11; ++i) f.frame(-800 + i * 160);
  assert.equal(await record, 100);
  const bytes = f.files.get('/data/record.wav'), view = new DataView(bytes.buffer);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(bytes.length, 3244); assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 3200);
  assert.equal(view.getInt16(44, true), -800); assert.equal(view.getInt16(bytes.length - 2, true), 799);
  assert.equal(f.active, false); assert.equal(f.intervals.size, 0);
});
await test('mic 与两个不同采样率 record 共享采集，stop 不打断录音', async () => {
  const f = fixture(); let frames = 0;
  f.px.audio.mic.start({frameMs: 10, onData: () => ++frames});
  const a = f.px.audio.record('/data/a.wav', {sampleRate: 8000, maxMs: 100});
  const b = f.px.audio.record('/data/b.wav', {sampleRate: 44100, maxMs: 100});
  f.frame(); f.px.audio.mic.stop(); assert(f.active);
  for (let i = 1; i < 12; ++i) f.frame(i * 160);
  assert.deepEqual(await Promise.all([a, b]), [100, 100]); assert.equal(frames, 1);
  assert.equal(f.files.get('/data/a.wav').length, 1644);
  assert.equal(f.files.get('/data/b.wav').length, 8864);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
});
await test('录音完成不停止仍有订阅的麦克风', async () => {
  const f = fixture(); let frames = 0;
  f.px.audio.mic.start({frameMs: 10, onData: () => ++frames});
  const result = f.px.audio.record('/data/a.wav', {maxMs: 100});
  for (let i = 0; i < 11; ++i) f.frame(i * 160);
  assert.equal(await result, 100); assert(f.px.audio.mic.active&&f.active);
  f.frame(); assert.equal(frames, 12); f.exit();
});
await test('硬件失败拒绝全部录音并清理定时器', async () => {
  const f = fixture();
  f.px.audio.mic.start({onData() {}});
  const result = f.px.audio.record('/data/fail.wav', {maxMs: 100});
  const check = assert.rejects(result, /ETIMEDOUT/);
  f.events.push(new Error('ETIMEDOUT')); f.tick(); await check;
  assert(!f.px.audio.mic.active); assert(!f.active); assert.equal(f.intervals.size, 0);
  assert.equal(f.files.size, 0);
});
await test('文件写入失败与 VM 退出按 Promise 报错', async () => {
  const f = fixture(); f.writeError = new Error('ENOSPC');
  const result = f.px.audio.record('/data/fail.wav', {maxMs: 100});
  const check = assert.rejects(result, /ENOSPC/);
  for (let i = 0; i < 11; ++i) f.frame(); await check;
  f.cleaned(); f.writeError = null;
  const pending = f.px.audio.record('/data/cancel.wav');
  const cancelled = assert.rejects(pending, /ECANCELED/); f.exit(); await cancelled;
  assert.equal(f.files.size, 0); assert.equal(f.intervals.size, 0);
});
await test('路径、采样率、帧时长和不支持平台检查', async () => {
  const f = fixture();
  assert.throws(() => f.px.audio.mic.start({onData() {}, sampleRate: 11025}), /EINVAL/);
  assert.throws(() => f.px.audio.mic.start({}), /onData/);
  assert.throws(() => f.px.audio.mic.setGain(NaN), /EINVAL/);
  for (const path of ['/app/no.wav', '/data/../no.wav', '/data/x/./y.wav', '/data/no\0.wav'])
    await assert.rejects(f.px.audio.record(path), /path/);
  await assert.rejects(f.px.audio.record('/data/a.wav', {sampleRate: 1}), /EINVAL/);
  f.px.audio.mic.start({frameMs: 1, onData(data) { assert.equal(data.byteLength, 320); }});
  f.frame(); f.exit();
  const no = fixture(); no.available = false;
  assert.throws(() => no.px.audio.mic.start({onData() {}}), /ENOTSUP/);
  await assert.rejects(no.px.audio.record('/data/a.wav'), /ENOTSUP/);
});
console.log(`${passed} microphone contract tests passed`);
