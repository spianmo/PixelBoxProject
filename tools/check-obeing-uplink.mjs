/** 真机 example06 采音/重连探针。PCM 只计数，不保存，也不发送给云服务。
 * node tools/check-obeing-uplink.mjs <设备地址> <本机局域网IP> [秒数]
 * 仅允许空闲设备，结束后恢复原发现函数和配对存储。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { DevdClient } from '../sdk/dist/devd.js';
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const [host, localIp, duration = '20'] = process.argv.slice(2);
if (!host || !/^\d+\.\d+\.\d+\.\d+$/.test(localIp)) throw new Error('需要设备地址和本机 IPv4');
const seconds = Math.max(5, Math.min(600, Number(duration) || 20));
const phoneId = '00000000-0000-4000-8000-000000000099';
const pairKey = 'b'.repeat(64);
const server = new WebSocketServer({ host: localIp, port: 0 });
await once(server, 'listening');
const client = await DevdClient.connect(host);
const report = { connections: 0, packets: 0, bytes: 0, maxGapMs: 0, first: 0, last: 0 };
let finish, reject;
const done = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
let timeout;
let intentionalDisconnect = false;
const scheduled = [];
server.on('connection', ws => {
    const index = ++report.connections;
    ws.on('close', () => {
        if (index === 1 && !intentionalDisconnect) reject(new Error('持续采音期间发生非预期断连'));
    });
    let acknowledged = false;
    ws.on('message', (data, binary) => {
        try {
            if (binary) {
                assert.ok(acknowledged, '有效账号 ACK 必须先于音频');
                assert.equal(data.length, 4096, '每包应为 128ms PCM');
                if (index !== 1) return;
                const now = performance.now();
                if (!report.first) report.first = now;
                if (report.last) report.maxGapMs = Math.max(report.maxGapMs, now - report.last);
                report.last = now; report.packets++; report.bytes += data.length;
                return;
            }
            const message = JSON.parse(data.toString());
            if (message.type === 'hello') {
                if (index === 1) assert.equal(message.pairCode, '123456');
                else {
                    assert.equal(message.pairCode, undefined);
                    assert.equal(message.phoneId, phoneId);
                    assert.equal(message.pairKey, pairKey);
                }
                ws.send(JSON.stringify({ type: 'hello.ok', protocol: 1, phoneId, pairKey, authenticated: true, accountEpoch: 1 }));
                if (index === 1) scheduled.push(setTimeout(() => {
                    intentionalDisconnect = true;
                    ws.terminate();
                }, seconds * 1000));
                else scheduled.push(setTimeout(finish, 2500));
            } else if (message.type === 'account.ready') acknowledged = true;
            else if (message.type === 'ping') ws.send('{"type":"pong"}');
        } catch (error) { reject(error); }
    });
});
try {
    console.log(await client.evalJs(`(() => {
        if (socket || view.connected || px.audio.mic.active || px.audio.player.playing) throw new Error('设备正在使用');
        const oldPair = savedPairing, oldDiscover = px.net.mdns.discover, oldPause = reconnectPaused;
        const oldView = {...view};
        let cleaned = false;
        globalThis.__uplinkCleanup = () => {
            if (cleaned) return; cleaned = true;
            reconnectPaused = true; closeConnection();
            savedPairing = oldPair; savePairing(oldPair); px.net.mdns.discover = oldDiscover;
            reconnectPaused = oldPause; reconnectAt = 0; reconnectDelay = 1000;
            Object.assign(view, oldView); phone = null;
        };
        const candidate = {name:'本地连接测试',ip:'${localIp}',host:'${localIp}',port:${server.address().port},txt:{phoneId:'${phoneId}'}};
        savedPairing = null; reconnectPaused = false;
        px.net.mdns.discover = async () => [candidate];
        phone = candidate; view.pairingCode = '123456'; pair();
        setTimeout(() => globalThis.__uplinkCleanup(), ${(seconds + 18) * 1000});
        return '开始真实采音和免配对码重连测试';
    })()`, 8000));
    timeout = setTimeout(() => reject(new Error('采音/自动重连超时')), (seconds + 15) * 1000);
    await done;
    const audioMs = report.bytes / 32;
    const observedMs = report.last - report.first + 128;
    console.log(JSON.stringify({ connections: report.connections, packets: report.packets, bytes: report.bytes,
        audioMs, observedMs: Math.round(observedMs), maxGapMs: Math.round(report.maxGapMs) }));
    assert.equal(report.connections, 2, '应该只有一次主动断线后的重连');
    assert.ok(audioMs >= (seconds * 1000 - 1500), '持续采音不应丢失大段音频');
    assert.ok(Math.abs(audioMs - observedMs) < 700, 'PCM 时长应与真实采音时长一致');
} finally {
    clearTimeout(timeout);
    scheduled.forEach(clearTimeout);
    try { await client.evalJs('globalThis.__uplinkCleanup?.()', 8000); } finally {
        client.close();
        for (const ws of server.clients) ws.terminate();
        server.close();
    }
}
