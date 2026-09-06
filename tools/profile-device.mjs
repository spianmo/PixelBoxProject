import { DevdClient } from '../sdk/dist/devd.js';

const host = process.argv[2] || '192.168.31.100';
const seconds = Math.max(2, Math.min(60, Number(process.argv[3]) || 12));
const client = await DevdClient.connect(host);
try {
    const hello = await client.hello();
    console.log(JSON.stringify({ device: hello.name, firmware: hello.fw, seconds }));
    await client.evalJs(`(() => {
        if (globalThis.__pxProfile) globalThis.__pxProfile.off();
        const p = globalThis.__pxProfile = { start: performance.now(), frames: 0, totalDt: 0, maxDt: 0, intervals: [] };
        p.off = px.screen.onFrame(dt => {
            p.frames++; p.totalDt += dt; p.maxDt = Math.max(p.maxDt, dt);
            if (p.intervals.length < 4096) p.intervals.push(dt);
        });
        ${process.argv.includes('--detail') ? `
        p.native = {};
        const restore = [];
        for (const [object, name] of [[px.screen,'clear'],[px.screen,'fillRect'],[px.screen,'fillRects'],[px.screen,'drawText'],[px.screen,'measureText'],[px.util,'projectPoints'],[px.util,'projectPointRuns']]) {
            if (typeof object[name] !== 'function') continue;
            const original = object[name], stats = p.native[name] = {calls:0,ms:0};
            object[name] = function(...args) {
                const start = performance.now();
                const result = original.apply(this,args);
                stats.ms += performance.now()-start; stats.calls++;
                return result;
            };
            restore.push(()=>object[name]=original);
        }
        const off = p.off;
        p.off = ()=>{off();for(const fn of restore)fn()};` : ''}
        setTimeout(() => p.off(), ${(seconds + 15) * 1000});
        return 'profiling';
    })()`, 30000);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    const result = await client.evalJs(`(() => {
        const p = globalThis.__pxProfile;
        if (!p) return { restarted: true };
        p.off();
        const elapsedMs = performance.now() - p.start;
        p.intervals.sort((a, b) => a - b);
        const result = { elapsedMs, frames: p.frames, fps: p.frames * 1000 / elapsedMs,
            meanFrameMs: p.totalDt / Math.max(1, p.frames), maxFrameMs: p.maxDt,
            p95FrameMs: p.intervals[Math.floor(p.intervals.length * .95)] || 0,
            memory: px.system.memory(), runtime: typeof __pxRuntimeStats === 'function' ? __pxRuntimeStats() : null };
        if(p.native)result.native = p.native;
        delete globalThis.__pxProfile;
        return result;
    })()`, 30000);
    console.log(result);
} finally {
    client.close();
}
