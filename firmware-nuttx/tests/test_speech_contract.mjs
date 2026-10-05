import assert from 'node:assert/strict';
import {fixture,flush,pcm} from './speech_fixture.mjs';

const config = {region:'eastasia',key:'abcdefgh12345678'};
let passed = 0;
async function test(name,run) { await run(); ++passed; console.log('PASS ' + name); }
const payload = frame => {
  const marker = new Uint8Array([13,10,13,10]);
  let end = -1;
  for (let i = 0; i + marker.length <= frame.length; ++i) {
    if (marker.every((value,index) => frame[i + index] === value)) { end = i; break; }
  }
  assert(end > 0);
  return {headers:new TextDecoder().decode(frame.subarray(0,end)),body:frame.subarray(end + marker.length)};
};
const response = (id,path,body = '') => 'Path: ' + path + '\r\nX-RequestId: ' + id + '\r\n\r\n' + (body ? JSON.stringify(body) : '');

await test('配置、SSML输入、唤醒词能力和回调参数校验', async () => {
  const f = fixture(); assert(f.px.speech.available());
  assert.throws(() => f.px.speech.speak('hello'),/配置/);
  for (const bad of [{...config,key:'abc\r\nX: p'},{...config,region:'a.example'},{...config,voice:"'><x>"}]) assert.throws(() => f.px.speech.configure(bad),/格式/);
  f.px.speech.configure(config);
  assert.throws(() => f.px.speech.speak('中'.repeat(2001)),/invalid/);
  assert.throws(() => f.px.speech.recognize({timeoutMs:NaN}),/duration/);
  assert.throws(() => f.px.speech.wakeword.start({phrase:' hey',pinyin:'hey',threshold:0.5,onWake(){}}),/invalid/);
  await assert.rejects(f.px.speech.wakeword.start({phrase:'你好',pinyin:'ni hao',threshold:0.5,onWake(){}}),/ENOTSUP.*MultiNet7/);
  await f.exit();
});
await test('ASR建连前完整留存开口、WAV帧和终止帧顺序、累计字幕', async () => {
  const f = fixture(), partial = []; let publicFrames = 0;
  f.px.audio.mic.start({frameMs:10,onData() { ++publicFrames; }});
  f.px.speech.configure(config);
  const promise = f.px.speech.recognize({silenceMs:300,onPartial:text => partial.push(text)});
  const ws = f.sockets[0]; assert(!ws.url.includes(config.key)); assert.equal(ws.headers['Ocp-Apim-Subscription-Key'],config.key);
  for (let i = 0; i < 2; ++i) await f.frame(0);
  for (let i = 0; i < 20; ++i) await f.frame(1000);
  assert.equal(ws.sent.length,0); ws.open();
  for (let i = 0; i < 30; ++i) await f.frame(0);
  const binary = ws.sent.filter(item => typeof item !== 'string').map(payload);
  assert(binary[0].headers.startsWith('Path: audio\r\n'));
  assert(!binary[0].headers.includes('\r\n\r\n'));
  assert.equal(binary[0].body.length,44); const wav = new DataView(binary[0].body.buffer,binary[0].body.byteOffset,44);
  assert.equal(wav.getUint32(4,true),0); assert.equal(wav.getUint32(40,true),0); assert.equal(wav.getUint32(24,true),16000);
  assert.equal(binary.at(-1).body.length,0); assert(!binary.at(-1).headers.includes('Content-Type'));
  assert.equal(binary.slice(1,-1).reduce((sum,frame) => sum + frame.body.length,0),52 * 320);
  const bytes = Buffer.concat(binary.slice(1,-1).map(frame => Buffer.from(frame.body)));
  assert.equal(bytes.readInt16LE(640),1000); assert.equal(bytes.readInt16LE(639),-6144);
  const id = ws.headers['X-ConnectionId'];
  ws.message(response('wrong','speech.hypothesis',{Text:'错误'}));
  ws.message(response(id,'speech.hypothesis',{Text:'你好'}));
  ws.message(response(id,'speech.phrase',{RecognitionStatus:'Success',DisplayText:'你好。'}));
  ws.message(response(id,'speech.hypothesis',{Text:'世界'}));
  ws.message(response(id,'speech.phrase',{RecognitionStatus:'Success',DisplayText:'世界。'}));
  ws.message(response(id,'turn.end'));
  assert(ws.disposed); assert.equal(await promise,'你好。世界。'); assert.deepEqual(partial,['你好','你好。','你好。世界','你好。世界。']);
  assert(publicFrames >= 52); assert(f.micActive); await f.exit();
});
await test('ASR上行背压保留全音频，最大时长结束且未收到最终响应时超时', async () => {
  const f = fixture(); f.px.speech.configure(config);
  const promise = f.px.speech.recognize({maxMs:1000,timeoutMs:5000}); const failed = assert.rejects(promise,/ETIMEDOUT/);
  const ws = f.sockets[0]; ws.sendError = new Error('ENOBUFS'); ws.open();
  for (let i = 0; i < 100; ++i) await f.frame(0);
  assert(!f.micActive); assert.equal(ws.sent.length,0);
  ws.sendError = null; await f.advance(5);
  const frames = ws.sent.filter(item => typeof item !== 'string').map(payload);
  assert.equal(frames.slice(1,-1).reduce((sum,item) => sum + item.body.length,0),32000);
  await f.advance(5000); await failed; assert(ws.disposed); await f.exit();
});
await test('ASR取消、更换配置及麦克风故障拒绝旧任务且释放资源', async () => {
  const f = fixture(); f.px.speech.configure(config);
  const first = assert.rejects(f.px.speech.recognize(),/ECANCELED/); const old = f.sockets[0];
  f.px.speech.configure({...config,key:'anotherKey123'}); await first; assert(old.disposed);
  const second = assert.rejects(f.px.speech.recognize(),/EOVERFLOW/);
  f.micFrames.push(new Error('EOVERFLOW')); await f.advance(10); await second; assert(!f.micActive);
  const third = assert.rejects(f.px.speech.recognize(),/ECANCELED/); f.px.speech.cancel(); await third; await f.exit();
});
await test('TTS保持验证TLS、SSML转义和半样本拼接，并等待真实DMA完成', async () => {
  const f = fixture(); f.px.speech.configure(config); let done = false;
  const speak = f.px.speech.speak('<你好 & "x">').then(() => { done = true; }); await flush();
  assert.equal(f.connectCalls[0].tls,true); assert.equal(f.connectCalls[0].host,'eastasia.tts.speech.microsoft.com');
  const socket = f.rawSockets[0], request = Buffer.concat(socket.sent.map(Buffer.from)).toString();
  assert(request.includes('Ocp-Apim-Subscription-Key: ' + config.key)); assert(request.includes('&lt;你好 &amp; &quot;x&quot;&gt;'));
  const header = 'HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n';
  for (const byte of Buffer.from(header)) socket.receive(new Uint8Array([byte]));
  socket.receive(new Uint8Array([0x34])); socket.receive(new Uint8Array([0x12,0xfe,0xff,0x80])); socket.receive(new Uint8Array([0x00]));
  await flush(); assert(f.current.eos); assert(!done); assert.equal(socket.connected,false);
  assert.deepEqual([...Buffer.concat(f.current.feed.map(Buffer.from))],[0x34,0x12,0xfe,0xff,0x80,0x00]);
  await f.drain(); await speak; assert(done); await f.exit();
});
await test('同率PCM随机奇偶分包保持原字节且复制调用者缓冲', async () => {
  const f = fixture(); f.px.speech.configure(config);
  const pending = f.px.speech.speak('同率批量传输'); await flush();
  const socket = f.rawSockets[0], source = Buffer.alloc(24576);
  for(let i=0;i<source.length;++i) source[i]=(i*73+19)%256;
  socket.receive('HTTP/1.1 200 OK\r\nContent-Length: '+source.length+'\r\n\r\n');
  let seed=713;
  for(let offset=0;offset<source.length;) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const end=Math.min(source.length,offset+1+seed%2051), chunk=new Uint8Array(source.subarray(offset,end));
    socket.receive(chunk);chunk.fill(0);offset=end;
  }
  await flush();await f.drain();await pending;
  assert.deepEqual(Buffer.concat(f.audioJobs[0].feed.map(Buffer.from)),source);
  await f.exit();
});
await test('TTS接收高低水位形成TCP背压，大音频有序且无丢样', async () => {
  const f = fixture(); f.px.speech.configure(config);
  const speak = f.px.speech.speak('背压测试'); await flush(); const socket = f.rawSockets[0];
  socket.receive('HTTP/1.1 200 OK\r\nContent-Length: 120000\r\n\r\n');
  socket.receive(pcm(321,20000)); assert(socket.paused);
  socket.receive(pcm(-123,40000)); assert.equal(socket.pending.length,1);
  for (let i = 0; i < 6 && f.current; ++i) await f.drain();
  await speak; const data = Buffer.concat(f.audioJobs[0].feed.map(Buffer.from));
  assert.equal(data.length,120000); assert.equal(data.readInt16LE(39998),321); assert.equal(data.readInt16LE(40000),-123);
  await f.exit();
});
await test('TTS chunked分片、截断、HTTP错误、奇数字节和硬件失败均明确处理', async () => {
  const good = fixture(); good.px.speech.configure(config); const done = good.px.speech.speak('分块'); await flush();
  const wire = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;ok=yes\r\n'),Buffer.from([1,2,3]),Buffer.from('\r\n1\r\n'),Buffer.from([4]),Buffer.from('\r\n0\r\nX-End: yes\r\n\r\n')]);
  for (const byte of wire) good.rawSockets[0].receive(new Uint8Array([byte]));
  await flush(); await good.drain(); await done; await good.exit();
  for (const kind of ['truncated','HTTP','odd','hardware']) {
    const f = fixture(); f.px.speech.configure(config); const pending = assert.rejects(f.px.speech.speak(kind),/truncated|HTTP 302|incomplete|EIO/); await flush(); const socket = f.rawSockets[0];
    if (kind === 'HTTP') socket.receive('HTTP/1.1 302 Found\r\nLocation: https://evil.invalid/\r\nContent-Length: 0\r\n\r\n');
    else {
      socket.receive('HTTP/1.1 200 OK\r\nContent-Length: ' + (kind === 'odd' ? 3 : 4) + '\r\n\r\n');
      socket.receive(new Uint8Array(kind === 'odd' ? [1,2,3] : [1,2]));
      if (kind === 'truncated') socket.remoteClose();
      else if (kind === 'hardware') await f.drain(0,false,'EIO');
    }
    await pending; await f.exit();
  }
});
await test('TTS无响应15秒超时、取消和退出均不会挂起Promise', async () => {
  const f = fixture(); f.px.speech.configure(config);
  const timeout = assert.rejects(f.px.speech.speak('timeout'),/ETIMEDOUT/); await flush(); await f.advance(15000); await timeout;
  const cancel = assert.rejects(f.px.speech.speak('cancel'),/ECANCELED/); await flush(); f.px.speech.cancel(); await cancel;
  const exit = assert.rejects(f.px.speech.speak('exit'),/ECANCELED/); await f.exit(); await exit;
});
console.log(`${passed} speech contract tests passed`);
