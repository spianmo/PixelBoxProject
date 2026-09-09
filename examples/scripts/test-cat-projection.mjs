import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = `
import {CatMotion,rasterizeCat,prepareCat} from './examples/06-obeing-pixel/src/model';
const native=globalThis.px.util;
prepareCat();
const motion=new CatMotion(()=>.37);
const states=['idle','speaking','thinking','sleep','listening','wake','error'];
const snapshot=r=>({step:r.step,count:r.count,pixels:r.pixels,
    runs:Array.from({length:r.count},(_,i)=>[r.x[i],r.y[i],r.width[i]])});
let cases=0;
try{
    for(let i=0;i<240;i++){
        // 250ms 就切换状态，刻意覆盖尚未完成的多形态混合被再次打断。
        const pose=motion.sample(states[Math.floor(i/5)%states.length],i*50,Math.sin(i/7),Math.cos(i/11),i%101);
        for(const scale of [4.4,7.8,14]){
            globalThis.px={};const expected=snapshot(rasterizeCat(pose,scale,240,220));
            globalThis.px={util:native};const actual=snapshot(rasterizeCat(pose,scale,240,220));
            if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('小猫投影不一致: '+i+' '+scale);
            cases++;
        }
    }
}finally{globalThis.px={util:native}}
const log=typeof print==='function'?print:console.log;
log('720 个小猫姿态/缩放/中断过渡与原 JS 数学定义完全一致');
`;

const simulator = await build({ entryPoints: [join(root, 'simulator/src/renderer/src/device-sim/sandbox/runtime/projection.ts')], bundle: true, write: false, format: 'esm' });
const util = await import(`data:text/javascript;base64,${Buffer.from(simulator.outputFiles[0].text).toString('base64')}`);
const weights = new Float32Array([.13,.27,.2,.4]);
const shapes = Array.from(weights, (_, k) => Float32Array.from({ length: 300 }, (_, i) => Math.sin(i * 3 + k) * 20));
const output = new Float32Array(306), expected = new Float32Array(300);
for (let k = 0; k < shapes.length; k++) for (let i = 0; i < expected.length; i++) expected[i] += shapes[k][i] * weights[k];
util.blendPoints(shapes, weights, output.subarray(3, 303));
assert.deepEqual(output.subarray(3, 303), expected);
assert.equal(output[0] + output[305], 0);
assert.throws(() => util.blendPoints(shapes, weights, shapes[0]));
assert.throws(() => util.blendPoints(shapes, new Float32Array([NaN,0,0,1]), new Float32Array(300)));

const bundled = await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2020' });
const previous = globalThis.px;
try {
    globalThis.px = { util };
    await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
} finally { if (previous === undefined) delete globalThis.px; else globalThis.px = previous; }

if (process.argv[2]) {
    const outputDir = join(root, 'firmware/build/jsvm-host');
    mkdirSync(outputDir, { recursive: true });
    const path = join(outputDir, 'cat-projection-check.js');
    writeFileSync(path, bundled.outputFiles[0].text);
    const result = spawnSync(resolve(process.argv[2]), [path], { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, '真实 QuickJS + C++ 小猫投影检查失败');
}
