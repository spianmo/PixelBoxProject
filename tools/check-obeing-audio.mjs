/** 在已运行的 example06 中，用本地测试音走真实 onMessage/动画/原生播放器。
 * node tools/check-obeing-audio.mjs <PixelBox地址> <本机局域网IP> [秒数]
 * 设备须未配对且空闲；不读取账号，不调用云端，不改设备应用文件。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { DevdClient } from '../sdk/dist/devd.js';
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const [host, localIp, length = '20'] = process.argv.slice(2);
if (!host || !localIp || !/^\d+\.\d+\.\d+\.\d+$/.test(localIp)) throw new Error('需要 PixelBox 地址和本机局域网 IPv4');
const seconds = Math.max(5, Math.min(30, Number(length) || 20));
const fullscreenProbe = process.argv.includes('--fullscreen');
const totalBytes = seconds * 32000;
const server = new WebSocketServer({ host: localIp, port: 0 });
await once(server, 'listening');
const client = await DevdClient.connect(host);
let timer;
let completed;
let failed;
const result = new Promise((resolve, reject) => { completed = resolve; failed = reject; });
// 在设备就绪后才开始发包，避免音频和 HTTP 握手响应合并。
server.on('connection', socket => socket.on('message', async data => {
    const text = data.toString();
    if (text !== 'ready') { try { completed(JSON.parse(text)); } catch (error) { failed(error); } return; }
    try {
        socket.send('start');
        const start = performance.now();
        for (let offset = 0; offset < totalBytes; offset += 1024) {
            const pcm = Buffer.alloc(Math.min(1024, totalBytes - offset));
            for (let index = 0; index < pcm.length; index += 2)
                pcm.writeInt16LE(Math.round(1500 * Math.sin(2 * Math.PI * 800 * (offset + index) / 32000)), index);
            // 与 PixelBoxAudioPacer 一样使用累计采样时钟，最多提前 512ms。
            const wait = (offset + pcm.length) / 32 - 512 - (performance.now() - start);
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
            if (socket.readyState !== 1) throw new Error('播放中连接断开');
            socket.send(pcm);
        }
        socket.send('end');
    } catch (error) { failed(error); }
}));
try {
    const setup = await client.evalJs(`(() => {
        if (view.connected || px.audio.mic.active || px.audio.player.playing) throw new Error('设备正在使用，不能启动测试');
        const old = {...view};
        const oldFullscreen = fullscreen;
        const oldReconnectPaused = reconnectPaused;
        reconnectPaused = true;
        const ws = new WebSocket('ws://${localIp}:${server.address().port}/');
        const probe = globalThis.__obeingAudioCheck = {bytes:0,packets:0,gaps:0,minBufferMs:99999,maxGapMs:0,first:0,last:0,draws:0,maxDrawMs:0,drawMs:0};
        const originalDraw = drawScene;
        drawScene = function(...args) {
            const started=px.system.now();
            try { return originalDraw(...args); } finally {
                const elapsed=px.system.now()-started;
                probe.draws++; probe.drawMs+=elapsed; probe.maxDrawMs=Math.max(probe.maxDrawMs,elapsed);
            }
        };
        const restore = () => { drawScene=originalDraw; fullscreen=oldFullscreen; reconnectPaused=oldReconnectPaused; Object.assign(view,old); };
        ws.onopen = () => ws.send('ready');
        ws.onmessage = event => {
            if (typeof event.data === 'string') {
                if (event.data === 'start') {
                    view.authenticated=true; view.state='speaking'; view.level=75;
                    fullscreen=${fullscreenProbe};
                    view.assistantText='这是一段连续播报测试，三维动画和字幕应同时显示，语音播放保持连续。';
                    onMessage(JSON.stringify({type:'audio.start',turnId:99001,sampleRate:16000,channels:1,format:'pcm_s16le'}));
                    playback.onEnded(() => {
                        probe.elapsedMs=px.system.now()-probe.first; probe.ended=true;
                        restore(); ws.send(JSON.stringify(probe));
                    });
                } else if (event.data === 'end') onMessage(JSON.stringify({type:'audio.end',turnId:99001}));
                return;
            }
            const now=px.system.now(), buffered=playback.buffered();
            if (!probe.first) probe.first=now;
            if (probe.packets>=8) {
                probe.maxGapMs=Math.max(probe.maxGapMs,now-probe.last);
                probe.minBufferMs=Math.min(probe.minBufferMs,buffered);
                if (buffered===0) probe.gaps++;
            }
            probe.last=now; probe.bytes+=event.data.byteLength; probe.packets++;
            onMessage(event.data);
        };
        let cleaned=false;
        const timer=setTimeout(() => { if (!probe.ended) globalThis.__obeingAudioCheckCleanup(); }, ${(seconds + 10) * 1000});
        globalThis.__obeingAudioCheckCleanup = () => {
            if(cleaned)return;
            cleaned=true;clearTimeout(timer);stopPlayback();restore();ws.close();
        };
        return '开始真实入口测试音：${seconds}秒';
    })()`, 8000);
    console.log(setup);
    timer = setTimeout(() => failed(new Error('音频播放超时')), (seconds + 12) * 1000);
    const report = await result;
    console.log(JSON.stringify(report));
    assert.equal(report.bytes, totalBytes);
    assert.equal(report.gaps, 0, '音频缓冲不可耗尽');
    assert.ok(report.draws > seconds, '播报期间动画仍需持续更新');
    assert.ok(report.ended);
} finally {
    clearTimeout(timer);
    try { await client.evalJs('if(globalThis.__obeingAudioCheckCleanup)globalThis.__obeingAudioCheckCleanup()', 8000); } catch { }
    client.close();
    for (const socket of server.clients) socket.terminate();
    server.close();
}
