/** 真机 WebSocket transport 回归：路径、查询、认证、子协议、二进制及分片。
 * node tools/check-websocket-transport.mjs <设备地址> <本机IPv4>
 * 测试数据独立于 example06 的真实语音连接，不读取配对或账号凭据。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { DevdClient } from '../sdk/dist/devd.js';
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const [host, ip] = process.argv.slice(2);
if (!host || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('需要设备地址和本机 IPv4');
const server = new WebSocketServer({ host: ip, port: 0 });
await once(server, 'listening');
const client = await DevdClient.connect(host);
let resolve, reject;
const done = new Promise((ok, fail) => { resolve = ok; reject = fail; });
const expected = Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 251));
server.on('connection', (socket, request) => {
    try {
        assert.equal(request.url, '/transport/check?mode=pcm');
        assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('fixture:local').toString('base64'));
        assert.equal(socket.protocol, 'pixelbox-test');
        socket.send('fragment-', { fin: false });
        socket.send('complete', { fin: true });
        socket.send(expected.subarray(0, 4000), { binary: true, fin: false });
        socket.send(expected.subarray(4000), { binary: true, fin: true });
        let text = false;
        socket.on('message', (data, binary) => {
            try {
                if (!binary) { assert.equal(data.toString(), 'fragment-complete'); text = true; }
                else { assert.ok(text); assert.deepEqual(data, expected); resolve(); }
            } catch (error) { reject(error); }
        });
    } catch (error) { reject(error); }
});
const timeout = setTimeout(() => reject(new Error('WebSocket transport 回归超时')), 15000);
try {
    await client.evalJs(`(() => {
        const ws=globalThis.__transportCheck=new WebSocket('ws://fixture:local@${ip}:${server.address().port}/transport/check?mode=pcm','pixelbox-test');
        ws.onmessage=e=>ws.send(e.data);
        setTimeout(()=>ws.close(),12000);
        return true;
    })()`, 8000);
    await done;
    console.log('真实 WebSocket 路径/查询、Basic 认证、子协议、8192 字节二进制、分片重组通过');
} finally {
    clearTimeout(timeout);
    try { await client.evalJs('globalThis.__transportCheck?.close()', 8000); } finally {
        client.close();
        for (const socket of server.clients) socket.terminate();
        server.close();
    }
}
