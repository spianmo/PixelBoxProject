/* 测试真实 JS 片段，以有界假时钟/驱动替身控制网络、DMA、采集的异步边界。 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export const flush = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
export const pcm = (value,count = 160) => {
  const bytes = new Uint8Array(count * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < count; ++i) view.setInt16(i * 2,value,true);
  return bytes;
};
export function fixture() {
  let now = 0, nextTimer = 0, nextJob = 0, current = null, micActive = false, micBusy = false, nonce = 0;
  const timers = new Map(), rawSockets = [], sockets = [], connectCalls = [], audioJobs = [], micFrames = [], audioEvents = [], logs = [], files = new Map();
  const subscriptions = new Set();
  const schedule = (callback,delay,interval) => {
    const id = ++nextTimer; timers.set(id,{callback,due:now + Math.max(1,delay),interval}); return id;
  };
  const native = {
    randomBytes: size => new Uint8Array(size).fill(++nonce),
    micAvailable: () => true, micActive: () => micActive, micBusy: () => micBusy,
    micStart() { micActive = micBusy = true; },
    micStop() { micActive = micBusy = false; micFrames.length = 0; },
    micSetGain() {}, micPoll() { const event = micFrames.shift(); if (event instanceof Error) throw event; return event || null; },
    // 原生计算另有真实QuickJS/UBSan对照；这里保留原JS数学定义验证VAD所有状态机行为。
    micPcmRms(bytes) {
      const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); let sum = 0;
      for (let i = 0; i < bytes.length; i += 2) { const sample = view.getInt16(i,true); sum += sample * sample; }
      return Math.sqrt(sum / (bytes.length / 2));
    },
    audioAvailable: () => true,
    audioStreamOpen(rate,channels) {
      if (current) throw new Error('EBUSY');
      current = {id:++nextJob,rate,channels,buffered:0,feed:[],eos:false,stop:false}; audioJobs.push(current); return current.id;
    },
    audioStreamFeed(id,data) {
      assert.equal(id,current?.id);
      if (current.buffered + data.length > 65536) throw new Error('EAGAIN');
      current.buffered += data.length; current.feed.push(new Uint8Array(data));
    },
    audioStreamEnd(id) { assert.equal(id,current?.id); current.eos = true; },
    audioBuffered: id => { assert.equal(id,current?.id); return current.buffered / 32; },
    audioStop(id) {
      if (!current || id !== current.id) return;
      current.stop = true; audioEvents.push({jobId:id,error:-125,code:'ECANCELED'}); current = null;
    },
    audioStopAll() { if (current) this.audioStop(current.id); },
    audioShutdown() { if (current) this.audioStop(current.id); },
    audioPlaying: id => !!current && (!id || current.id === id),
    audioPoll: () => audioEvents.shift() || null,
    fs: {writeBytes(path,bytes) { files.set(path,new Uint8Array(bytes)); }}
  };
  class Socket {
    constructor() { this.connected = true; this.sent = []; this.paused = false; this.pending = []; this.data = new Set(); this.closeCallbacks = new Set(); this.errors = new Set(); this.sendError = null; }
    onData(callback) { this.data.add(callback); return () => this.data.delete(callback); }
    onClose(callback) { this.closeCallbacks.add(callback); return () => this.closeCallbacks.delete(callback); }
    onError(callback) { this.errors.add(callback); return () => this.errors.delete(callback); }
    send(bytes) { if (this.sendError) throw this.sendError; this.sent.push(new Uint8Array(bytes)); }
    close() { this.connected = false; this.pending = []; }
    remoteClose() { this.connected = false; for (const callback of [...this.closeCallbacks]) callback(); }
    receive(input) {
      const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
      if (this.paused) { this.pending.push(bytes); return; }
      for (const callback of [...this.data]) callback(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset + bytes.byteLength));
    }
    pause(value) { this.paused = value; while (!this.paused && this.pending.length) this.receive(this.pending.shift()); }
  }
  class WS {
    constructor(url,headers = {}) { this.url = url; this.headers = headers; this.readyState = 0; this.sent = []; this.disposed = false; this.paused = false; this.pending = []; this.sendError = null; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value) { if (this.sendError) throw this.sendError; if (this.readyState !== 1) throw new Error('socket not open'); this.sent.push(typeof value === 'string' ? value : new Uint8Array(value)); }
    message(data) { if (this.paused) { this.pending.push(data); return; } this.onmessage?.({data}); }
    pause(value) { this.paused = value; while (!this.paused && this.pending.length) this.message(this.pending.shift()); }
    dispose() { this.disposed = true; this.readyState = 3; this.pending = []; }
  }
  const px = {audio:{player:{}},wifi:{status:() => ({mac:'12:34:56:78:9A:BC'})},net:{connectTcp(options) {
    connectCalls.push(options); const socket = new Socket(); rawSockets.push(socket); return Promise.resolve(socket);
  }}};
  const context = vm.createContext({
    px,native,exitHandlers:subscriptions,Uint8Array,ArrayBuffer,DataView,TextEncoder,TextDecoder,Date,
    u8:value => value instanceof Uint8Array ? value : new Uint8Array(value),
    performance:{now:() => now},console:{error:(...values) => logs.push(values.map(String).join(' '))},
    setInterval:(callback,delay) => schedule(callback,delay,delay),clearInterval:id => timers.delete(id),
    setTimeout:(callback,delay) => schedule(callback,delay,0),clearTimeout:id => timers.delete(id),
    WebSocket:WS,wsConnectWithHeaders:(url,headers) => new WS(url,headers),wsDispose:socket => socket.dispose(),
    wsReadPause:(socket,value) => socket.pause(value),netReadPause:(socket,value) => socket.pause(value)
  });
  context.g = context;
  for (const name of ['audio','mic','http','speech_transport','speech','voice']) {
    const source = fs.readFileSync(new URL('../src/prelude_' + name + '.js',import.meta.url),'utf8');
    vm.runInContext(source,context,{filename:'prelude_' + name + '.js'});
  }
  const internal = vm.runInContext('({micHub,audioInternal,speechPcmSink,speechHttpStream,speechWav})',context);
  return {
    px,native,internal,sockets,rawSockets,connectCalls,audioJobs,timers,logs,files,micFrames,
    get now() { return now; }, get current() { return current; }, get micActive() { return micActive; },
    async advance(ms) {
      const target = now + ms; let iterations = 0;
      while (true) {
        let id = 0, next = null;
        for (const [candidate,item] of timers) if (item.due <= target && (!next || item.due < next.due)) { id = candidate; next = item; }
        if (!next) break;
        if (++iterations > 100000) throw new Error('fake clock runaway');
        now = next.due;
        if (next.interval) next.due += next.interval; else timers.delete(id);
        next.callback(); await flush();
      }
      now = target; await flush();
    },
    async frame(value = 0,count = 160) { micFrames.push({data:pcm(value,count).buffer,sampleRate:16000}); await this.advance(10); },
    async drain(bytes = Infinity,complete = true,error = '') {
      if (!current) return;
      current.buffered = Math.max(0,current.buffered - bytes);
      if (error || (complete && current.eos && !current.buffered)) {
        audioEvents.push({jobId:current.id,error:error ? -5 : 0,code:error}); current = null;
      }
      await this.advance(20);
    },
    async exit() { for (const callback of subscriptions) callback(); await flush(); }
  };
}
