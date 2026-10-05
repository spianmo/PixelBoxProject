import assert from 'node:assert/strict';
import {fixture,flush,pcm} from './speech_fixture.mjs';

const options = {serverUrl:'wss://voice.example/stream',token:'a+b&c=中',vadSilenceMs:200};
const messages = socket => socket.sent.filter(value => typeof value === 'string').map(JSON.parse);
const receive = (socket,type,values = {}) => socket.message(JSON.stringify({type,...values}));
let passed = 0;
async function test(name,run) { await run(); ++passed; console.log('PASS ' + name); }
async function speakTurn(f,continuous = false) {
  f.px.voice.configure(options);
  if (continuous) f.px.voice.startContinuous(); else f.px.voice.start();
  const ws = f.sockets[0]; ws.open();
  for (let i = 0; i < 2; ++i) await f.frame(0);
  for (let i = 0; i < 6; ++i) await f.frame(2000);
  for (let i = 0; i < 20; ++i) await f.frame(0);
  await f.advance(5);
  assert.equal(f.px.voice.state(),'thinking'); return ws;
}

await test('配置校验、token编码、设备标识与事件取消订阅', async () => {
  const f = fixture(), states = [];
  assert.throws(() => f.px.voice.configure({...options,wakeword:true}),/ENOTSUP/);
  assert.throws(() => f.px.voice.configure({...options,serverUrl:'file:///tmp'}),/serverUrl/);
  assert.throws(() => f.px.voice.on('bogus',() => {}),/invalid/);
  const off = f.px.voice.on('stateChange',state => states.push(state));
  f.px.voice.configure(options); f.px.voice.start(); const ws = f.sockets[0];
  assert(ws.url.endsWith('token=a%2Bb%26c%3D%E4%B8%AD')); ws.open();
  assert.deepEqual(messages(ws)[0],{type:'session.start',device:'px-789abc',sampleRate:16000});
  assert.equal(f.px.voice.state(),'listening'); off(); f.px.voice.stop();
  assert.deepEqual(states,['connecting','listening']); assert(!f.micActive); assert(ws.disposed); await f.exit();
});
await test('VAD开始/静音结束、60ms音频包以及结束控制消息严格有序', async () => {
  const f = fixture(), started = [], ended = [], levels = [];
  f.px.voice.on('speechStart',() => started.push(true)); f.px.voice.on('speechEnd',() => ended.push(true));
  f.px.voice.on('level',value => levels.push(value));
  const ws = await speakTurn(f);
  assert.equal(started.length,1); assert.equal(ended.length,1); assert(levels.every(value => value >= 0 && value <= 100));
  const end = ws.sent.findIndex(value => typeof value === 'string' && JSON.parse(value).type === 'speech.end');
  const bytes = ws.sent.slice(1,end).filter(value => typeof value !== 'string');
  assert.equal(bytes.reduce((sum,value) => sum + value.length,0),28 * 320);
  assert(bytes.slice(0,-1).every(value => value.length === 1920));
  assert.equal(ws.sent.length,end + 1); await f.exit();
});
await test('拥塞时保留session.start、整段PCM与speech.end顺序', async () => {
  const f = fixture(); f.px.voice.configure(options); f.px.voice.start(); const ws = f.sockets[0];
  ws.sendError = new Error('ENOBUFS'); ws.open();
  for (let i = 0; i < 2; ++i) await f.frame(0);
  for (let i = 0; i < 6; ++i) await f.frame(2000);
  for (let i = 0; i < 20; ++i) await f.frame(0);
  assert.equal(ws.sent.length,0); ws.sendError = null; await f.advance(5);
  assert.equal(JSON.parse(ws.sent[0]).type,'session.start'); assert.equal(JSON.parse(ws.sent.at(-1)).type,'speech.end');
  assert.equal(ws.sent.filter(value => typeof value !== 'string').reduce((sum,value) => sum + value.length,0),8960); await f.exit();
});
await test('say只在实际播放完成时resolve，服务器文本事件完整透传', async () => {
  const f = fixture(), texts = []; f.px.voice.configure(options);
  for (const event of ['userText','assistantDelta','assistantText']) f.px.voice.on(event,value => texts.push([event,value]));
  let done = false; const promise = f.px.voice.say('你好').then(() => { done = true; });
  const ws = f.sockets[0]; ws.open(); assert.equal(messages(ws)[1].type,'tts.request');
  receive(ws,'stt.final',{text:'用户'}); receive(ws,'llm.delta',{text:'助'}); receive(ws,'llm.done',{text:'助手'});
  receive(ws,'tts.begin'); ws.message(pcm(800,320).buffer); receive(ws,'tts.end'); await flush();
  assert(!done); assert.equal(f.px.voice.state(),'speaking'); assert(f.current.eos);
  await f.drain(); await promise; assert(done); assert.equal(f.px.voice.state(),'idle');
  assert.deepEqual(texts,[['userText','用户'],['assistantDelta','助'],['assistantText','助手']]); await f.exit();
});
await test('连续对话等扬声器排空再拾音，非16k TTS重采样保持共享时钟', async () => {
  const f = fixture(); const ws = await speakTurn(f,true);
  receive(ws,'tts.begin',{sampleRate:8000}); ws.message(pcm(-1000,80).buffer); receive(ws,'tts.end'); await flush();
  assert.equal(f.current.rate,16000); const bytes = Buffer.concat(f.current.feed.map(Buffer.from));
  assert.equal(bytes.length,318); assert.equal(bytes.readInt16LE(0),-1000); assert.equal(bytes.readInt16LE(316),-1000);
  assert.equal(f.px.voice.state(),'speaking'); await f.drain();
  assert.equal(f.px.voice.state(),'listening'); assert(f.micActive); await f.exit();
});
await test('240ms连续强语音打断TTS并补发最多500ms预滚', async () => {
  const f = fixture(); const ws = await speakTurn(f);
  receive(ws,'tts.begin'); ws.message(pcm(100,160).buffer);
  for (let i = 0; i < 24; ++i) await f.frame(6000);
  await f.advance(5);
  assert.equal(f.px.voice.state(),'listening'); assert(f.audioJobs[0].stop);
  const index = ws.sent.findIndex(value => typeof value === 'string' && JSON.parse(value).type === 'interrupt');
  assert(index > 0);
  const replay = ws.sent.slice(index + 1).filter(value => typeof value !== 'string');
  assert(replay.reduce((sum,value) => sum + value.length,0) >= 7000);
  for (const chunk of replay) assert.equal(new DataView(chunk.buffer,chunk.byteOffset).getInt16(0,true),6000);
  await f.exit();
});
await test('下行PCM背压暂停WS且无丢样，旧连接消息不污染新会话', async () => {
  const f = fixture(); f.px.voice.configure(options); const promise = f.px.voice.say('测试'); const ws = f.sockets[0]; ws.open();
  const stale = ws.onmessage;
  receive(ws,'tts.begin'); ws.message(pcm(100,20000).buffer); assert(ws.paused);
  ws.message(pcm(-100,40000).buffer); receive(ws,'tts.end');
  for (let i = 0; i < 6 && f.current; ++i) await f.drain();
  await promise; assert.equal(Buffer.concat(f.audioJobs[0].feed.map(Buffer.from)).length,120000);
  f.px.voice.stop(); f.px.voice.start(); f.sockets[1].open();
  stale({data:JSON.stringify({type:'tts.begin'})}); assert.equal(f.px.voice.state(),'listening'); assert.equal(f.audioJobs.length,1); await f.exit();
});
await test('say busy、服务端错误、音频失败、停止和连接超时都终结Promise', async () => {
  for (const kind of ['server','hardware','stop','timeout']) {
    const f = fixture(); f.px.voice.configure(options);
    const promise = f.px.voice.say(kind); const failed = assert.rejects(promise,/坏请求|EIO|stopped|ETIMEDOUT/);
    await assert.rejects(f.px.voice.say('busy'),/EBUSY/);
    const ws = f.sockets[0];
    if (kind === 'timeout') await f.advance(15000);
    else if (kind === 'stop') f.px.voice.stop();
    else {
      ws.open(); if (kind === 'server') receive(ws,'error',{message:'坏请求'});
      else { receive(ws,'tts.begin'); ws.message(pcm(1).buffer); await f.drain(0,false,'EIO'); }
    }
    await failed; assert.equal(f.px.voice.state(),'idle'); await f.exit();
  }
});
await test('公开MIC与voice共享采集，voice停止不影响应用MIC，退出不残留计时器', async () => {
  const f = fixture(); let frames = 0;
  f.px.audio.mic.start({frameMs:10,onData:() => ++frames}); f.px.voice.configure(options); f.px.voice.start(); f.sockets[0].open();
  await f.frame(); f.px.voice.stop(); await f.frame(); assert.equal(frames,2); assert(f.micActive);
  await f.exit(); assert.equal(f.timers.size,0); assert(!f.micActive);
});
await test('say打断向中继发送interrupt，拥塞时关闭连接终止服务端输出', async () => {
  for (const congested of [false,true]) {
    const f = fixture(); f.px.voice.configure(options);
    const failed = assert.rejects(f.px.voice.say('interrupt'),/interrupted/);
    const ws = f.sockets[0]; ws.open(); receive(ws,'tts.begin'); ws.message(pcm(100,160).buffer);
    if (congested) ws.sendError = new Error('ENOBUFS');
    f.px.voice.interrupt(); await failed;
    assert.equal(f.px.voice.state(),'idle'); assert(f.audioJobs[0].stop);
    if (congested) assert(ws.disposed);
    else assert.equal(messages(ws).filter(value => value.type === 'interrupt').length,1);
    await f.exit(); assert.equal(f.timers.size,0);
  }
});
await test('sendText输入错误或忙碌只报告本次调用错误，不取消已在进行的say', async () => {
  const f = fixture(), errors = []; f.px.voice.configure(options);
  f.px.voice.on('error',error => errors.push(error));
  const result = f.px.voice.say('keep playing'); const ws = f.sockets[0];
  f.px.voice.sendText('busy'); f.px.voice.sendText('');
  assert.equal(f.px.voice.state(),'connecting'); assert(!ws.disposed);
  assert.equal(errors.length,2); assert(errors.some(error => /EBUSY/.test(error)));
  ws.open(); receive(ws,'tts.begin'); ws.message(pcm(100,160).buffer); receive(ws,'tts.end');
  await f.drain(); await result; assert.equal(f.px.voice.state(),'idle'); await f.exit();
});
await test('状态/错误回调内stop或重配不会恢复旧任务、旧计时器', async () => {
  for (const target of ['connecting','listening','thinking','speaking']) {
    const f = fixture(); f.px.voice.configure(options);
    f.px.voice.on('stateChange',state => { if (state === target) f.px.voice.stop(); });
    if (target === 'thinking' || target === 'speaking') {
      const result = assert.rejects(f.px.voice.say('test'),/stopped/); const ws = f.sockets[0]; ws.open();
      if (target === 'speaking') receive(ws,'tts.begin');
      await result;
    } else { f.px.voice.start(); if (target === 'listening') f.sockets[0].open(); }
    assert.equal(f.px.voice.state(),'idle'); assert.equal(f.timers.size,0); assert(!f.micActive); await f.exit();
  }
  const f = fixture(); f.px.voice.configure(options);
  const old = assert.rejects(f.px.voice.say('old'),/old failure/); const ws = f.sockets[0]; ws.open();
  f.px.voice.on('error',() => { f.px.voice.configure({...options,serverUrl:'ws://new.example'}); f.px.voice.start(); });
  receive(ws,'error',{message:'old failure'}); await old;
  assert.equal(f.px.voice.state(),'connecting'); assert.equal(f.sockets.length,2); assert(ws.disposed); await f.exit();
});


