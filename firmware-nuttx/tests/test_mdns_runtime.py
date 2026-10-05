#!/usr/bin/env python3
"""真实QuickJS与独立DNS编码/解码UDP对端验证mDNS完整调用链。"""
from pathlib import Path
import argparse
import os
import shlex
import socket
import struct
import subprocess
import tempfile
import threading

PREFIX = r'''
const timers=new Map(),exitHandlers=new Set(),px={net:{}};let timerId=0;
function setInterval(callback){timers.set(++timerId,callback);return timerId;}
function clearInterval(id){timers.delete(id);}
function assert(value,message){if(!value)throw new Error(message||'assertion failed');}
function delay(ms){return new Promise(resolve=>{const end=Date.now()+ms;const id=setInterval(()=>{if(Date.now()>=end){clearInterval(id);resolve();}});});}
globalThis.done=false;
'''
SUFFIX = r'''
(async()=>{
  const found=await px.net.mdns.discover('_http._tcp',{timeoutMs:250});
  assert(found.length===1,'discovery count');const service=found[0];
  assert(service.name==='Peer Camera'&&service.host==='camera-peer.local'&&service.ip==='10.20.30.40'&&service.port===8080,'discovery fields');
  assert(service.txt.path==='/camera'&&service.txt.empty==='','TXT fields');
  const remove=px.net.mdns.advertise({name:'JS Board',service:'_http._tcp',port:8123,txt:{unicode:'中文',path:'/app'}});
  await delay(1300);remove();remove();await delay(100);
  let cancelled=false;const pending=px.net.mdns.discover('_nothing._tcp',{timeoutMs:3000}).catch(error=>{cancelled=/ECANCELED/.test(String(error));});
  for(const handler of exitHandlers)handler();await pending;assert(cancelled,'exit cancellation');
  assert(timers.size===0,'timer cleanup');globalThis.done=true;
})().catch(error=>{globalThis.failure=String(error)+'\n'+error.stack;});
'''


def dns_name(text):
    return b''.join(bytes([len(label.encode())]) + label.encode() for label in text.split('.')) + b'\0'


def response():
    instance, host = 'Peer Camera._http._tcp.local', 'camera-peer.local'
    records = [('_http._tcp.local', 12, dns_name(instance)),
               (instance, 33, struct.pack('!HHH', 0, 0, 8080) + dns_name(host)),
               (instance, 16, b'\x0cpath=/camera\x06empty='),
               (host, 1, bytes([10, 20, 30, 40]))]
    return struct.pack('!6H', 0, 0x8400, 0, len(records), 0, 0) + b''.join(
        dns_name(name) + struct.pack('!HHIH', kind, 1 if kind == 12 else 0x8001, 120, len(data)) + data
        for name, kind, data in records)


def decode_name(packet, offset):
    labels, end, seen = [], None, set()
    while True:
        if offset in seen or offset >= len(packet):
            raise AssertionError('invalid DNS name')
        seen.add(offset)
        size = packet[offset]
        if size & 0xc0 == 0xc0:
            if end is None:
                end = offset + 2
            offset = ((size & 63) << 8) | packet[offset + 1]
            continue
        offset += 1
        if size == 0:
            return '.'.join(labels), end if end is not None else offset
        assert size <= 63 and offset + size <= len(packet)
        labels.append(packet[offset:offset + size].decode())
        offset += size


def decode(packet):
    _, flags, qd, an, ns, ar = struct.unpack_from('!6H', packet)
    offset, questions, records = 12, [], []
    for _ in range(qd):
        name, offset = decode_name(packet, offset)
        kind, klass = struct.unpack_from('!HH', packet, offset); offset += 4
        questions.append((name, kind, klass))
    for _ in range(an + ns + ar):
        name, offset = decode_name(packet, offset)
        kind, klass, ttl, length = struct.unpack_from('!HHIH', packet, offset); offset += 10
        end = offset + length; assert end <= len(packet)
        value = packet[offset:end]
        if kind == 12:
            value, parsed_end = decode_name(packet, offset); assert parsed_end == end
        elif kind == 33:
            priority, weight, port = struct.unpack_from('!HHH', packet, offset)
            target, parsed_end = decode_name(packet, offset + 6); assert parsed_end == end
            value = (priority, weight, port, target)
        records.append((name, kind, klass, ttl, value)); offset = end
    assert offset == len(packet)
    return flags, questions, records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve(); headers = library.parent / 'generated/quickjs-ng'
    peer = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); peer.bind(('127.0.0.1', 0)); peer.settimeout(.05)
    reservation = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); reservation.bind(('127.0.0.1', 0))
    listen_port = reservation.getsockname()[1]; reservation.close()
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
             '-DPX_MDNS_GROUP="127.0.0.1"', f'-DPX_MDNS_PORT={peer.getsockname()[1]}', f'-DPX_MDNS_BIND_PORT={listen_port}',
             '-I' + str(project / 'include'), '-I' + str(headers)]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    stopped = threading.Event(); observed, failures = [], []

    def server():
        try:
            while not stopped.is_set():
                try:
                    data, source = peer.recvfrom(4096)
                except socket.timeout:
                    continue
                message_flags, questions, records = decode(data)
                observed.extend((message_flags, *record) for record in records)
                if not message_flags & 0x8000 and any(name == '_http._tcp.local' and kind == 12 for name, kind, _ in questions):
                    peer.sendto(response(), source)
        except BaseException as error:
            failures.append(error)

    cc = shlex.split(os.environ.get('CC', 'cc'))
    with tempfile.TemporaryDirectory(prefix='pixelbox-mdns-runtime-') as temporary:
        directory = Path(temporary); script = directory / 'test.js'; binary = directory / 'test'
        script.write_text(PREFIX + (project / 'src/prelude_mdns.js').read_text() + SUFFIX)
        subprocess.run([*cc, *flags, str(project / 'src/mdns.c'), str(project / 'src/mdns_binding.c'),
                        str(project / 'tests/test_mdns_runtime.c'), str(library), '-lpthread', '-lm', '-o', str(binary)], check=True, timeout=60)
        thread = threading.Thread(target=server); thread.start()
        try:
            subprocess.run([str(binary), str(script)], check=True, timeout=60)
        finally:
            stopped.set(); thread.join(timeout=1); peer.close()
            assert not thread.is_alive() and not failures, failures
    ptr = [(ttl, value) for flags, _, kind, _, ttl, value in observed if flags & 0x8000 and kind == 12]
    assert (120, 'JS Board._http._tcp.local') in ptr and (0, 'JS Board._http._tcp.local') in ptr
    assert (120, 'Runtime Devd._pixelbox._tcp.local') in ptr and (0, 'Runtime Devd._pixelbox._tcp.local') in ptr
    assert any(name == 'JS Board._http._tcp.local' and kind == 33 and klass == 0x8001 and value[2:] == (8123, 'runtime-box.local')
               for flags, name, kind, klass, ttl, value in observed if flags & 0x8000 and ttl)
    assert any(name == 'Runtime Devd._pixelbox._tcp.local' and kind == 16 and b'fw=P11-test' in value and b'app=demo.app' in value
               for flags, name, kind, klass, ttl, value in observed if flags & 0x8000 and ttl)
    print('独立DNS协议对端通过：JS发现字段与TXT、JS广播/SRV/UTF8 TXT/goodbye、devd元数据与跨VM广播')


if __name__ == '__main__':
    main()
