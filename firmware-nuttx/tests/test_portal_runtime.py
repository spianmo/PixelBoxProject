#!/usr/bin/env python3
"""真实 TCP/QuickJS 门户回归；Wi-Fi、DHCP 桩可故障注入，不操作电脑网络或真机。"""
from pathlib import Path
import argparse
from http.client import HTTPConnection
import json
import os
import select
import shlex
import socket
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    parser.add_argument('--stack-probe-log', type=Path,
                        help='启用生产controller栈大小的宿主guard/sentinel测量，并增加JSON/扫描压力用例')
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve()
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-DPX_PORTAL_HOST_TEST',
             '-DPX_PORTAL_BIND_ADDRESS="127.0.0.1"', '-DPX_PORTAL_SUCCESS_MS=500',
             '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-I' + str(project / 'include'),
             '-I' + str(library.parent / 'generated/quickjs-ng')]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    extra_sources = []
    environment = dict(os.environ)
    if args.stack_probe_log:
        flags += ['-DPX_PORTAL_STACK_PROBE', '-D_DEFAULT_SOURCE', '-D_DARWIN_C_SOURCE']
        extra_sources.append(str(project / 'tests/portal_stack_probe.c'))
        environment['PX_PORTAL_STACK_LOG'] = str(args.stack_probe_log.resolve())
    cc = shlex.split(os.environ.get('CC', 'cc'))
    subprocess.run(['python3', str(project / 'scripts/embed_portal.py'), '--check'], check=True, timeout=60)
    with tempfile.TemporaryDirectory(prefix='pixelbox-portal-') as directory:
        root = Path(directory); executable = root / 'portal'; credentials = root / 'wifi.json'
        old = '{"ssid":"Finger","password":"original-password"}'
        credentials.write_text(old)
        subprocess.run([*cc, *flags, str(project / 'tests/portal_instrumented.c'), str(project / 'tests/test_portal_runtime.c'),
                        *extra_sources, str(library), '-lpthread', '-lm', '-o', str(executable)], check=True, timeout=60)
        process = subprocess.Popen([str(executable), str(credentials)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=environment)

        def command(text):
            process.stdin.write(text + '\n'); process.stdin.flush()
            ready, _, _ = select.select([process.stdout], [], [], 3)
            assert ready, 'controller command blocked: ' + text
            line = process.stdout.readline()
            assert line, process.stderr.read()
            return json.loads(line)

        def wait(predicate, timeout=3):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                status = command('status')
                if predicate(status):
                    return status
                time.sleep(.02)
            raise AssertionError(('state timeout', status))

        def start():
            assert command('start')['result'] == 0
            return wait(lambda s: s['phase'] == 'waiting')['port']

        def stop():
            assert command('stop')['result'] == 0
            status = wait(lambda s: not s['owned'])
            assert status['workersUnjoined'] == 0
            return status

        def http(port, path, body=None):
            connection = HTTPConnection('127.0.0.1', port, timeout=3)
            connection.request('POST' if body is not None else 'GET', path, body=body,
                               headers={'Content-Type': 'application/x-www-form-urlencoded'})
            response = connection.getresponse(); data = response.read(); headers = dict(response.getheaders())
            connection.close(); return response.status, data, headers

        def raw(port, request):
            with socket.create_connection(('127.0.0.1', port), timeout=3) as connection:
                connection.sendall(request)
                chunks = []
                while True:
                    chunk = connection.recv(8192)
                    if not chunk: break
                    chunks.append(chunk)
            packet = b''.join(chunks)
            return int(packet.split(b' ', 2)[1]), packet

        try:
            initial = command('status')
            assert initial['workerCreates'] == initial['workersUnjoined'] == 0
            # 两个线程分别创建失败：没有开启AP，剩余栈回收后允许下一次请求。
            for nth in (1, 2):
                command('failcreate ' + str(nth))
                assert command('start')['result'] < 0
                failed = wait(lambda s: not s['owned'])
                assert failed['workersUnjoined'] == 0 and failed['apStarts'] == 0 and failed['error'] < 0
            assert command('request')['result'] == 0
            before = command('status'); assert not before['owned'] and before['apStarts'] == 0
            assert command('request')['result'] < 0
            command('stop'); assert command('take')['result'] == 0
            command('request'); assert command('take')['result'] == 1
            command('stop'); assert command('begin')['result'] < 0
            # 网络关闭不代表栈已回收；只读状态不得自行join，回收失败继续持有ownership。
            start(); command('autoreap 0'); command('stop')
            stopped = wait(lambda s: s['apStops'] == 1)
            assert stopped['owned'] and stopped['workersUnjoined'] == 2
            assert command('shutdown')['result'] < 0 and command('start')['result'] < 0
            command('failjoin 1'); time.sleep(.05)
            assert command('reap')['result'] < 0 and command('status')['workersUnjoined'] == 2
            command('failjoin 0'); assert command('reap')['result'] == 0
            assert command('status')['workersUnjoined'] == 0
            command('autoreap 1')
            port = start()
            status, body, headers = http(port, '/')
            assert status == 200 and body == (project.parent / 'firmware/components/wifi_portal/src/portal.html').read_bytes()
            assert headers['Cache-Control'] == 'no-store'
            status, body, _ = http(port, '/status'); snapshot = json.loads(body)
            assert status == 200 and snapshot == {'ok': True, 'phase': 'waiting', 'ssid': '', 'ip': '', 'message': ''}
            assert b'38192047' not in body
            status, body, headers = http(port, '/hotspot-detect.html'); assert status == 302 and headers['Location'] == 'http://192.168.4.1/'
            status, body, _ = http(port, '/scan'); data = json.loads(body)
            if args.stack_probe_log:
                assert status == 200 and len(data['aps']) == 24
                assert [ap['ssid'] for ap in data['aps'][:3]] == ['Finger', '中文"\\\n', 'weak']
                assert all(len(ap['ssid'].encode()) == 31 for ap in data['aps'][3:])
            else:
                assert status == 200 and [ap['ssid'] for ap in data['aps']] == ['Finger', '中文"\\\n', 'weak']
            assert data['aps'][0]['rssi'] == -20 and data['aps'][0]['secure'] is True
            invalid = [b'ssid=bad%00x&pass=password', b'ssid=a&ssid=b&pass=password', b'ssid=a&pass=short',
                       b'ssid=a%GG&pass=password', b'ssid=%FFbad&pass=password', b'ssid=%ED%A0%80&pass=password',
                       b'ssid=' + b'a' * 33 + b'&pass=password', b'ssid=a&pass=' + b'z' * 64]
            for body in invalid:
                assert http(port, '/connect', body)[0] == 400
            for request in [b'POST /connect HTTP/1.1\r\nContent-Length: 9999999999\r\n\r\n',
                            b'POST /connect HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n',
                            b'POST /connect HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n',
                            b'GET /status HTTP/1.1\r\nX-Test: a\0b\r\n\r\n',
                            b'GET /status HTTP/1.1\r\nX-Test: ' + b'x' * 2100 + b'\r\n\r\n']:
                assert raw(port, request)[0] == 400
            with socket.create_connection(('127.0.0.1', port), timeout=3) as connection:
                connection.sendall(b'GET /sta'); time.sleep(.03)
                connection.sendall(b'tus HTTP/1.1\r\nHost: portal\r\n\r\n')
                assert b'200 OK' in connection.recv(4096)
            state = stop(); assert state['connected'] and state['disconnects'] == 0 and credentials.read_text() == old

            # stop 时的扫描仍由门户消费；不得调用断网取消，更不能提前恢复新 VM。
            command('scanms 300'); port = start()
            connection = socket.create_connection(('127.0.0.1', port), timeout=3)
            connection.sendall(b'GET /scan HTTP/1.1\r\nHost: portal\r\n\r\n')
            wait(lambda s: s['scans'] == 2)
            command('stop'); state = command('status'); assert state['owned']
            assert command('start')['result'] < 0 and command('shutdown')['result'] < 0
            state = wait(lambda s: not s['owned']); connection.close()
            assert state['disconnects'] == 0 and state['connected']

            # DHCP start 卡住后取消：公共 API 仍响应，迟到 start 必须随后 stop。
            command('holdstart 1'); starts = command('status')['dhcpStarts']; command('start')
            wait(lambda s: s['dhcpStarts'] > starts); command('stop')
            assert command('status')['owned'] and command('shutdown')['result'] < 0
            command('holdstart 0'); wait(lambda s: not s['owned'])
            port = start(); command('holdstop 1'); command('stop')
            state = wait(lambda s: s['phase'] == 'stopping'); assert state['owned']
            command('holdstop 0'); wait(lambda s: not s['owned'])

            # 停止失败不伪报结束；显式 stop 可以重试而不关闭 STA。
            port = start(); command('failstop 1'); command('stop')
            state = wait(lambda s: s['error'] != 0); assert state['owned']
            command('failstop 0'); command('stop'); wait(lambda s: not s['owned'])

            # 失败连接退出后恢复原 Finger，成功以前文件逐字不变。
            port = start(); assert http(port, '/connect', b'ssid=bad&pass=wrongpass')[0] == 200
            wait(lambda s: s['phase'] == 'failed'); assert credentials.read_text() == old
            state = stop(); assert state['connected'] and state['ssid'] == 'Finger'
            command('connectms 300'); port = start()
            assert http(port, '/connect', b'ssid=new&pass=new-password')[0] == 200
            state = stop(); assert state['connected'] and state['ssid'] == 'Finger' and state['disconnects'] == 1
            assert credentials.read_text() == old

            # 成功必须有 IP 后才原子保存；成功展示结束后主动回收 AP，不断开新 STA。
            command('connectms 80'); port = start()
            assert http(port, '/connect', b'ssid=new&pass=new-password')[0] == 200
            assert credentials.read_text() == old
            wait(lambda s: s['phase'] == 'success')
            status, body, _ = http(port, '/status'); assert json.loads(body)['ip'] == '192.168.31.101'
            assert json.loads(credentials.read_text()) == {'ssid': 'new', 'password': 'new-password'}
            state = wait(lambda s: not s['owned']); assert state['ssid'] == 'new' and state['disconnects'] == 1
            assert not list(root.glob('*.portal.*'))

            if args.stack_probe_log:
                # 只解析长度门禁之内的数据，真正经过JSON递归/错误回溯，且不能覆盖旧凭据。
                payloads = ['[' * 500 + '0' + ']' * 500, '{"x":' * 160 + '0' + '}' * 160,
                            '[' * 1000, '{"ssid":"' + 'x' * 900 + '","password":"p"}',
                            '{"ssid":"x","password":']
                for payload in payloads:
                    assert len(payload.encode()) <= 1024
                    credentials.write_text(payload); port = start()
                    status, body, _ = http(port, '/status')
                    assert status == 200 and json.loads(body)['phase'] == 'waiting'
                    assert http(port, '/connect', b'ssid=other&pass=password')[0] == 409
                    stop(); assert credentials.read_text() == payload

            # 未存储的当前连接不可恢复：允许展示热点，但拒绝切网。
            credentials.write_text(old); port = start()
            assert http(port, '/connect', b'ssid=other&pass=password')[0] == 409
            stop(); assert command('shutdown')['result'] == 0
            assert command('init')['result'] == 0
            port = start(); stop(); assert command('shutdown')['result'] == 0
            process.stdin.write('quit\n'); process.stdin.flush(); process.wait(timeout=3)
            assert process.returncode == 0, process.stderr.read()
        finally:
            if process.poll() is None:
                process.kill(); process.wait(timeout=3)
            error = process.stderr.read()
            assert not error, error
    print('门户通过：真实 TCP 四接口/HTML、请求边界、原子凭据、单消费者、扫描/连接取消、DHCP 阻塞与停止重试、跨代重启')


if __name__ == '__main__':
    main()
