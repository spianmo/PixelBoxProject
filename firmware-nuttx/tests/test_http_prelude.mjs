// 真实回环TCP服务驱动HTTP解析，覆盖分片、帧边界、凭据、重定向与错误路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
const source=fs.readFileSync(new URL('../src/prelude_http.js',import.meta.url),'utf8');
const connections=new Set(),serverConnections=new Set();let backpressure=0,requests=0;
const tlsAttempts=[];
const px={net:{connectTcp:({host,port,tls})=>new Promise((resolve,reject)=>{
  if(tls){tlsAttempts.push({host,port});reject(new Error('ENOTSUP: test TCP adapter has no TLS'));return;}
  const socket=net.createConnection({host,port});connections.add(socket);
  const data=new Set(),errors=new Set(),closes=new Set();let queued=0;
  socket.on('data',buffer=>{const copy=Uint8Array.from(buffer).buffer;for(const fn of data)fn(copy);});
  socket.on('error',error=>{reject(error);for(const fn of errors)fn(error.message);});
  socket.on('close',()=>{connections.delete(socket);for(const fn of closes)fn();});
  const subscribe=(set,fn)=>{set.add(fn);return()=>set.delete(fn);};
  socket.on('connect',()=>resolve({send(bytes){
    if(bytes.length>65536-queued){++backpressure;throw new Error('ENOBUFS');}
    queued+=bytes.length;socket.write(bytes,()=>{queued-=bytes.length;});
  },close:()=>socket.destroy(),onData:fn=>subscribe(data,fn),onError:fn=>subscribe(errors,fn),onClose:fn=>subscribe(closes,fn)}));
})}};
const globals={};
new Function('px','g','u8',source)(px,globals,data=>data instanceof Uint8Array?data:new Uint8Array(data));
const fetch=globals.fetch;
let port=0;
const server=net.createServer(socket=>{
  serverConnections.add(socket);socket.on('close',()=>serverConnections.delete(socket));socket.on('error',()=>{});
  let received=Buffer.alloc(0),handled=false;
  socket.on('data',data=>{
    if(handled)return;received=Buffer.concat([received,data]);const end=received.indexOf('\r\n\r\n');if(end<0)return;
    const lines=received.subarray(0,end).toString().split('\r\n');
    const [method,path]=lines.shift().split(' '),headers={};
    for(const line of lines){const p=line.indexOf(':');headers[line.slice(0,p).toLowerCase()]=line.slice(p+1).trim();}
    const length=Number(headers['content-length']||0);if(received.length<end+4+length)return;
    const body=received.subarray(end+4,end+4+length);handled=true;++requests;
    const response=(status,body='',extra='')=>{const bytes=Buffer.from(body);socket.end('HTTP/1.1 '+status+'\r\nContent-Length: '+bytes.length+'\r\n'+extra+'\r\n'+bytes.toString());};
    if(path==='/length'){socket.write('HTTP/1.1 200 Custom Reason\r\nContent-Length: 11\r\n\r\nhello world');return;}
    if(path==='/json')return response('200 OK',JSON.stringify({text:'中文',method}),'Content-Type: application/json\r\n');
    if(path==='/echo')return response('200 OK',body);
    if(path==='/echo-headers')return response('200 OK',JSON.stringify({headers,method,body:body.toString()}));
    if(path==='/chunk') {
      const parts=['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r','\n4;foo=bar\r','\nWiki\r','\n5\r\npedia\r\n','0\r\nX-Test: trailer\r\n','\r\n'];
      let index=0;const timer=setInterval(()=>{socket.write(parts[index++]);if(index===parts.length){clearInterval(timer);socket.end();}},2);
      socket.on('close',()=>clearInterval(timer));return;
    }
    if(path==='/close')return socket.end('HTTP/1.0 200 OK\r\n\r\nclosed body');
    if(path==='/head')return socket.end('HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n');
    if(path==='/204')return socket.end('HTTP/1.1 204 No Content\r\n\r\n');
    if(path==='/interim')return socket.end('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    if(path==='/truncated')return socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort');
    if(path==='/badchunk')return socket.end('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\n');
    if(path==='/ambiguous')return socket.end('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n');
    if(path==='/huge')return socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2097153\r\n\r\n');
    if(path==='/gzip')return socket.end('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n');
    if(path==='/slow')return;
    if(path==='/redirect')return response('302 Found','','Location: ./json\r\n');
    if(path==='/redirect-cross')return response('302 Found','','Location: http://localhost:'+port+'/echo-headers\r\n');
    if(path==='/307')return response('307 Temporary Redirect','','Location: /echo-headers\r\n');
    if(path==='/loop')return response('302 Found','','Location: /loop\r\n');
    if(path==='/secure')return response('302 Found','','Location: https://example.invalid/\r\n');
    return response('404 Not Found','missing');
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;
const base='http://127.0.0.1:'+port;
try {
  let response=await fetch(base+'/length');assert.equal(response.status,200);assert.equal(response.ok,true);assert.equal(response.statusText,'Custom Reason');
  assert.equal(await response.text(),'hello world');assert.equal(await response.arrayBuffer(),await response.arrayBuffer());
  assert.throws(()=>{response.status=999;},TypeError);
  assert.equal(await(await fetch(base+'/chunk')).text(),'Wikipedia');
  assert.equal(await(await fetch(base+'/close')).text(),'closed body');
  assert.equal(await(await fetch(base+'/head',{method:'HEAD'})).text(),'');
  assert.equal(await(await fetch(base+'/204')).text(),'');
  assert.equal(await(await fetch(base+'/interim')).text(),'ok');
  assert.deepEqual(await(await fetch(base+'/redirect')).json(),{text:'中文',method:'GET'});
  response=await fetch(base+'/missing');assert.equal(response.status,404);assert.equal(response.ok,false);
  const secret={Authorization:'Bearer secret',Cookie:'secret=1'};
  const cross=await(await fetch(base+'/redirect-cross',{method:'POST',headers:secret,body:'private'})).json();
  assert.equal(cross.headers.authorization,undefined);assert.equal(cross.headers.cookie,undefined);assert.equal(cross.method,'GET');assert.equal(cross.body,'');
  const kept=await(await fetch(base+'/307',{method:'POST',headers:secret,body:'same origin'})).json();
  assert.equal(kept.headers.authorization,'Bearer secret');assert.equal(kept.method,'POST');assert.equal(kept.body,'same origin');
  const upload='x'.repeat(200000);assert.equal(await(await fetch(base+'/echo',{method:'POST',body:upload})).text(),upload);assert(backpressure>0);
  for(const [path,pattern] of [['truncated',/truncated/],['badchunk',/chunk size/],['ambiguous',/framing/],['huge',/2MiB/],['gzip',/ENOTSUP/],['loop',/redirect limit/],['secure',/ENOTSUP/]])
    await assert.rejects(fetch(base+'/'+path),pattern);
  await assert.rejects(fetch(base+'/slow',{timeoutMs:30}),/ETIMEDOUT/);
  await assert.rejects(fetch(base+'/redirect',{redirect:'error'}),/redirect rejected/);
  const before=requests;
  await assert.rejects(fetch('https://example.invalid/'),/ENOTSUP/);
  assert.deepEqual(tlsAttempts.at(-1),{host:'example.invalid',port:443});
  await assert.rejects(fetch('https://example.invalid:8443/'),/ENOTSUP/);
  assert.deepEqual(tlsAttempts.at(-1),{host:'example.invalid',port:8443});
  await assert.rejects(fetch(base+'/json',{headers:{'X-Test':'bad\r\nInjected: value'}}),/header/);
  await assert.rejects(fetch(base+'/json',{headers:{'Content-Length':'2'}}),/controls header/);
  await assert.rejects(fetch(base+'/json',{method:'TRACE'}),/method/);
  await assert.rejects(fetch(base+'/json',{body:new Uint8Array(2097153)}),/2MiB/);
  assert.equal(requests,before);
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(connections.size,0);
  console.log('HTTP真实回环通过：长度/chunked/关闭分帧、UTF-8、HEAD/204/100、2MiB上限、上传背压、超时、截断拒绝、重定向/凭据隔离、TLS拒绝');
} finally {
  for(const socket of connections)socket.destroy();for(const socket of serverConnections)socket.destroy();
  await new Promise(resolve=>server.close(resolve));
}
