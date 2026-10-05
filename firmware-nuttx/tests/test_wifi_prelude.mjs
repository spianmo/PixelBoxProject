// 使用真实 prelude 验证异步结算、凭据写入和跨应用生命周期。
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/prelude_wifi.js', import.meta.url), 'utf8');
let next = 0, nextTimer = 0, disconnects = 0, startError = null;
const timers = new Map(), results = [], saved = [], starts = [], exitHandlers = new Set();
const status = {connected:false,ssid:null,ip:null,rssi:0,mac:''};
const native = {
  model:'host', mac:'00:11:22:33:44:55',
  wifiStatus:()=>({...status}), wifiPoll:()=>results.shift() ?? null,
  wifiScan:timeout=>{if(startError) throw startError; starts.push(['scan',timeout]); return ++next;},
  wifiConnect:(...args)=>{if(startError) throw startError; starts.push(args); return ++next;},
  wifiDisconnect:()=>{disconnects++;},
  wifiAbandon:()=>{disconnects++;},
  atomicWrite:(path,text)=>saved.push([path,JSON.parse(text)]),
};
const px = {};
new Function('native','px','exitHandlers','unsupported','noop','setInterval','clearInterval',source)(
  native,px,exitHandlers,()=>{throw new Error('ENOTSUP');},()=>{},
  cb=>{timers.set(++nextTimer,cb);return nextTimer;},id=>timers.delete(id));
const tick = async result => {
  if(result) results.push(result);
  for(const callback of [...timers.values()]) callback();
  await new Promise(resolve=>setImmediate(resolve));
};
assert.equal(px.wifi.status().mac,native.mac);
assert.throws(()=>px.wifi.on('invalid',()=>{}),/invalid/);
assert.throws(()=>px.wifi.on('gotIp',null),/function/);
const events = [];
const off=px.wifi.on('gotIp',x=>events.push(x));
let promise=px.wifi.connect('unit-test','password',{timeoutMs:1234});
await tick();
assert.deepEqual(starts.pop(),['unit-test','password',1234]);
assert.equal(saved.length,0);
await assert.rejects(px.wifi.scan(),/EBUSY/);
const ready={connected:true,ssid:'unit-test',ip:'192.0.2.2',rssi:-45,mac:native.mac};
await tick({id:next,operation:2,error:0,events:5,status:ready});
assert.deepEqual(await promise,ready);
assert.deepEqual(saved,[['/data/.pixelbox-wifi.json',{ssid:'unit-test',password:'password'}]]);
assert.deepEqual(events,[ready]);
off(); assert.equal(timers.size,0);
promise=px.wifi.connect('bad','bad');
const failure=assert.rejects(promise,error=>error.code===-110);
await tick(); await tick({id:next,operation:2,error:-110,events:0,status}); await failure;
assert.equal(saved.length,1); assert.equal(timers.size,0);
promise=px.wifi.connect('temporary','',{save:false}); await tick();
await tick({id:next,operation:2,error:0,events:0,status:ready}); await promise;
assert.equal(saved.length,1);
promise=px.wifi.scan();
await tick({id:next,operation:1,error:0,events:0,status,aps:[{ssid:'open',secure:false}]});
assert.deepEqual(await promise,[{ssid:'open',secure:false}]);
for(const close of exitHandlers) close();
assert.equal(disconnects,0); // 已完成连接留给下个应用/服务继续使用。
startError=new Error('ENOTSUP'); await assert.rejects(px.wifi.scan(),/ENOTSUP/);
assert.equal(timers.size,0); startError=null;
px.wifi.scan(); // 未完成作业随 VM 退出撤销，不能把回调带入下一代 VM。
for(const close of exitHandlers) close();
assert.equal(disconnects,1); assert.equal(timers.size,0);
console.log('Wi-Fi prelude: async results, persistence, cancellation and lifecycle passed');
