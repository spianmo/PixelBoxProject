#!/usr/bin/env python3
"""已有QuickJS静态库下验证mDNS绑定，单个子进程上限60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile

SCRIPT = r'''
function assert(value,message='assertion failed'){if(!value)throw new Error(message);}
function throws(callback,pattern){let error=null;try{callback();}catch(caught){error=caught;}assert(error&&(!pattern||pattern.test(String(error))),'expected exception '+pattern);}
const api=native.mdns;
assert(gc()===1);assert(api.poll()===null);
const id=api.discover('_http._tcp');assert(stats().timeout===3000);let event=api.poll();
assert(event.id===id&&event.error===0&&event.services.length===1);
let service=event.services[0];assert(service.name==='中文.设备'&&service.host==='pixelbox.local'&&service.ip==='192.0.2.1'&&service.port===8765);
assert(service.txt.a==='b'&&service.txt.flag===''&&service.txt.__proto__==='x'&&Object.getPrototypeOf(service.txt)===Object.prototype);
api.discover({toString(){return '_http._tcp';}},17);assert(stats().timeout===17);api.poll();
for(const value of ['', 'x\0y','a'.repeat(23)])throws(()=>api.discover(value));
for(const value of [0,-1,NaN,Infinity,1.1,120001])throws(()=>api.discover('_http._tcp',value));
for(const value of [0,-1,NaN,Infinity,1.1,4294967296])throws(()=>api.cancel(value));
throws(()=>api.cancel());
for(const value of [0,-1,65536,1.1,NaN])throws(()=>api.advertise('Box','_http._tcp',value));
for(const name of ['', 'x\0y','x'.repeat(64)])throws(()=>api.advertise(name,'_http._tcp',80));
for(const txt of [3, {'': 'empty'}, {'a=b':'bad'}, {'x\0y':'bad'}, {x:'a'.repeat(254)}, {a:'x'.repeat(250),b:'y'.repeat(250),c:'z'.repeat(5)}])throws(()=>api.advertise('Box','_http._tcp',80,txt));
api.advertise('中文.设备','_http._tcp',80,{a:1, flag:''});assert(stats().txt==='\x03a=1\x05flag=');
Object.defineProperty(Object.prototype,'id',{set(){throw new Error('inherited result');},configurable:true});
const failed=api.discover.call({foreign:true},'_fail._tcp');event=api.poll.call(null);delete Object.prototype.id;
assert(event.id===failed&&event.code==='ENETDOWN'&&event.error<0);
const cancelled=api.discover('_http._tcp');api.cancel(cancelled);assert(api.poll().code==='ECANCELED');
Object.defineProperty(Object.prototype,'mdns',{set(){throw new Error('inherited install');},configurable:true});
Object.defineProperty(Object.prototype,'advertise',{set(){throw new Error('inherited method');},configurable:true});
let other=makeMdns();delete Object.prototype.mdns;delete Object.prototype.advertise;
other.advertise('Box','_http._tcp',80);other=null;assert(gc()===1);
for(let i=0;i<30;++i){let item=makeMdns();item.discover('_http._tcp');item=null;}assert(gc()===1,'owner/function cycle leaked');
let before=stats().discoveries;const stringOwner=makeMdns();
throws(()=>stringOwner.discover({toString(){stringOwner.shutdown();return '_http._tcp';}}),/ECANCELED/);assert(stats().discoveries===before);
const timeoutOwner=makeMdns();throws(()=>timeoutOwner.discover('_http._tcp',{valueOf(){timeoutOwner.shutdown();return 10;}}),/ECANCELED/);
assert(stats().discoveries===before);
const txtOwner=makeMdns();before=stats().advertisements;
throws(()=>txtOwner.advertise('Box','_http._tcp',80,{get x(){txtOwner.shutdown();return 'y';}}),/ECANCELED/);assert(stats().advertisements===before);
const keyOwner=makeMdns();throws(()=>keyOwner.advertise({toString(){keyOwner.shutdown();return 'Box';}},'_http._tcp',80),/ECANCELED/);
const removal=makeMdns(), removalId=removal.advertise('Box','_http._tcp',80);
throws(()=>removal.unadvertise({valueOf(){removal.shutdown();return removalId;}}),/ECANCELED/);
api.shutdown();api.shutdown();throws(()=>api.poll(),/ECANCELED/);throws(()=>api.discover('_http._tcp'),/ECANCELED/);
assert(gc()===0);let finalOwner=makeMdns();finalOwner.discover('_http._tcp');
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve()
    headers = library.parent / 'generated/quickjs-ng'
    assert library.is_file() and (headers / 'quickjs.h').is_file()
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
             '-I' + str(project / 'include'), '-I' + str(headers)]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    cc = shlex.split(os.environ.get('CC', 'cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-mdns-binding-') as temporary:
        directory = Path(temporary); script = directory / 'test.js'; executable = directory / 'test'
        script.write_text(SCRIPT)
        subprocess.run([*cc, *flags, str(project / 'src/mdns_binding.c'), str(project / 'tests/test_mdns_binding.c'),
                        str(library), '-lpthread', '-lm', '-o', str(executable)], check=True, timeout=60)
        subprocess.run([str(executable), str(script)], check=True, timeout=60)


if __name__ == '__main__':
    main()
