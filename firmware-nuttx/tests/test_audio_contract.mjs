/* 直接执行真实 prelude_audio.js，检验公开句柄和主线程完成事件。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/prelude_audio.js', import.meta.url), 'utf8');
function fixture(options = {}) {
  let nextId = 0, current = null, ready = true, volume = 70, shutDown = false;
  const completed = [], calls = [], logs = [], intervals = new Map(), timeouts = new Map();
  const files = new Map();
  let timerId = 0;
  const finish = (error = 0, code = '') => {
    assert(current);
    completed.push({jobId: current.id, error, code});
    current = null;
  };
  const start = data => {
    if (current) throw new Error('EBUSY');
    current = {...data, id: ++nextId, paused: false};
    calls.push(current);
    return current.id;
  };
  const get = id => { assert.equal(current?.id, id); return current; };
  const native = {
    audioAvailable: () => ready,
    audioSetVolume: v => { volume = Math.max(0, Math.min(100, Math.trunc(v))); },
    audioGetVolume: () => volume,
    audioTone: (frequency, duration, amplitude) => start({frequency, duration, amplitude}),
    audioPlayPcm: (data, rate, channels) => start({data: new Uint8Array(data), rate, channels}),
    audioPlayEncoded: data => start({data: new Uint8Array(data), encoded: true}),
    audioStreamOpen: (rate, channels) => start({rate, channels, feed: [], buffered: 0}),
    audioStreamFeed(id, data) {
      const job = get(id);
      if (job.buffered + data.length > 65536) throw new Error('EAGAIN');
      job.buffered += data.length;
      job.feed.push(new Uint8Array(data));
    },
    audioStreamEnd: id => { get(id).eos = true; },
    audioBuffered: id => get(id).buffered / (get(id).rate * get(id).channels * 2) * 1000,
    audioPause: (id, paused) => { get(id).paused = paused; },
    audioPlaying: id => Boolean(current && (!id || current.id === id) && !current.paused),
    audioStop: id => { get(id); finish(-125, 'ECANCELED'); },
    audioStopAll: () => { if (current) finish(-125, 'ECANCELED'); },
    audioPoll: () => completed.shift() ?? null,
    audioShutdown: () => { shutDown = true; current = null; },
    fs: {readBytes(path) {
      if (!path.startsWith('/app/') && !path.startsWith('/data/')) throw new Error('EINVAL');
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path).slice();
    }}
  };
  const px = {audio: {player: {play: () => Promise.reject(new Error('ENOTSUP')), playing: false}, encodeImaAdpcm() {}}};
  const exitHandlers = new Set();
  const internal = vm.runInNewContext(source + '\naudioInternal;', {
    native, px, exitHandlers,
    fetch: options.fetch,
    u8: data => {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      throw new TypeError('expected ArrayBuffer or Uint8Array');
    },
    console: {error: error => logs.push(String(error))},
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: callback => { timeouts.set(++timerId, callback); return timerId; }
  });
  return {
    px, internal, calls, logs, finish, intervals, timeouts, files,
    started() { assert(current); completed.push({jobId: current.id, error: 0, started: true}); },
    set ready(value) { ready = value; },
    get current() { return current; },
    get shutDown() { return shutDown; },
    tick() { for (const fn of [...intervals.values()]) fn(); },
    microtask() { for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); } },
    exit() { for (const fn of exitHandlers) fn(); }
  };
}

let passed = 0;
function test(name, run) { run(); ++passed; console.log('PASS ' + name); }

test('tone 默认参数、音量和 busy', () => {
  const f = fixture();
  assert.equal(f.px.audio.player.tone(), undefined);
  assert.equal(f.calls[0].frequency, 440);
  assert.equal(f.calls[0].duration, 200);
  assert.equal(f.calls[0].amplitude, 80);
  assert.equal(f.px.audio.player.playing, true);
  assert.throws(() => f.px.audio.player.tone(), /EBUSY/);
  f.px.audio.setVolume(120); assert.equal(f.px.audio.getVolume(), 100);
  f.finish(); f.tick();
  assert.equal(f.px.audio.player.playing, false);
  assert.equal(f.intervals.size, 0);
});

test('PCM 视图偏移、暂停/恢复及一次结束事件', () => {
  const f = fixture();
  const backing = new Uint8Array([99, 98, 1, 2, 3, 4, 97]);
  const handle = f.px.audio.player.playPcm(backing.subarray(2, 6), {channels: 2, sampleRate: 48000});
  assert.deepEqual([...f.calls[0].data], [1, 2, 3, 4]);
  assert.equal(f.calls[0].channels, 2);
  handle.pause(); assert.equal(handle.playing, false);
  handle.resume(); assert.equal(handle.playing, true);
  let ended = 0;
  const remove = handle.onEnded(() => ended += 100);
  remove(); handle.onEnded(() => ++ended);
  f.finish(); assert.equal(ended, 0); f.tick(); f.tick();
  assert.equal(ended, 1); assert.equal(handle.playing, false);
  handle.stop(); handle.stop(); handle.pause(); handle.resume();
  assert.equal(f.intervals.size, 0);
});

test('已结束句柄的异步 onEnded 与取消订阅', () => {
  const f = fixture();
  const handle = f.px.audio.player.playPcm(new Uint8Array(4));
  f.finish(); f.tick(); let ended = 0;
  const remove = handle.onEnded(() => ++ended);
  assert.equal(ended, 0); remove(); f.microtask(); assert.equal(ended, 0);
  handle.onEnded(() => ++ended); f.microtask(); assert.equal(ended, 1);
});

test('流式背压不丢分块、结束仍等硬件完成', () => {
  const f = fixture();
  const stream = f.px.audio.player.openPcmStream();
  stream.feed(new Uint8Array(65536));
  assert.equal(stream.buffered(), 2048);
  assert.throws(() => stream.feed(new Uint8Array(2)), /EAGAIN/);
  assert.equal(f.current.feed.length, 1);
  let ended = 0; stream.onEnded(() => ++ended);
  stream.end(); stream.end(); f.tick(); assert.equal(ended, 0);
  assert.throws(() => stream.feed(new Uint8Array(2)), /EINVAL/);
  f.finish(); f.tick(); assert.equal(ended, 1); assert.equal(stream.buffered(), 0);
});

test('stopAll 只发一次结束、取消不报硬件错误', () => {
  const f = fixture();
  const handle = f.px.audio.player.playPcm(new Uint8Array(4));
  let ended = 0; handle.onEnded(() => ++ended);
  f.px.audio.player.stopAll(); assert.equal(handle.playing, false);
  f.tick(); assert.equal(ended, 1); assert.equal(f.logs.length, 0);
  handle.stop(); f.tick(); assert.equal(ended, 1);
});

test('硬件错误和用户回调异常不会阻断资源回收', () => {
  const f = fixture();
  const handle = f.px.audio.player.playPcm(new Uint8Array(4));
  let ended = 0;
  handle.onEnded(() => { throw new Error('callback failed'); });
  handle.onEnded(() => ++ended);
  f.finish(-5, 'EIO'); f.tick();
  assert.equal(ended, 1); assert.equal(f.intervals.size, 0);
  assert(f.logs.some(log => log.includes('EIO')));
  assert(f.logs.some(log => log.includes('callback failed')));
});

test('退出取消轮询，不把旧 VM 回调留给后台', () => {
  const f = fixture();
  const handle = f.px.audio.player.playPcm(new Uint8Array(4));
  let ended = 0; handle.onEnded(() => ++ended);
  f.exit(); f.tick(); f.microtask();
  assert.equal(f.shutDown, true); assert.equal(ended, 0);
  assert.equal(f.intervals.size, 0); assert.equal(handle.playing, false);
  assert.throws(() => f.px.audio.player.tone(), /ECANCELED/);
});

test('未支持平台 ENOTSUP 与参数检查', () => {
  const f = fixture(); f.ready = false;
  assert.equal(f.px.audio.player.playing, false);
  assert.throws(() => f.px.audio.player.tone(), /^Error: ENOTSUP$/);
  assert.throws(() => f.px.audio.player.playPcm(new Uint8Array(4)), /^Error: ENOTSUP$/);
  f.ready = true;
  assert.throws(() => f.px.audio.player.playPcm(new Uint8Array(3)), /EINVAL/);
  assert.throws(() => f.px.audio.player.openPcmStream({channels: 3}), /EINVAL/);
  assert.throws(() => f.px.audio.player.tone(NaN), /EINVAL/);
  assert.throws(() => f.px.audio.player.tone(440, 0), /EINVAL/);
  assert.throws(() => f.px.audio.setVolume(Infinity), /EINVAL/);
  assert.equal(f.intervals.size, 0);
});

async function asyncTest(name, run) { await run(); ++passed; console.log('PASS ' + name); }

await asyncTest('文件播放 Promise 等硬件开始，短文件保留开始与结束两个事件', async () => {
  const f = fixture(); f.files.set('/app/test.wav', new Uint8Array([82, 73, 70, 70]));
  let resolved = false;
  const pending = f.px.audio.player.play('/app/test.wav').then(handle => { resolved = true; return handle; });
  await Promise.resolve(); assert.equal(resolved, false);
  assert.equal(f.current.encoded, true);
  assert.deepEqual([...f.current.data], [82, 73, 70, 70]);
  f.started(); f.finish(); f.tick();
  const handle = await pending;
  assert.equal(handle.playing, false);
  let ended = 0; handle.onEnded(() => ++ended); f.microtask(); assert.equal(ended, 1);
});

await asyncTest('解码与打开失败 reject，不返回假成功句柄', async () => {
  const f = fixture();
  await assert.rejects(f.px.audio.player.play('/app/missing.mp3'), /ENOENT/);
  await assert.rejects(f.px.audio.player.play('/etc/passwd'), /EINVAL/);
  f.files.set('/data/bad.mp3', new Uint8Array([1, 2, 3]));
  const failed = assert.rejects(f.px.audio.player.play('/data/bad.mp3'), /EBADMSG/);
  f.finish(-74, 'EBADMSG'); f.tick(); await failed;
  assert.equal(f.intervals.size, 0);
});

await asyncTest('HTTP 状态失败与下载后取消不会启动播放', async () => {
  const denied = fixture({fetch: async () => ({ok: false, status: 404})});
  await assert.rejects(denied.px.audio.player.play('http://example/audio.mp3'), /HTTP 404/);
  let release;
  const f = fixture({fetch: () => new Promise(resolve => { release = resolve; })});
  const pending = assert.rejects(f.px.audio.player.play('http://example/audio.mp3'), /ECANCELED/);
  f.px.audio.player.stopAll();
  release({ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer});
  await pending; assert.equal(f.calls.length, 0);
});

await asyncTest('文件开始前退出会拒绝等待并清理回调', async () => {
  const f = fixture(); f.files.set('/app/test.mp3', new Uint8Array([1, 2]));
  const pending = assert.rejects(f.px.audio.player.play('/app/test.mp3'), /ECANCELED/);
  f.exit(); await pending; assert.equal(f.shutDown, true); assert.equal(f.intervals.size, 0);
});

await asyncTest('内部语音流区分真实播放完成、I/O失败和VM退出', async () => {
  const good = fixture(); const stream = good.internal.openPcmStream({sampleRate:16000});
  let done = false; stream.finished.then(() => { done = true; });
  stream.stream.feed(new Uint8Array([1,2])); stream.stream.end(); await Promise.resolve(); assert(!done);
  good.finish(); good.tick(); await stream.finished; assert(done);
  const bad = fixture(); const failed = bad.internal.openPcmStream({});
  const check = assert.rejects(failed.finished,/EIO/); bad.finish(-5,'EIO'); bad.tick(); await check;
  const exit = fixture(); const cancelled = exit.internal.openPcmStream({});
  const ending = assert.rejects(cancelled.finished,/ECANCELED/); exit.exit(); await ending;
});

console.log(`${passed} audio contract tests passed`);
