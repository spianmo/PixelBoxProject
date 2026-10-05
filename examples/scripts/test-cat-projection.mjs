import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = `
import {CAT_SHAPES,CAT_SURFACE,CAT_BOUNDARY_INDICES,CatMotion,packedCat,rasterizeCat,prepareCat} from './examples/06-obeing-pixel/src/model';
import {drawHarness} from './examples/07-obeing-harness/src/render';
import {initialState} from './examples/06-obeing-pixel/src/state';
const native=globalThis.px.util;
prepareCat();
const motion=new CatMotion(()=>.37);
const states=['idle','speaking','thinking','sleep','listening','wake','error'];
const snapshot=r=>({step:r.step,count:r.count,
    runs:Array.from({length:r.count},(_,i)=>Array.from(r.runs.subarray(i*3,i*3+3)))});
const equal=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+': '+JSON.stringify(a)+' !== '+JSON.stringify(b))};
const fullGrid=new Int32Array(CAT_SURFACE.length*2),box=new Int32Array(4);
let boundsCases=0;
function checkBounds(pose,scale,cx,cy){
    if(typeof native.projectPointBounds!=='function')return;
    const points=packedCat(pose),opts={...pose,scale,cx,cy,grid:Math.max(2,Math.round(scale))};
    native.projectPoints(points,opts,fullGrid);
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(let i=0;i<fullGrid.length;i+=2){
        if(fullGrid[i]<minX)minX=fullGrid[i];if(fullGrid[i]>maxX)maxX=fullGrid[i];
        if(fullGrid[i+1]<minY)minY=fullGrid[i+1];if(fullGrid[i+1]>maxY)maxY=fullGrid[i+1];
    }
    equal(native.projectPointBounds(points,opts,box,CAT_BOUNDARY_INDICES),CAT_BOUNDARY_INDICES.length,'边界点计数');
    equal(Array.from(box),[minX,minY,maxX,maxY],'凸包边界与全点边界 '+boundsCases);
    boundsCases++;
}
let cases=0;
try{
    for(let i=0;i<240;i++){
        // 250ms 就切换状态，刻意覆盖尚未完成的多形态混合被再次打断。
        const pose=motion.sample(states[Math.floor(i/5)%states.length],i*50,Math.sin(i/7),Math.cos(i/11),i%101);
        for(const scale of [4.4,7.8,14]){
            globalThis.px={};const expected=snapshot(rasterizeCat(pose,scale,240,220));
            globalThis.px={util:native};const actual=snapshot(rasterizeCat(pose,scale,240,220));
            if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('小猫投影不一致: '+i+' '+scale);
            checkBounds(pose,scale,240,220);
            cases++;
        }
    }
}finally{globalThis.px={util:native}}
const log=typeof print==='function'?print:console.log;
log('720 个小猫姿态/缩放/中断过渡与原 JS 数学定义完全一致');
let seed=0x5a171ca7;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296};
for(const shape of CAT_SHAPES)for(let i=0;i<100;i++)
    checkBounds({shape,yaw:(random()-.5)*6.28,pitch:(random()-.5)*3.1,lift:(random()-.5)*18,squash:random()*.8+.5},random()*23+1,random()*480,random()*480);
for(let i=0;i<1000;i++){
    const weights=Float32Array.from(CAT_SHAPES,()=>random()),total=weights.reduce((a,b)=>a+b,0);
    for(let j=0;j<weights.length;j++)weights[j]/=total;
    checkBounds({weights,yaw:(random()-.5)*6.28,pitch:(random()-.5)*3.1,lift:(random()-.5)*18,squash:random()*.8+.5},random()*23+1,random()*480,random()*480);
}
if(boundsCases)log(boundsCases+' 个姿态的 '+CAT_BOUNDARY_INDICES.length+' 点凸包与 '+CAT_SURFACE.length+' 点完整投影边界完全一致');
function screen(width,height){
    const pixels=new Uint32Array(width*height);
    const s={width,height,pixels,clear(color=0){pixels.fill(color)},
        fillRect(x,y,w,h,color){for(let yy=Math.max(0,y);yy<Math.min(height,y+h);yy++)pixels.fill(color,yy*width+Math.max(0,x),yy*width+Math.min(width,x+w))},
        fillRects(rects,count){for(let i=0;i<count;i++)s.fillRect(...rects.subarray(i*5,i*5+5))},
        drawText(){},measureText(text,style){return{width:Array.from(text).length*6*(style?.scale||1),height:12*(style?.scale||1)}}};
    return s;
}
const form={page:'assistant',returnPage:'assistant',field:'question',values:{},upper:false,symbols:false,busy:false,speechReady:false};
const view=initialState();Object.assign(view,{connected:true,authenticated:true});
const fallback={...native,projectPointBounds:undefined};
let frames=0;
if(typeof native.projectPointBounds==='function')for(const width of [320,368,480])for(const fullscreen of [false,true]){
    const optimized=screen(width,width),reference=screen(width,width),m=new CatMotion(()=>.37);
    for(let i=0;i<36;i++){
        const state=states[Math.floor(i/5)%states.length],clock=i*53,tiltX=Math.sin(i/6),tiltY=Math.cos(i/9);
        view.state=state;view.level=i*7%100;view.theme=i<18?'dark':'light';
        const pose=m.sample(state,clock,tiltX,tiltY,view.level),input={clock,tiltX,tiltY,battery:80,settings:false,fullscreen,pose};
        globalThis.px={util:fallback};drawHarness(reference,view,input,form);
        globalThis.px={util:native};drawHarness(optimized,view,input,form);
        for(let j=0;j<optimized.pixels.length;j++)if(optimized.pixels[j]!==reference.pixels[j])throw Error('边界拟合画面不一致 '+width+' '+fullscreen+' '+i+' '+j);
        frames++;
    }
}
globalThis.px={util:native};if(frames)log(frames+' 帧 example07：凸包拟合与原全点拟合逐像素一致');
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
const emptyBounds = new Int32Array([1,2,3,4]);
assert.equal(util.projectPointBounds(new Float32Array(), {}, emptyBounds), 0);
assert.deepEqual(emptyBounds, new Int32Array(4));
assert.throws(() => util.projectPointBounds(shapes[0], {}, new Int32Array(3)), RangeError);
assert.throws(() => util.projectPointBounds(shapes[0], {}, emptyBounds, new Int32Array([0])), TypeError);
assert.throws(() => util.projectPointBounds(shapes[0], {}, emptyBounds, new Uint32Array([100])), RangeError);
assert.throws(() => util.projectPointBounds(shapes[0], {}, emptyBounds, new Uint32Array(8193)), RangeError);
const aliasedBounds = new ArrayBuffer(1200);
assert.throws(() => util.projectPointBounds(new Float32Array(aliasedBounds), {}, new Int32Array(aliasedBounds, 0, 4)), RangeError);
for (const victim of ['input', 'output', 'indices']) {
    const input = new Float32Array([1,2,3]), target = new Int32Array(4), indices = new Uint32Array([0]);
    const option = { get yaw() { structuredClone({input,output:target,indices}[victim].buffer, { transfer: [{input,output:target,indices}[victim].buffer] }); return 0; } };
    assert.throws(() => util.projectPointBounds(input, option, target, indices), TypeError);
}

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
    // 旧 ESP-IDF 宿主只接收脚本路径；NuttX 宿主的超时和堆参数由调用方显式传入。
    const result = spawnSync(resolve(process.argv[2]), [...process.argv.slice(3), path], { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, '真实 QuickJS + 原生小猫投影检查失败');
}
