/** 真机背压回归：TCP 接收窗口耗尽 4 秒后，原连接完整、有序发送 64 KiB。
 * node tools/check-websocket-backpressure.mjs <设备地址> <本机 IPv4>
 * 仅生成测试字节，不读取账号、配对信息或真实音频。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DevdClient } from '../sdk/dist/devd.js';

const [host, ip] = process.argv.slice(2);
if (!host || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('需要设备地址和本机 IPv4');
// Node 没有 TCP SO_RCVBUF 设置接口，使用标准库服务端制造真实的零接收窗口。
const server = spawn('python3', ['-u', '-c', String.raw`
import base64, hashlib, json, socket, struct, sys, time
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
listener.bind((sys.argv[1], 0))
listener.listen(1)
listener.settimeout(20)
print(json.dumps({'port': listener.getsockname()[1]}), flush=True)
peer, _ = listener.accept()
peer.settimeout(20)
def read(size):
    data = b''
    while len(data) < size:
        part = peer.recv(size - len(data))
        if not part: raise RuntimeError('接收窗口恢复前连接已断开')
        data += part
    return data
request = b''
while not request.endswith(b'\r\n\r\n'): request += read(1)
headers = dict(line.split(':', 1) for line in request.decode().split('\r\n')[1:] if ':' in line)
key = next(v.strip() for k,v in headers.items() if k.lower() == 'sec-websocket-key')
accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
peer.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
started = time.monotonic()
time.sleep(4)
total = 0
for index in range(16):
    opcode, length = read(2)
    assert opcode == 0x82 and length & 128, '必须保持完整二进制帧'
    length &= 127
    if length == 126: length = struct.unpack('!H', read(2))[0]
    elif length == 127: length = struct.unpack('!Q', read(8))[0]
    assert length == 4096
    mask = read(4)
    data = read(length)
    data = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
    assert data == bytes((index * 4096 + i) % 251 for i in range(length)), '数据丢失、重复或乱序'
    total += length
peer.sendall(b'\x81\x02ok')
print(json.dumps({'bytes': total, 'pausedMs': 4000, 'elapsedMs': round((time.monotonic() - started) * 1000)}), flush=True)
time.sleep(1)
peer.close()
listener.close()
`, ip], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.on('data', data => { stderr += data; });
const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
const deadline = setTimeout(() => server.kill(), 30000);
let client;
try {
    const first = await lines.next();
    assert.ok(!first.done, stderr || '测试服务端未启动');
    const { port } = JSON.parse(first.value);
    client = await DevdClient.connect(host);
    await client.evalJs(`(() => {
        const p=globalThis.__wsBackpressure={result:'waiting',closed:false,error:false};
        const ws=p.ws=new WebSocket('ws://${ip}:${port}/backpressure');
        ws.onopen=()=>{
            for(let index=0;index<16;index++){
                const data=new Uint8Array(4096);
                for(let i=0;i<data.length;i++)data[i]=(index*4096+i)%251;
                ws.send(data);
            }
        };
        ws.onmessage=e=>{p.result=e.data;p.openAtResult=ws.readyState===WebSocket.OPEN;};
        ws.onerror=()=>{p.error=true;};
        ws.onclose=()=>{p.closed=true;};
        setTimeout(()=>ws.close(),25000);
        return true;
    })()`, 8000);
    const result = await lines.next();
    assert.ok(!result.done, stderr || '测试传输未完成');
    const report = JSON.parse(result.value);
    assert.equal(report.bytes, 65536);
    let state;
    for (let attempt = 0; attempt < 10; attempt++) {
        state = JSON.parse(await client.evalJs('JSON.stringify({result:__wsBackpressure.result,error:__wsBackpressure.error,openAtResult:__wsBackpressure.openAtResult})', 8000));
        if (state.result === 'ok') break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(state.result, 'ok');
    assert.equal(state.error, false);
    assert.equal(state.openAtResult, true);
    console.log(JSON.stringify({ ...report, sameSocket: true, ordered: true }));
} finally {
    clearTimeout(deadline);
    if (client) {
        try { await client.evalJs('globalThis.__wsBackpressure?.ws.close()', 8000); }
        finally { client.close(); }
    }
    server.kill();
}
