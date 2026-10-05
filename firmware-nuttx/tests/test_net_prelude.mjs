/* 用可控事件源复现关闭、回调重入及退出时序；真实socket另由C/QuickJS测试验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/prelude_net.js',import.meta.url),'utf8');
function fixture(){
  const events=[],calls=[],timers=new Map(),errors=[],exitHandlers=new Set();
  let id=0,timer=0,pollError=null,queued=0;
  const network={connect(...args){calls.push(['connect',...args]);return ++id;},
    listen(port){calls.push(['listen',port]);return {id:++id,port:port||32123};},
    udp(port){calls.push(['udp',port]);return {id:++id,port:port||32124};},
    send(...args){calls.push(['send',...args]);},close(value){calls.push(['close',value]);},
    queued(value){calls.push(['queued',value]);return queued;},
    poll(){if(pollError)throw pollError;return events.shift()||null;},shutdown(){calls.push(['shutdown']);}};
  const context={px:{},native:{net:network,hostname:'test-board'},exitHandlers,
    rejected:()=>Promise.reject(new Error('ENOTSUP')),unsupported:()=>{throw new Error('ENOTSUP');},
    console:{error(...args){errors.push(args);}},setInterval(fn,delay){assert.equal(delay,5);timers.set(++timer,fn);return timer;},
    clearInterval(value){timers.delete(value);}};
  vm.runInNewContext(source,context);
  return {net:context.px.net,events,calls,timers,errors,exitHandlers,
    pump(){for(const callback of [...timers.values()])callback();},
    fail(){pollError=new Error('poll failed');},id(){return id;},setQueued(value){queued=value;}};
}
{
  const f=fixture();let resolved=false;
  const promise=f.net.connectTcp({host:'localhost',port:1234}).then(value=>{resolved=true;return value;});
  await Promise.resolve();assert.equal(resolved,false);assert.equal(f.timers.size,1);
  assert.deepEqual(f.calls[0],['connect','localhost',1234,false,10000]);
  f.events.push({id:1,type:1});f.pump();const socket=await promise;
  assert.equal(socket.connected,true);assert.equal(socket.remoteHost,'localhost');assert.equal(socket.remotePort,1234);
  f.setQueued(1234);assert.equal(socket.bufferedAmount,1234);
  assert(f.calls.some(value=>value[0]==='queued'&&value[1]===1));
  let received=0,closed=0;const buffer=new Uint8Array([0,255]).buffer;
  const unsubscribe=socket.onData(data=>{assert.equal(data,buffer);received++;});
  socket.onData(()=>{throw new Error('callback failure');});
  socket.onClose(()=>closed++);assert.throws(()=>socket.onData(null));
  f.events.push({id:1,type:3,data:buffer});f.pump();assert.equal(received,1);assert.equal(f.errors.length,1);
  unsubscribe();unsubscribe();f.events.push({id:1,type:3,data:buffer});f.pump();assert.equal(received,1);
  socket.send('hello');socket.close();socket.close();assert.equal(socket.connected,false);assert.throws(()=>socket.send('late'));
  assert.equal(socket.bufferedAmount,0);
  assert.equal(f.calls.filter(value=>value[0]==='close').length,1);
  f.events.push({id:1,type:5,error:0},{id:1,type:5,error:0});f.pump();assert.equal(closed,1);assert.equal(f.timers.size,0);
  socket.close();assert.equal(f.calls.filter(value=>value[0]==='close').length,1);
}
{
  const f=fixture(),promise=f.net.connectTcp({host:'bad.invalid',port:80,timeoutMs:35});
  const rejected=assert.rejects(promise,/connection failed.*-110/);
  f.events.push({id:1,type:5,error:-110});f.pump();await rejected;assert.equal(f.timers.size,0);
  await assert.rejects(f.net.connectTcp(null),/needs options/);
}
{
  const f=fixture();let accepted=null,calls=0;
  const server=f.net.listenTcp({port:0,onConnection(value){accepted=value;calls++;}});
  assert.equal(server.port,32123);f.events.push({id:1,type:2,acceptedId:50,host:'127.0.0.1',port:4567});f.pump();
  assert.equal(accepted.connected,true);assert.equal(accepted.remotePort,4567);
  server.close();server.close();f.events.push({id:1,type:2,acceptedId:51},{id:1,type:5,error:0});f.pump();
  assert.equal(calls,1);assert(f.calls.some(value=>value[0]==='close'&&value[1]===51));
  f.events.push({id:999,type:2,acceptedId:52});f.pump();assert(f.calls.some(value=>value[0]==='close'&&value[1]===52));
  accepted.close();f.events.push({id:50,type:5,error:0});f.pump();assert.equal(f.timers.size,0);
}
{
  const f=fixture(),socket=f.net.createUdp();let messages=0;
  socket.onMessage(message=>{assert.equal(message.host,'127.0.0.1');assert.equal(message.data.byteLength,0);messages++;});
  f.events.push({id:1,type:4,data:new ArrayBuffer(0),host:'127.0.0.1',port:1234});f.pump();assert.equal(messages,1);
  socket.send(new Uint8Array([1]),'localhost',1234);socket.close();socket.close();
  f.events.push({id:1,type:4,data:new ArrayBuffer(0),host:'127.0.0.1',port:1234},{id:1,type:5,error:0});f.pump();
  assert.equal(messages,1);assert.throws(()=>socket.send('late','localhost',1234));assert.equal(f.timers.size,0);
}
{
  const f=fixture(),promise=f.net.connectTcp({host:'localhost',port:1});
  f.events.push({id:1,type:1});f.pump();const socket=await promise;let closed=0,errors=0;
  socket.onClose(()=>{closed++;assert.throws(()=>f.net.createUdp(),/ECANCELED/);});socket.onError(()=>errors++);
  const waiting=f.net.connectTcp({host:'localhost',port:2});const rejected=assert.rejects(waiting,/poll failed/);
  f.fail();f.pump();await rejected;
  assert.equal(socket.connected,false);assert.equal(closed,1);assert.equal(errors,1);assert.equal(f.timers.size,0);
  assert.equal(f.calls.filter(value=>value[0]==='shutdown').length,1);socket.close();
}
{
  const f=fixture(),promise=f.net.connectTcp({host:'localhost',port:1});
  f.events.push({id:1,type:1});f.pump();const socket=await promise;let callbacks=0;
  socket.onClose(()=>callbacks++);const udp=f.net.createUdp();
  for(const callback of f.exitHandlers)callback();
  assert.equal(socket.connected,false);assert.equal(callbacks,0);assert.equal(f.timers.size,0);
  socket.close();udp.close();assert.throws(()=>udp.send('late','localhost',1234));
  await assert.rejects(f.net.connectTcp({host:'localhost',port:1}),/ECANCELED/);
}
console.log('网络prelude通过：Promise/订阅/accept/UDP、关闭幂等、迟到accept回收、回调异常隔离、poll失败重入保护、VM退出失效');
