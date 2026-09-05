#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// 使用生产设备 main.ts + 生产模拟器 WebSocket 包装层连接真实 Android 桥接。
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { default: NativeWebSocket } = await import(require.resolve('ws', { paths: [join(root, '..', 'simulator')] }));
const endpoint = new URL(process.argv[2] || 'ws://127.0.0.1:18888/pixelbox');
const main = await build({ entryPoints: [join(root, '06-obeing-pixel', 'src', 'main.ts')], bundle: true, format: 'iife', target: 'es2020', write: false });
const net = await build({ entryPoints: [join(root, '..', 'simulator', 'src', 'renderer', 'src', 'device-sim', 'sandbox', 'runtime', 'net.ts')], bundle: true, format: 'esm', target: 'es2020', write: false });
const { createWebSocketClass } = await import(`data:text/javascript;base64,${Buffer.from(net.outputFiles[0].text).toString('base64')}`);
for (const origin of [undefined, 'null']) {
    const messages = [];
    const outgoing = [];
    const sockets = [];
    const timers = new Set();
    let touch;
    let exit;
    let frame;
    let micStarts = 0;
    let closeCode;
    let closeReason;
    let done;
    const closed = new Promise((resolve) => { done = resolve; });
    class Socket extends NativeWebSocket {
        constructor(url, protocols) {
            super(url, protocols, origin ? { origin } : {});
            sockets.push(this);
            this.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(String(data))); });
            this.on('close', (code, reason) => { closeCode = code; closeReason = String(reason); done(); });
        }
        send(data) { if (typeof data === 'string') outgoing.push(JSON.parse(data)); super.send(data); }
    }
    const text = [];
    const px = {
        storage: { kv: { get: () => null, set() {} } },
        system: { info: () => ({ deviceId: 'real-js-probe', capabilities: { mic: true } }), battery: () => ({ level: 86 }), now: () => Date.now() },
        wifi: { status: () => ({ connected: true }) },
        net: { mdns: { discover: async () => [{ name: 'Android real bridge', ip: endpoint.hostname, host: endpoint.hostname, port: Number(endpoint.port), txt: { protocol: '1' } }] } },
        input: { onTouch(cb) { touch = cb; }, onButton() {} },
        audio: { mic: { start() { micStarts++; }, stop() {} }, player: {} },
        sensors: { imu: { available: () => false } },
        app: { onExit(cb) { exit = cb; } },
        screen: { width: 368, height: 448, setFps() {}, onFrame(cb) { frame = cb; }, clear() { text.length = 0; }, fillRect() {}, measureText: (value) => ({ width: value.length * 6, height: 12 }), drawText(value) { text.push(value); } },
    };
    try {
        runInNewContext(main.outputFiles[0].text, {
            px, WebSocket: createWebSocketClass(Socket), ArrayBuffer, Int16Array, console,
            setTimeout(cb, ms) { const timer = setTimeout(cb, ms); timers.add(timer); return timer; },
            clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
            setInterval() { return 0; }, clearInterval() {},
        });
        await new Promise((resolve) => setImmediate(resolve));
        for (let i = 0; i < 6; i++) touch({ type: 'down', x: 70, y: 250 });
        touch({ type: 'down', x: 286, y: 400 });
        let timeout;
        try { await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('真实Android桥接5秒未回应')), 5000); })]); }
        finally { clearTimeout(timeout); }
        assert.equal(outgoing[0]?.type, 'hello');
        assert.equal(outgoing[0]?.wakeWord, '你好小川');
        assert.ok(messages.some((m) => m.type === 'error' && m.code === 'pair_invalid'));
        assert.equal(messages.some((m) => ['hello.ok', 'account.state'].includes(m.type)), false, '未配对不得收到账号快照');
        assert.equal(closeCode, 1008);
        assert.equal(closeReason, 'pair_invalid');
        assert.equal(micStarts, 0, '真实Android未授权绝不采音');
        assert.equal(outgoing.length, 1, '未授权只有hello，不发送PCM/mic.start');
        frame(16);
        console.log(JSON.stringify({ origin: origin ?? '(native absent)', closeCode, closeReason, micStarts, serverMessages: messages.map((m) => m.type), deviceScreen: text }, null, 2));
    } finally {
        exit?.();
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.terminate();
    }
}
