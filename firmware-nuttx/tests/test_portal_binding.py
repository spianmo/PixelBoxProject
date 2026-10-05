#!/usr/bin/env python3
"""真实 QuickJS 验证门户 C/JS 绑定和跨 VM 的 service 请求契约。"""
from pathlib import Path
import argparse
import os
import shlex
import subprocess
import tempfile

PREFIX = '''
const px={wifi:{}};
function assert(value,message='assertion failed'){if(!value)throw new Error(message);}
function throws(callback,pattern){let e;try{callback();}catch(error){e=error;}assert(e&&pattern.test(String(e)),'missing error '+pattern);}
'''
SCRIPT = '''
const api=px.wifi.portal;
assert(Object.isFrozen(api));
const status=api.status();
assert(status.phase==='waiting'&&status.active&&status.wifiOwned&&status.generation===3);
assert(status.ssid==='Finger'&&status.ip==='192.168.31.100'&&status.apSsid==='PixelBox-ABCD');
assert(!JSON.stringify(status).includes('not-exposed')&&!('apPassword' in status));
let before=inspect();assert(api.start()===undefined);assert(inspect().starts===before.starts+1);
throws(()=>api.start(),/EBUSY/);api.stop();api.stop();assert(!inspect().requested);
for(const key of ['phase','active','wifiPortal','start'])Object.defineProperty(Object.prototype,key,{set(){throw new Error('prototype setter');},configurable:true});
const other=reinstall();assert(other.wifiPortal.status().phase==='waiting');
for(const key of ['phase','active','wifiPortal','start'])delete Object.prototype[key];
control(false);throws(()=>api.start(),/ENODEV/);throws(()=>api.stop(),/ENODEV/);throws(()=>api.status(),/ENODEV/);
control(true);other.wifiPortal.start.call(null);assert(inspect().requested);
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]; library = args.quickjs_library.resolve()
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
             '-I' + str(project / 'include'), '-I' + str(library.parent / 'generated/quickjs-ng')]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    with tempfile.TemporaryDirectory(prefix='pixelbox-portal-binding-') as directory:
        root = Path(directory); binary = root / 'test'; script = root / 'test.js'
        script.write_text(PREFIX + (project / 'src/prelude_portal.js').read_text() + SCRIPT)
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags, str(project / 'src/portal_binding.c'),
                        str(project / 'tests/test_portal_binding.c'), str(library), '-lpthread', '-lm', '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary), str(script)], check=True, timeout=60)


if __name__ == '__main__':
    main()
