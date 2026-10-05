#!/usr/bin/env python3
"""借用已有QuickJS静态库，独立验证system绑定；每命令限60秒。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile

SCRIPT = r'''
function assert(value,message='assertion failed'){if(!value)throw new Error(message);}
function throws(callback,pattern){let error=null;try{callback();}catch(caught){error=caught;}assert(error&&(!pattern||pattern.test(String(error))),'expected exception '+pattern);}
const api=native.systemNet;
assert(gc()===1); assert(api.poll()===null); assert(api.temperature()===42.125);
for(const value of [undefined,null]){api.start(value);assert(stats().server==='pool.ntp.org'&&stats().timeout===15000);assert(api.poll().error===0);}
api.start({toString(){return 'time.test';}},37);assert(stats().server==='time.test'&&stats().timeout===37);api.poll();
api.start(123);assert(stats().server==='123');api.poll();
for(const value of ['', 'a\u0000b', 'a'.repeat(256)])throws(()=>api.start(value));
for(const value of [0,-1,NaN,Infinity,1.5,120001])throws(()=>api.start('host',value));
for(const value of [0,-1,NaN,Infinity,1.5,4294967296])throws(()=>api.cancel(value));
throws(()=>api.cancel());
Object.defineProperty(Object.prototype,'id',{set(){throw new Error('inherited setter');},configurable:true});
const id=api.start.call({foreign:true},'failed');const result=api.poll.call({foreign:true});
delete Object.prototype.id;assert(result.id===id&&result.code==='ETIMEDOUT'&&result.error<0);
const cancelId=api.start('host');api.cancel(cancelId);assert(api.poll().code==='ECANCELED');
Object.defineProperty(Object.prototype,'systemNet',{set(){throw new Error('inherited install');},configurable:true});
Object.defineProperty(Object.prototype,'start',{set(){throw new Error('inherited method');},configurable:true});
let temporary=makeSystem();delete Object.prototype.systemNet;delete Object.prototype.start;
temporary.start('host');temporary=null;assert(gc()===1,'owner/function cycle leaked');
for(let i=0;i<30;++i){let item=makeSystem();item.start('host');item=null;}assert(gc()===1);
const duringString=makeSystem();let before=stats().starts;
throws(()=>duringString.start({toString(){duringString.shutdown();return 'host';}}),/ECANCELED/);
assert(stats().starts===before);
const duringTimeout=makeSystem();
throws(()=>duringTimeout.start('host',{valueOf(){duringTimeout.shutdown();return 100;}}),/ECANCELED/);
assert(stats().starts===before);
const duringCancel=makeSystem();const cancel= duringCancel.start('host');
throws(()=>duringCancel.cancel({valueOf(){duringCancel.shutdown();return cancel;}}),/ECANCELED/);
api.shutdown();api.shutdown();throws(()=>api.poll(),/ECANCELED/);throws(()=>api.temperature(),/ECANCELED/);throws(()=>api.start(),/ECANCELED/);
assert(gc()===0);let finalOwner=makeSystem();finalOwner.start('host');
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
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-I' + str(project / 'include'), '-I' + str(headers)]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    cc = shlex.split(os.environ.get('CC', 'cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-system-binding-') as temporary:
        directory = Path(temporary); script = directory / 'test.js'; executable = directory / 'test'
        script.write_text(SCRIPT)
        subprocess.run([*cc, *flags, str(project / 'src/system_net_binding.c'), str(project / 'tests/test_system_net_binding.c'), str(library), '-lpthread', '-lm', '-o', str(executable)], check=True, timeout=60)
        subprocess.run([str(executable), str(script)], check=True, timeout=60)

if __name__ == '__main__':
    main()
