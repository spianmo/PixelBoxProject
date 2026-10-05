import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/prelude_mdns.js',import.meta.url),'utf8');
function fixture(){
  const calls=[],events=[],timers=new Map(),exitHandlers=new Set();let id=0,timer=0,startError=false,pollError=false,timerError=false;
  const native={mdns:{discover(...args){calls.push(['discover',...args]);if(startError)throw new Error('start error');return ++id;},
    advertise(...args){calls.push(['advertise',...args]);if(startError)throw new Error('start error');return ++id;},
    unadvertise(value){calls.push(['unadvertise',value]);},poll(){if(pollError)throw new Error('poll error');return events.shift()||null;},
    shutdown(){calls.push(['shutdown']);}}};
  const context={native,px:{net:{kept:true}},exitHandlers,
    setInterval(callback,delay){assert.equal(delay,25);if(timerError)throw new Error('timer full');timers.set(++timer,callback);return timer;},
    clearInterval(value){timers.delete(value);}};
  vm.runInNewContext(source,context);
  return{api:context.px.net.mdns,calls,events,timers,kept:context.px.net.kept,
    pump(){for(const callback of [...timers.values()])callback();},exit(){for(const callback of exitHandlers)callback();},
    failStart(){startError=true;},failPoll(){pollError=true;},failTimer(){timerError=true;}};
}
{
  const f=fixture();assert(f.kept);assert.equal(f.timers.size,0);
  const one=f.api.discover('_http._tcp'),two=f.api.discover('_pixelbox._tcp',{timeoutMs:23});const failure=assert.rejects(two,/ENETDOWN/);
  assert.deepEqual(f.calls,[['discover','_http._tcp',3000],['discover','_pixelbox._tcp',23]]);assert.equal(f.timers.size,1);
  const services=[{name:'中文.设备',host:'box.local',ip:'192.0.2.1',port:8765,txt:{model:'AMOLED'}}];
  f.events.push({id:99,error:0,services:[]},{id:1,error:0,services},{id:2,error:-1,code:'ENETDOWN'});
  f.pump();assert.equal(await one,services);await failure;assert.equal(f.timers.size,0);
  const unsubscribe=f.api.advertise({name:'Box',service:'_http._tcp',port:80,txt:{x:'y'}});assert.equal(f.timers.size,0);
  unsubscribe();unsubscribe();assert.deepEqual(f.calls.slice(-2),[['advertise','Box','_http._tcp',80,{x:'y'}],['unadvertise',3]]);
  const late=f.api.advertise({service:'_http._tcp',port:81});f.exit();late();assert.equal(f.calls.at(-1)[0],'shutdown');
  assert.equal(f.calls.filter(item=>item[0]==='unadvertise').length,1);
}
{
  const f=fixture();f.failStart();await assert.rejects(f.api.discover('_http._tcp'),/start error/);assert.equal(f.timers.size,0);
  assert.throws(()=>f.api.advertise({service:'_http._tcp',port:80}),/start error/);
}
{
  const f=fixture();f.failTimer();await assert.rejects(f.api.discover('_http._tcp'),/timer full/);assert.equal(f.calls.length,0);
}
{
  const f=fixture(),pending=f.api.discover('_http._tcp');const failed=assert.rejects(pending,/poll error/);
  f.failPoll();f.pump();await failed;assert.equal(f.timers.size,0);f.exit();assert.equal(f.calls.filter(x=>x[0]==='shutdown').length,1);
  await assert.rejects(f.api.discover('_http._tcp'),/ECANCELED/);assert.throws(()=>f.api.advertise({}),/ECANCELED/);
}
{
  const f=fixture(),pending=f.api.discover('_http._tcp');const failed=assert.rejects(pending,/ECANCELED/);
  f.exit();f.exit();await failed;assert.equal(f.timers.size,0);f.events.push({id:1,error:0,services:[]});f.pump();
  assert.equal(f.calls.filter(x=>x[0]==='shutdown').length,1);
}
{
  const f=fixture();await assert.rejects(f.api.discover('_http._tcp',{get timeoutMs(){f.exit();return 10;}}),/ECANCELED/);
  assert.equal(f.calls.filter(x=>x[0]==='discover').length,0);
  const g=fixture();assert.throws(()=>g.api.advertise({get name(){g.exit();return 'Box';},service:'_http._tcp',port:80}),/ECANCELED/);
  assert.equal(g.calls.filter(x=>x[0]==='advertise').length,0);
}
console.log('mDNS prelude通过：Promise/默认3秒/Unsubscribe/并发/空闲timer/退出取消/重入getter/迟到事件');
