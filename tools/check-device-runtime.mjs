import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DevdClient } from '../sdk/dist/devd.js';

const require = createRequire(new URL('../examples/package.json', import.meta.url));
const { build } = require('esbuild');
const host = process.argv[2] || '192.168.31.100';
const client = await DevdClient.connect(host);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = async code => JSON.parse(await client.evalJs(`JSON.stringify(${code})`, 15000));
async function awaitFrames() {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
        await pause(500);
        try {
            const state = await evaluate('(typeof fixture === "object" ? {frames:fixture.frames,memory:px.system.memory()} : null)');
            if (state && state.frames > 0) return state;
        } catch { /* Restart can briefly leave no context for eval. */ }
    }
    throw new Error('No frame after restart within 12 seconds');
}
const source = `
import { drawScene } from '../examples/06-obeing-pixel/src/render';
import { drawHarness } from '../examples/07-obeing-harness/src/render';
import { initialState } from '../examples/06-obeing-pixel/src/state';
import { CatMotion, prepareCat } from '../examples/06-obeing-pixel/src/model';
const view = initialState(); view.state = 'idle'; view.muted = true;
const motion = new CatMotion();
const form = {page:'assistant'};
const p = globalThis.fixture = {mode:6,frames:0,samples:0,maxGap:0,lastSample:0,clock:0,x:0,y:0};
px.sensors.imu.start({rateHz:50,onData(data){
    const now=performance.now();
    if(p.lastSample)p.maxGap=Math.max(p.maxGap,now-p.lastSample);
    p.lastSample=now;p.samples++;p.x=-data.ax;p.y=data.ay;
}});
prepareCat();
px.screen.setFps(24);
px.screen.onFrame(dt=>{
    p.frames++;p.clock+=dt;
    const input={clock:p.clock,tiltX:p.x,tiltY:p.y,battery:80,settings:false,fullscreen:p.mode===8,
        pose:motion.sample(view.state,p.clock,p.x,p.y,0)};
    if(p.mode===6)drawScene(px.screen,view,input);
    else drawHarness(px.screen,view,input,form);
});
px.app.onExit(()=>px.sensors.imu.stop());
`;
try {
    const bundle = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2020' });
    await client.pushApp({ id: 'com.pixelbox.runtime-check', name: 'Runtime Check', version: '0.1.0', entry: 'main.js' }, [{ path: 'main.js', data: Buffer.from(bundle.outputFiles[0].text) }]);
    await awaitFrames();
    const initialStats = await evaluate('__pxRuntimeStats()');
    for (const mode of (process.argv.includes('--stability-only') ? [] : [6, 7, 8])) {
        await evaluate(`Object.assign(fixture,{mode:${mode},frames:0,samples:0,maxGap:0,lastSample:0,start:performance.now()}) && true`);
        await pause(12000);
        const data = await evaluate(`({mode:fixture.mode,frames:fixture.frames,samples:fixture.samples,
            elapsedMs:performance.now()-fixture.start,maxSampleGapMs:fixture.maxGap,
            runtime:__pxRuntimeStats(),memory:px.system.memory()})`);
        data.fps = data.frames * 1000 / data.elapsedMs;
        assert.ok(data.frames > 0 && data.samples > 0);
        assert.equal(data.runtime.executionTimeouts, initialStats.executionTimeouts);
        console.log(JSON.stringify({ scene: `example${mode===8 ? '7 fullscreen' : mode} assistant renderer with live IMU`, ...data }));
    }
    if (process.argv.includes('--render-only')) { client.close(); process.exit(0); }

    await evaluate(`(()=>{globalThis.jobCount=0;globalThis.timerJobs=-1;setTimeout(()=>timerJobs=jobCount,0);
        queueMicrotask(function again(){jobCount++;if(jobCount<20000)queueMicrotask(again)});return true})()`);
    await pause(4000);
    const jobs = await evaluate(`({jobs:jobCount,timerJobs})`);
    assert.ok(jobs.timerJobs >= 0 && jobs.timerJobs < 20000);
    console.log(JSON.stringify({ microtaskFairness: jobs }));

    const before = await evaluate('__pxRuntimeStats()');
    await evaluate('(()=>{setTimeout(()=>{while(true){}},0);return true})()');
    await pause(2500);
    const after = await evaluate('__pxRuntimeStats()');
    assert.equal(after.executionTimeouts, before.executionTimeouts + 1);
    assert.equal(await evaluate('6 * 7'), 42);
    console.log(JSON.stringify({ runawayCallbackRecovered: true, executionTimeouts: after.executionTimeouts }));

    const heaps = [];
    for (let i = 0; i < 6; ++i) {
        await client.restartApp();
        const state = await awaitFrames();
        assert.ok(state.frames > 0);
        heaps.push(state.memory);
    }
    const heapLoss = heaps[0].heapFree - heaps.at(-1).heapFree;
    assert.ok(heapLoss < 8192, `internal heap lost ${heapLoss} bytes across restarts`);
    console.log(JSON.stringify({ restarts: heaps.length, heaps, heapLoss }));
    console.log('Device runtime checks passed. Restore the desired example with the SDK push command.');
} finally { client.close(); }
