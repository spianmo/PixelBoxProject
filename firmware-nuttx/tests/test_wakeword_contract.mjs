import assert from 'node:assert/strict';
import {fixture,flush} from './speech_fixture.mjs';

const options = {phrase:'你好小盒',pinyin:'ni hao xiao he',threshold:0.6,onWake(){}};
function setup() {
  const f = fixture(), events = [], feeds = [], stops = [], starts = [];
  let busy = false, id = 0;
  Object.assign(f.native,{
    wakewordAvailable:() => true,wakewordBusy:() => busy,
    wakewordStart(pinyin,threshold) { assert(!busy); busy = true; starts.push({pinyin,threshold}); return ++id; },
    wakewordStop(job) { stops.push(job); },
    wakewordFeed(job,bytes) { feeds.push({job,bytes:new Uint8Array(bytes)}); },
    wakewordPoll:() => events.shift() || null
  });
  return Object.assign(f,{events,feeds,stops,starts,getId:() => id,release:() => { busy = false; },
    ready:async () => { events.push({jobId:id,kind:'ready'}); await f.advance(10); },
    wake:async () => { busy = false; events.push({jobId:id,kind:'wake',probability:.9}); await f.advance(10); }
  });
}
let passed = 0;
async function test(name,run) { await run(); console.log('PASS ' + name); ++passed; }

await test('真实后端ready之后才解析start，PCM16LE完整交付且命中仅回调一次', async () => {
  const f = setup(); let ready = false, count = 0;
  const p = f.px.speech.wakeword.start({...options,onWake(){++count;}}).then(() => { ready = true; });
  await flush(); assert(!ready); assert(!f.micActive);
  await f.ready(); await p; assert(ready && f.micActive);
  await f.frame(-1234); assert.equal(f.feeds.length,1); assert.equal(new DataView(f.feeds[0].bytes.buffer).getInt16(0,true),-1234);
  await f.wake(); assert.equal(count,1); assert(!f.micActive); assert.equal(f.stops.length,1);
  await f.wake(); assert.equal(count,1); await f.exit();
});
await test('取消初始化拒绝旧Promise，等待原生真实回收后启动新代数', async () => {
  const f = setup(); let wakes = 0;
  const first = assert.rejects(f.px.speech.wakeword.start(options),/ECANCELED/);
  const old = f.getId(); const second = f.px.speech.wakeword.start({...options,onWake(){++wakes;}});
  await first; await f.advance(30); assert.equal(f.starts.length,1);
  f.release(); await f.advance(10); assert.equal(f.starts.length,2);
  f.events.push({jobId:old,kind:'ready'},{jobId:old,kind:'wake'});
  await f.ready(); await second; assert.equal(wakes,0);
  await f.wake(); assert.equal(wakes,1); await f.exit();
});
await test('显式stop不触发onError；原生错误和麦克风故障才上报', async () => {
  const f = setup(), errors = [];
  let p = f.px.speech.wakeword.start({...options,onError:e => errors.push(e)}); await f.ready(); await p;
  const stopped = f.px.speech.wakeword.stop(); assert.equal(errors.length,0); assert(!f.micActive);
  f.release(); await f.advance(10); await stopped;
  f.release(); p = f.px.speech.wakeword.start({...options,onError:e => errors.push(e)}); await f.ready(); await p;
  f.events.push({jobId:f.getId(),kind:'error',code:'EBADMSG'}); await f.advance(10);
  assert.match(errors[0],/EBADMSG/); assert(!f.micActive);
  f.release(); p = f.px.speech.wakeword.start({...options,onError:e => errors.push(e)}); await f.ready(); await p;
  f.micFrames.push(new Error('EOVERFLOW')); await f.advance(10); assert.match(errors[1],/EOVERFLOW/); await f.exit();
});
await test('初始化360秒上限、错误消息和销毁均不留下待定Promise', async () => {
  const f = setup(); const timed = assert.rejects(f.px.speech.wakeword.start(options),/ETIMEDOUT/);
  await f.advance(360000); await timed; assert.equal(f.stops.length,1);
  f.release(); const bad = assert.rejects(f.px.speech.wakeword.start(options),/ENOMEM/);
  f.events.push({jobId:f.getId(),kind:'error',code:'ENOMEM'}); await f.advance(10); await bad;
  f.release(); const exited = assert.rejects(f.px.speech.wakeword.start(options),/ECANCELED/); await f.exit(); await exited;
});
await test('与录音订阅并存、业务取消与配置更新清理唤醒、回调异常不泄漏', async () => {
  const f = setup(); let frames = 0;
  f.px.audio.mic.start({frameMs:10,onData(){++frames;}});
  let p = f.px.speech.wakeword.start({...options,onWake(){throw new Error('callback failure');}}); await f.ready(); await p;
  await f.frame(); await f.wake(); assert(frames > 0 && f.micActive); assert(f.logs.some(x => x.includes('callback failure')));
  p = f.px.speech.wakeword.start(options); await f.ready(); await p;
  f.px.speech.configure({region:'eastasia',key:'abcdefgh1234'}); assert(f.stops.length >= 2);
  f.release(); p = f.px.speech.wakeword.start(options); await f.ready(); await p; f.px.speech.cancel();
  assert(f.stops.length >= 3); await f.exit();
});
await test('stop等待原生worker实际释放模型工作区，重复请求复用等待', async () => {
  const f = setup(), errors = [];
  const start = f.px.speech.wakeword.start({...options,onError:error => errors.push(error)});
  await f.ready(); await start;
  let finished = false;
  const first = f.px.speech.wakeword.stop().then(() => { finished = true; });
  const second = f.px.speech.wakeword.stop();
  await flush();
  assert.equal(finished,false); assert.equal(errors.length,0); assert(!f.micActive);
  f.release(); await f.advance(10);
  await first; await second;
  assert.equal(finished,true);
  await f.exit();
});
console.log(`${passed} wakeword JS contract tests passed; no speech inference claimed`);
