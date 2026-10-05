#!/usr/bin/env python3
"""真实QuickJS+POSIX+RFC6455与现有Node ws互通；独立临时目录，每命令限60秒。"""
from pathlib import Path
import argparse
import json
import os
import shlex
import subprocess
import tempfile

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('quickjs_library',type=Path)
    parser.add_argument('--sanitize',choices=('undefined','address,undefined'));args=parser.parse_args()
    project=Path(__file__).resolve().parents[1];library=args.quickjs_library.resolve();headers=library.parent/'generated/quickjs-ng'
    flags=['-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(project/'include'),'-I'+str(headers)]
    if args.sanitize:flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    with tempfile.TemporaryDirectory(prefix='pixelbox-ws-binding-') as temporary:
        build=Path(temporary);binary=build/'ws';script=build/'test.js';server_file=build/'server.cjs'
        server_file.write_text('const {WebSocketServer}=require('+json.dumps(str(project.parent/'sdk/node_modules/ws'))+');\n'+r"""
const http=require('http');const server=http.createServer();const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
  if(req.url==='/bad'){socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
wss.on('connection',(ws,req)=>{
  ws.on('error',()=>{});
  ws.on('message',(data,binary)=>{
    if(!binary&&data.toString()==='fragment'){ws.send(Buffer.from([0xe4,0xb8]),{binary:false,fin:false});ws.ping('p');ws.send(Buffer.from([0xad]),{fin:true});}
    else ws.send(data,{binary});
  });
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\n'));
process.on('SIGTERM',()=>{for(const client of wss.clients)client.terminate();server.close(()=>process.exit());});
""")
        sources=['src/net.c','src/net_binding.c','src/tls.c','src/ws.c','src/ws_binding.c','tests/test_ws_binding.c']
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),*flags,*[str(project/path) for path in sources],str(library),'-lm','-lpthread','-o',str(binary)],check=True,timeout=60)
        server=subprocess.Popen(['node',str(server_file)],stdout=subprocess.PIPE,text=True)
        try:
            port=int(server.stdout.readline().strip())
            setup=r"""
globalThis.testComplete=false;globalThis.testError=undefined;
const timers=new Map();let timerId=0;
globalThis.setTimeout=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:0});return id;};
globalThis.setInterval=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:Math.max(1,delay)});return id;};
globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
globalThis.testTick=()=>{for(const [id,item] of [...timers])if(item.at<=Date.now()&&timers.has(id)){if(item.interval)item.at=Date.now()+item.interval;else timers.delete(id);item.fn();}};
globalThis.console={error(){}};
globalThis.performance={now:()=>Date.now()};
globalThis.TextEncoder=class{encode(text){const value=unescape(encodeURIComponent(String(text)));return Uint8Array.from(value,c=>c.charCodeAt(0));}};
globalThis.TextDecoder=class{decode(input){const bytes=input instanceof Uint8Array?input:new Uint8Array(input);let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return decodeURIComponent(escape(raw));}};
globalThis.btoa=raw=>{const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let out='';for(let i=0;i<raw.length;i+=3){const n=(raw.charCodeAt(i)<<16)|((raw.charCodeAt(i+1)||0)<<8)|(raw.charCodeAt(i+2)||0);out+=chars[n>>>18]+chars[(n>>>12)&63]+(i+1<raw.length?chars[(n>>>6)&63]:'=')+(i+2<raw.length?chars[n&63]:'=');}return out;};
const g=globalThis,px={},exitHandlers=new Set(),unsupported=()=>{throw new Error('ENOTSUP');},rejected=()=>Promise.reject(new Error('ENOTSUP'));
const u8=value=>{if(value instanceof Uint8Array)return value;if(value instanceof ArrayBuffer)return new Uint8Array(value);throw new TypeError('binary');};
function assert(value,message='assertion failed'){if(!value)throw new Error(message);}
function throws(fn){let caught=false;try{fn();}catch(error){caught=true;}assert(caught,'expected exception');}
"""
            body=r"""
const nextMessage=ws=>new Promise((resolve,reject)=>{ws.onmessage=event=>resolve(event.data);ws.onerror=event=>reject(new Error(event.message));});
const open=path=>new Promise((resolve,reject)=>{const ws=new WebSocket(base+path);ws.onopen=()=>resolve(ws);ws.onerror=event=>reject(new Error(event.message));});
(async()=>{
  throws(()=>new WebSocket('http://bad'));throws(()=>new WebSocket(base,['a','a']));
  const ws=await open('/echo');ws.binaryType='arraybuffer';assert(ws.readyState===WebSocket.OPEN);
  let next=nextMessage(ws);ws.send('你好');assert(await next==='你好');
  next=nextMessage(ws);ws.send('fragment');assert(await next==='中');
  const bytes=new Uint8Array([9,0,255,8]);next=nextMessage(ws);ws.send(bytes.subarray(1,3));bytes.fill(3);
  assert([...new Uint8Array(await next)].join(',')==='0,255');
  const big=new Uint8Array(65536);big.fill(0x5a);next=nextMessage(ws);ws.send(big);throws(()=>ws.send('full'));big.fill(0);
  const echoed=new Uint8Array(await next);assert(echoed.length===65536&&echoed.every(value=>value===0x5a));
  await new Promise(resolve=>setTimeout(resolve,10));
  let count=0;const all=new Promise(resolve=>ws.onmessage=event=>{assert(event.data==='');if(++count===16)resolve();});
  for(let i=0;i<16;++i)ws.send('');throws(()=>ws.send(''));await all;
  throws(()=>ws.close(1005));throws(()=>ws.close(1000,'x'.repeat(124)));
  const closed=new Promise(resolve=>ws.onclose=resolve);ws.close(1000,'done');ws.close();const close=await closed;assert(close.code===1000&&close.reason==='done'&&ws.readyState===3);throws(()=>ws.send('late'));
  const bad=new WebSocket(base+'/bad');let errors=0;bad.onerror=()=>errors++;await new Promise(resolve=>bad.onclose=resolve);assert(errors===1&&bad.readyState===3);
  const secure=new WebSocket('wss://127.0.0.1:1/');secure.onerror=()=>{};await new Promise(resolve=>secure.onclose=resolve);assert(secure.readyState===3);
  const active=await open('/echo');let late=0;active.onclose=()=>late++;for(const callback of exitHandlers)callback();assert(active.readyState===3&&late===0);
})().then(()=>{globalThis.testComplete=true;},error=>{globalThis.testError=String(error)+'\n'+error.stack;globalThis.testComplete=true;});
"""
            script.write_text(setup+'\nconst lateEncoder=TextEncoder,lateDecoder=TextDecoder;delete globalThis.TextEncoder;delete globalThis.TextDecoder;\nconst base='+json.dumps(f'ws://127.0.0.1:{port}')+';\n'+
                '\n'.join((project/'src'/name).read_text() for name in ('prelude_net.js','prelude_http.js','prelude_ws.js'))+
                '\nglobalThis.TextEncoder=lateEncoder;globalThis.TextDecoder=lateDecoder;\n'+body)
            subprocess.run([str(binary),str(script)],check=True,timeout=60)
        finally:
            server.terminate();server.wait(timeout=10)
if __name__=='__main__':main()
