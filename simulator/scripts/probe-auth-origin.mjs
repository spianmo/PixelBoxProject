import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Read-only, unauthenticated request: never send credentials or print response bodies.
const bundle = await build({ stdin: {
    contents: "export { validateOrigin, isSameServiceOrigin } from './auth';",
    resolveDir: fileURLToPath(new URL('../../examples/07-obeing-harness/src/', import.meta.url)), loader: 'ts',
}, bundle: true, write: false, minify: true, format: 'iife', globalName: 'OriginProbe' });
const socket = new WebSocket(`ws://${process.argv[2] || '192.168.31.100'}:8765/devd`, { handshakeTimeout: 5000 });
const pending = new Map();
let sequence = 0;
function evaluate(code) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Device evaluation timed out')); }, 12000);
        pending.set(id, (message) => {
            clearTimeout(timer);
            if (message.error) reject(new Error('Device evaluation failed'));
            else resolve(message.result.result);
        });
        socket.send(JSON.stringify({ id, method: 'js.eval', params: { code } }));
    });
}
socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const settle = pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
});
try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await evaluate(`(()=>{${bundle.outputFiles[0].text}
        const origin=OriginProbe.validateOrigin(px.storage.kv.get('h.origin')||'https://v4.teamhelper.cn');
        globalThis.__pxAuthOriginProbe=null;
        fetch(origin+'/api/meeting/oauth/appid',{redirect:'error',timeoutMs:8000}).then(r=>{
            globalThis.__pxAuthOriginProbe={status:r.status,url:r.url,oldCheck:r.url.startsWith(origin+'/'),sameOrigin:OriginProbe.isSameServiceOrigin(r.url,origin)};
        },()=>{globalThis.__pxAuthOriginProbe={error:'Request failed'};});
        return 'started';
    })()`);
    let result;
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        let value = await evaluate('JSON.stringify(globalThis.__pxAuthOriginProbe)');
        for (let j = 0; j < 2 && typeof value === 'string'; j++) value = JSON.parse(value);
        if (value) { result = value; break; }
    }
    assert.ok(result, 'Device request timed out');
    console.log(JSON.stringify(result));
    assert.equal(result.sameOrigin, true);
    await evaluate('delete globalThis.__pxAuthOriginProbe');
} finally { socket.close(); }
