/** 真机小猫验收：临时运行 06/07 的真实渲染器，结束后恢复完整 example06。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DevdClient } from '../sdk/dist/devd.js';
import { buildApp, collectPushFiles } from '../sdk/dist/build.js';

const host = process.argv[2];
if (!host) throw new Error('用法: node tools/check-cat-fps.mjs <设备IP> [每场景秒数，默认12]；会切换设备应用');
const seconds = Math.max(4, Math.min(60, Number(process.argv[3]) || 12));
const require = createRequire(new URL('../examples/package.json', import.meta.url));
const { build } = require('esbuild');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = `
import { drawScene } from '../examples/06-obeing-pixel/src/render';
import { drawHarness } from '../examples/07-obeing-harness/src/render';
import { initialState } from '../examples/06-obeing-pixel/src/state';
import { CatMotion, prepareCat } from '../examples/06-obeing-pixel/src/model';
const view = {...initialState(),state:'idle',authenticated:true,connected:true};
const form = {page:'assistant'};
const motion = new CatMotion(()=>.4);
const p = globalThis.__catFps = {mode:6,fullscreen:false,state:'idle',clock:0,x:0,y:0,
    frames:0,drawMs:0,flushMs:0,intervals:[],last:0,start:performance.now()};
p.reset = (mode,fullscreen,state) => {
    Object.assign(p,{mode,fullscreen,state,frames:0,drawMs:0,flushMs:0,intervals:[],last:0,start:performance.now()});
};
if(px.sensors.imu.available())px.sensors.imu.start({rateHz:50,onData(d){p.x=-d.ax;p.y=d.ay}});
prepareCat();
px.screen.setFps(30);
px.screen.onFrame(dt=>{
    p.clock+=dt;
    const before=performance.now();
    // 固定扫描姿态保证无人移动设备时也覆盖 IMU 旋转与形态过渡。
    const x=Math.max(-1,Math.min(1,p.x+Math.sin(p.clock/800)*.6));
    const y=Math.max(-1,Math.min(1,p.y+Math.cos(p.clock/1100)*.6));
    view.state=p.state;view.level=p.state==='speaking'?50+Math.sin(p.clock/150)*40:0;
    view.assistantText=p.state==='speaking'?'这是第'+Math.floor(p.clock/1500)+'段流式字幕':'小猫刷新率测试';
    const input={clock:p.clock,tiltX:x,tiltY:y,battery:86,settings:false,fullscreen:p.fullscreen,
        pose:motion.sample(view.state,p.clock,x,y,view.level)};
    if(p.mode===6)drawScene(px.screen,view,input);else drawHarness(px.screen,view,input,form);
    const drawn=performance.now();
    // 每次计数都对应一次真实绘制及同步屏幕提交，不把空 onFrame 回调当作新画面。
    px.screen.flush();
    const done=performance.now();
    p.drawMs+=drawn-before;p.flushMs+=done-drawn;p.frames++;
    if(p.last && p.intervals.length<4096)p.intervals.push(done-p.last);
    p.last=done;
});
px.app.onExit(()=>{if(px.sensors.imu.available())px.sensors.imu.stop()});
`;

// 先准备恢复包，避免测试运行后才发现本地应用无法构建。
const restore = await buildApp(fileURLToPath(new URL('../examples/06-obeing-pixel', import.meta.url)), {});
const fixture = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'iife', target: 'es2020' });
const client = await DevdClient.connect(host);
const evaluate = async code => JSON.parse(await client.evalJs(`JSON.stringify(${code})`, 15000));
let switched = false;
const results = [];
try {
    switched = true;
    await client.pushApp({ id: 'com.pixelbox.cat-fps-check', name: 'Cat FPS Check', version: '0.1.0', entry: 'main.js' },
        [{ path: 'main.js', data: Buffer.from(fixture.outputFiles[0].text) }]);
    const deadline = Date.now() + 20000;
    while (true) {
        await pause(500);
        try { if (await evaluate('(globalThis.__catFps?.frames || 0)>0')) break; } catch { /* 等待 JS VM 启动。 */ }
        if (Date.now() >= deadline) throw new Error('20 秒内未出现小猫绘制帧');
    }
    const initial = await evaluate('__pxRuntimeStats()');
    for (const mode of [6, 7]) for (const fullscreen of [false, true]) for (const state of ['idle', 'speaking']) {
        await evaluate(`(__catFps.reset(${mode},${fullscreen},${JSON.stringify(state)}),true)`);
        await pause(1000); // 页面切换和初始文字布局在采样前完成。
        await evaluate(`(__catFps.reset(${mode},${fullscreen},${JSON.stringify(state)}),true)`);
        await pause(seconds * 1000);
        const result = await evaluate(`(()=>{
            const p=__catFps,elapsed=performance.now()-p.start;
            const intervals=p.intervals.slice().sort((a,b)=>a-b);
            return {mode:p.mode,fullscreen:p.fullscreen,state:p.state,frames:p.frames,elapsedMs:elapsed,
                fps:p.frames*1000/elapsed,drawMs:p.drawMs/p.frames,flushMs:p.flushMs/p.frames,
                p95FrameMs:intervals[Math.floor(intervals.length*.95)]||0,
                maxFrameMs:intervals[intervals.length-1]||0,memory:px.system.memory(),runtime:__pxRuntimeStats()};
        })()`);
        results.push(result);
        console.log(JSON.stringify(result));
        assert.equal(result.runtime.executionTimeouts, initial.executionTimeouts, '采样中出现 JS 执行超时');
    }
} finally {
    try {
        if (switched) {
            await client.pushApp(restore.manifest, collectPushFiles(restore));
            console.log('已恢复完整 example06');
        }
    } finally { client.close(); }
}
assert.equal(results.length, 8);
assert.ok(results.every(r => r.fps >= 20), '存在小猫场景低于 20 FPS，详见逐场景测量；未达标');
console.log('06/07 普通/全屏、待机/说话动画共 8 个场景实测均达到 20 FPS（未包含真实语音网络负载）');
