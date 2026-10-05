#!/usr/bin/env python3
"""借用已有QuickJS静态库在独立临时目录测试网络FFI；每命令最多60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library',type=Path)
    parser.add_argument('--sanitize',choices=('undefined','address,undefined'))
    args=parser.parse_args();project=Path(__file__).resolve().parents[1]
    library=args.quickjs_library.resolve();headers=library.parent/'generated/quickjs-ng'
    assert library.is_file() and (headers/'quickjs.h').is_file()
    flags=['-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror']
    if args.sanitize:flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    compiler=shlex.split(os.environ.get('CC','cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-net-binding-') as temporary:
        directory=Path(temporary);executable=directory/'binding';script=directory/'binding.js'
        script.write_text(r"""
function assert(value,message='assertion failed'){if(!value)throw new Error(message);}
function throws(callback){let caught=false;try{callback();}catch(error){caught=true;}assert(caught,'expected exception');}
function waitFor(callback){const deadline=Date.now()+2500;while(Date.now()<deadline){let event=native.net.poll();if(event&&callback(event))return;pause();}throw new Error('network event timeout');}
const baseline=gc(),net=native.net;
const server=net.listen(0),client=net.connect('127.0.0.1',server.port,false,1000);
let connected=false,accepted=0;
waitFor(event=>{if(event.id===client&&event.type===1)connected=true;if(event.id===server.id&&event.type===2)accepted=event.acceptedId;return connected&&accepted;});
const padded=new Uint8Array([9,8,0,255,127,6,5]);net.send(client,padded.subarray(2,5));padded.fill(3);
waitFor(event=>{if(event.type!==3)return false;assert(event.id===accepted);assert([...new Uint8Array(event.data)].join(',')==='0,255,127','typed array slice copy');return true;});
net.send(accepted,'中文');
waitFor(event=>{if(event.type!==3)return false;assert(event.id===client);assert([...new Uint8Array(event.data)].join(',')==='228,184,173,230,150,135','UTF-8');return true;});
for(const data of [null,12,{},new Uint16Array(4)])throws(()=>net.send(client,data));
for(const port of [NaN,-1,0,1.5,65536,Infinity])throws(()=>net.connect('localhost',port,false,1000));
for(const host of ['',{},'bad\u0000host','http://example.test','host name'])throws(()=>net.connect(host,80,false,1000));
throws(()=>net.connect('localhost',80,true,1000));
throws(()=>net.connect('localhost',80,false,0));throws(()=>net.send(0,'bad'));
Object.defineProperty(Object.prototype,'id',{set(){throw new Error('inherited setter');},configurable:true});
const udp=net.udp.call({foreign:true},0);delete Object.prototype.id;
net.send(udp.id,new Uint8Array([1,0,255]).buffer,'127.0.0.1',udp.port);
waitFor(event=>{if(event.type!==4)return false;assert(event.id===udp.id&&event.port===udp.port&&event.host==='127.0.0.1');assert([...new Uint8Array(event.data)].join(',')==='1,0,255');return true;});
net.send(udp.id,new ArrayBuffer(0),'127.0.0.1',udp.port);
waitFor(event=>{if(event.type!==4)return false;assert(event.data instanceof ArrayBuffer&&event.data.byteLength===0);return true;});
net.close(client);net.close(client);net.close(accepted);net.close(server.id);net.close(udp.id);
const closed=new Set();waitFor(event=>{if(event.type===5)closed.add(event.id);return closed.size===4;});
assert(gc()===baseline,'closed sockets leaked');
Object.defineProperty(Object.prototype,'net',{set(){throw new Error('native install inherited setter');},configurable:true});
Object.defineProperty(Object.prototype,'poll',{set(){throw new Error('method install inherited setter');},configurable:true});
let fresh=makeNetwork();delete Object.prototype.net;delete Object.prototype.poll;
fresh.udp(0);fresh=null;assert(gc()===baseline,'native owner/function cycle leaked fd');
for(let i=0;i<20;++i){let owner=makeNetwork();owner.listen(0);owner.udp(0);owner=null;}
assert(gc()===baseline,'repeated native network GC leaked fd');
const isolated=makeNetwork();const id=isolated.udp(0).id;
throws(()=>isolated.send({valueOf(){isolated.shutdown();return id;}},new Uint8Array([1]),'localhost',80));
isolated.shutdown();throws(()=>isolated.poll());
net.shutdown();net.shutdown();throws(()=>net.udp(0));throws(()=>net.poll());
assert(gc()===baseline);
// runtime最终清理必须关闭仍活跃的socket，不依赖显式shutdown。
let owned=makeNetwork();owned.listen(0);owned.udp(0);
""")
        def run(command):subprocess.run(command,check=True,timeout=60)
        sources=[project/'src/net.c',project/'src/tls.c',project/'src/net_binding.c',project/'tests/test_net_binding.c']
        run([*compiler,*flags,'-I'+str(project/'include'),'-I'+str(headers),*map(str,sources),str(library),'-lm','-lpthread','-o',str(executable)])
        run([str(executable),str(script)])

if __name__=='__main__':main()