await test('批量采集与10ms单帧保留相同20ms VAD、PCM顺序和尾帧', async () => {
  const run = async chunks => {
    const f = fixture(), events = [];
    f.px.voice.on('speechStart',() => events.push('start'));
    f.px.voice.on('speechEnd',() => events.push('end'));
    f.px.voice.configure(options); f.px.voice.start(); const ws = f.sockets[0]; ws.open();
    const input = new Uint8Array(28 * 320);
    input.set(pcm(2000,960),640);
    let offset = 0;
    for (const size of chunks) {
      f.micFrames.push({sampleRate:16000,data:input.slice(offset,offset + size).buffer});
      offset += size; await f.advance(10);
    }
    assert.equal(offset,input.length); await f.advance(5);
    const output = Buffer.concat(ws.sent.filter(value => typeof value !== 'string').map(Buffer.from));
    assert.deepEqual(output,Buffer.from(input));
    assert.equal(f.px.voice.state(),'thinking'); assert.deepEqual(events,['start','end']);
    const types=ws.sent.filter(value=>typeof value==='string').map(value=>JSON.parse(value).type);
    await f.exit(); return {output,types,events};
  };
  const individual=await run(Array(28).fill(320));
  // 先交付10ms尾帧，随后三次批量；覆盖跨批合帧和完整20ms直接读取。
  const batches=await run([320,3200,3200,2240]);
  assert.deepEqual(batches,individual);
});
await test('批量强语音恰在240ms打断，preroll与公开MIC修改隔离', async () => {
  const f=fixture();const ws=await speakTurn(f);
  f.px.audio.mic.start({frameMs:20,onData:bytes=>new Uint8Array(bytes).fill(0)});
  receive(ws,'tts.begin');ws.message(pcm(100,160).buffer);
  for(let batch=0;batch<2;batch++){f.micFrames.push({sampleRate:16000,data:pcm(6000,1600).buffer});await f.advance(10);}
  assert.equal(f.px.voice.state(),'speaking');
  f.micFrames.push({sampleRate:16000,data:pcm(6000,320).buffer});await f.advance(10);
  assert.equal(f.px.voice.state(),'speaking');
  f.micFrames.push({sampleRate:16000,data:pcm(6000,320).buffer});await f.advance(10);
  assert.equal(f.px.voice.state(),'listening');await f.advance(5);
  const index=ws.sent.findIndex(value=>typeof value==='string'&&JSON.parse(value).type==='interrupt');
  const replay=Buffer.concat(ws.sent.slice(index+1).filter(value=>typeof value!=='string').map(Buffer.from));
  assert.equal(replay.length,7680);
  for(let i=0;i<replay.length;i+=2)assert.equal(replay.readInt16LE(i),6000);
  await f.exit();
});
await test('批量VAD回调内停止并重开会话，不将旧批次剩余PCM交给新会话', async () => {
  const f=fixture();f.px.voice.configure(options);f.px.voice.start();f.sockets[0].open();
  await f.frame(0,320);
  const off=f.px.voice.on('speechStart',()=>{off();f.px.voice.stop();f.px.voice.start();f.sockets[1].open();});
  f.micFrames.push({sampleRate:16000,data:pcm(2000,1600).buffer});await f.advance(10);
  const next=f.sockets[1];assert(next);assert.equal(f.px.voice.state(),'listening');
  await f.advance(10);assert.equal(next.sent.filter(value=>typeof value!=='string').length,0);
  await f.frame(9,960);await f.advance(5);
  const bytes=Buffer.concat(next.sent.filter(value=>typeof value!=='string').map(Buffer.from));
  assert.equal(bytes.length,1920);for(let i=0;i<bytes.length;i+=2)assert.equal(bytes.readInt16LE(i),9);
  await f.exit();
});

console.log(`${passed} voice contract tests passed`);
