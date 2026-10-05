import assert from 'node:assert/strict';
import vm from 'node:vm';
import { callbackProbe, metrics, sampleMetrics } from './device-fps-metrics.mjs';
const stats = {frames:100,updates:80,errors:0,convertedPixels:1000,changedPixels:100,
  transactions:80,transmittedPixels:1000,conversionMs:5,updateMs:8};
const before={at:100,id:'test',callbacks:100,stats};
const after={at:2200,id:'test',callbacks:160,stats:{...stats,frames:160,updates:138}};
const result=metrics(before,after);
assert.equal(result.elapsedMs,2100);
assert.equal(result.callbackFps,60000/2100);
assert.equal(result.submittedFps,58000/2100);
assert.throws(()=>metrics(before,{...after,id:'different'}));
assert.throws(()=>metrics(before,{...after,at:before.at}));
assert.throws(()=>metrics(before,{...after,stats:{...after.stats,frames:0}}));
assert.throws(()=>metrics(before,{...after,stats:{...after.stats,errors:1}}));
assert.throws(()=>metrics(before,{...after,stats:{...after.stats,updates:10000}}));
let reads = 0;
const snapshots = [
  before,
  {...before,stats:{...before.stats,frames:20}},
  {...before,at:1000,stats:{...before.stats,frames:200,updates:180}},
  {...before,at:2200,callbacks:160,stats:{...before.stats,frames:260,updates:238}},
];
const recovered = await sampleMetrics(async()=>snapshots[reads++], async()=>{}, 1,
  {maxAttempts:2,settleMs:0});
assert.equal(recovered.attempts, 2);
assert.equal(recovered.frames, 60);
assert.equal(recovered.submittedFps, 58000/1200);
assert.equal(reads, 4);
let registered, removed=false;
const context={px:{screen:{onFrame(fn){registered=fn;return ()=>{removed=true;};}}}};
vm.runInNewContext(callbackProbe,context);
const unsubscribe=context.px.screen.onFrame(dt=>dt===16?false:'draw');
assert.equal(registered(16),false);assert.equal(registered(33),'draw');
assert.equal(context.__deviceFps.callbacks,2);unsubscribe();assert.equal(removed,true);
console.log('PASS device FPS: 单调时间分母、VM切换/计数重置/显示失败拒绝、回调返回值及取消订阅保持');
