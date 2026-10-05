const check = (value, message) => { if (!value) throw new Error(message); };
const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
function throws(fn, Type, label) {
  try { fn(); } catch (error) { check(error instanceof Type, label + ': ' + error); return; }
  throw new Error(label + ': did not throw');
}
const {blendPoints, projectPoints, projectPointRuns, projectPointBounds} = native;
const f32 = values => new Float32Array(values);

// 输出子视图两侧的哨兵不能被改写，输入/权重子视图也必须尊重 byteOffset。
const a = f32([999, 1, 2, 3, 999]).subarray(1,4), b = f32([8, 6, 4]);
const weights = f32([999, .25, .75, 999]).subarray(1,3);
const blended = f32([111, 0, 0, 0, 222]);
blendPoints([a,b], weights, blended.subarray(1,4));
equal([...blended], [111,6.25,5,3.75,222], 'blend offset');
const coords = new Int32Array([111,0,0,222]);
projectPoints(f32([999,1,2,0,999]).subarray(1,4), {}, coords.subarray(1,3));
equal([...coords], [111,1,2,222], 'project offset');
const runs = new Int32Array([111,0,0,0,222]);
equal(projectPointRuns(f32([1,2,0]), {}, runs.subarray(1,4)), 1, 'run count');
equal([...runs], [111,1,2,1,222], 'run offset');
const box = new Int32Array([111,0,0,0,0,222]);
equal(projectPointBounds(f32([1,2,0,-3,5,0]), {}, box.subarray(1,5)), 2, 'bounds count');
equal([...box], [111,-3,2,1,5,222], 'bounds offset');
equal(projectPointBounds(f32([1,2,0,-3,5,0]), {}, box.subarray(1,5), new Uint32Array([9,1,9]).subarray(1,2)), 1, 'indexed bounds count');
equal([...box], [111,-3,5,-3,5,222], 'indexed bounds offset');
equal(projectPointBounds(f32(0), {}, box.subarray(1,5)), 0, 'empty bounds count');
equal([...box], [111,0,0,0,0,222], 'empty bounds reset');
for (const indices of [[], new Int32Array([0]), new Float32Array([0])])
  throws(()=>projectPointBounds(a,{},new Int32Array(4),indices),TypeError,'bounds indices type');
throws(()=>projectPointBounds(a,{},new Int32Array(3)),RangeError,'bounds output size');
throws(()=>projectPointBounds(a,{},new Int32Array(4),new Uint32Array([1])),RangeError,'bounds index range');
throws(()=>projectPointBounds(a,{},new Int32Array(4),new Uint32Array(8193)),RangeError,'bounds indices length');

for (const value of [[],new Float64Array(3),new Uint32Array(3),new DataView(new ArrayBuffer(12)),null]) {
  throws(()=>blendPoints([value],f32([1]),f32(3)),TypeError,'blend input type');
  throws(()=>projectPoints(value,{},new Int32Array(2)),TypeError,'projection input type');
}
for (const size of [1,2,24579]) {
  throws(()=>blendPoints([f32(size)],f32([1]),f32(size)),RangeError,'blend size');
  throws(()=>projectPoints(f32(size),{},new Int32Array(size)),RangeError,'project size');
}
for (const weight of [NaN,Infinity,-Infinity]) throws(()=>blendPoints([a],f32([weight]),f32(3)),RangeError,'nonfinite weight');
const shared = new ArrayBuffer(64);
throws(()=>blendPoints([new Float32Array(shared,0,3)],f32([1]),new Float32Array(shared,16,3)),RangeError,'disjoint same-owner blend');
throws(()=>blendPoints([a],new Float32Array(shared,0,1),new Float32Array(shared,16,3)),RangeError,'weights alias');
throws(()=>projectPoints(new Float32Array(shared,0,3),{},new Int32Array(shared,16,2)),RangeError,'disjoint same-owner projection');
throws(()=>projectPointBounds(new Float32Array(shared,0,3),{},new Int32Array(shared,16,4)),RangeError,'disjoint same-owner bounds');
equal(projectPointRuns(f32(0),{},new Int32Array(0)),0,'empty runs');
projectPoints(f32(0),{},new Int32Array(0));
blendPoints([f32(0)],f32([1]),f32(0));

// 每个可执行 getter/valueOf 都在取底层地址之前完成；不能使用已经分离的地址。
for (const victim of ['input','output','weights']) {
  const input = f32([1,2,3]), output = f32(3), ws = f32([1]);
  const list = [];
  Object.defineProperty(list,0,{get(){detach(({input,output,weights:ws})[victim].buffer);return input;}});
  throws(()=>blendPoints(list,ws,output),TypeError,'blend getter detach '+victim);
}
for (const method of [projectPoints,projectPointRuns,projectPointBounds]) for (const victim of ['input','output']) {
  for (const kind of ['getter','valueOf']) {
    const input=f32([1,2,3]), output=new Int32Array(4), options={};
    const run=()=>{detach((victim==='input'?input:output).buffer);return 1;};
    Object.defineProperty(options,'scale',{get:kind==='getter'?run:()=>({valueOf:run})});
    throws(()=>method(input,options,output),TypeError,'project detach '+victim+' '+kind);
  }
}
const detachedIndices = new Uint32Array([0]);
throws(()=>projectPointBounds(a,{get yaw(){detach(detachedIndices.buffer);return 0;}},new Int32Array(4),detachedIndices),TypeError,'bounds indices detach');
const marker = new Error('getter failure');
try { projectPoints(a,{get yaw(){throw marker;}},new Int32Array(2)); throw new Error('missing getter throw'); }
catch(error) { check(error===marker,'getter exception preserved'); }
const sequence=[];
const opts={};for(const key of ['yaw','pitch','squash','lift','scale','cx','cy','distance','grid']) Object.defineProperty(opts,key,{get(){sequence.push(key);return undefined;}});
projectPoints(a,opts,new Int32Array(2));equal(sequence,['yaw','pitch','squash','lift','scale','cx','cy','distance','grid'],'option order');
for(const key of sequence) for(const invalid of [NaN,Infinity,-Infinity]) throws(()=>projectPoints(a,{[key]:invalid},new Int32Array(2)),RangeError,'nonfinite option '+key);
for(const values of [[NaN,0,0],[0,Infinity,0],[0,0,64],[0,0,65],[2147483648,0,0],[-2147483904,0,0]]) throws(()=>projectPoints(f32(values),{},new Int32Array(2)),RangeError,'invalid projection range');

// 65536 格是实际掩码边界；稀疏巨大坐标不能通过整数乘法溢出绕过它。
equal(projectPointRuns(f32([0,0,0,255,255,0]),{},new Int32Array(6)),2,'65536 cell grid');
throws(()=>projectPointRuns(f32([0,0,0,256,255,0]),{},new Int32Array(6)),RangeError,'overfull grid');
throws(()=>projectPointRuns(f32([-2147483648,-2147483648,0,2147483520,2147483520,0]),{},new Int32Array(6)),RangeError,'huge grid');
const edge=new Int32Array(4);projectPoints(f32([-2147483648,0,0,2147483520,0,0]),{},edge);equal([...edge],[-2147483648,0,2147483520,0],'int32 edges');

// 使用同一逐运算 Double 定义和每次 Float32 舍入，覆盖取消相加/半格附近的小数。
let seed=0x71aa2233;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return (seed>>>0)/4294967296;};
for(let test=0;test<500;test++) {
  const sets=Array.from({length:1+test%7},()=>Float32Array.from({length:33},()=>Math.sign(random()-.5)*Math.pow(2,Math.floor(random()*50)-25)*(random()+.5)));
  const ws=Float32Array.from(sets,()=>random()<.2?0:(random()-.5)*4), output=f32(33), reference=f32(33);
  for(let i=0;i<sets.length;i++) if(ws[i]!==0) for(let j=0;j<33;j++) reference[j]+=sets[i][j]*ws[i];
  blendPoints(sets,ws,output);
  equal([...new Uint32Array(output.buffer)],[...new Uint32Array(reference.buffer)],'Float32 accumulation '+test);
  const p=Float32Array.from({length:96},()=> (random()-.5)*20);
  const o={yaw:(random()-.5)*8,pitch:(random()-.5)*4,squash:random()+.5,lift:random()*10,scale:random()*15+.1,cx:(random()-.5)*100,cy:(random()-.5)*100,distance:64,grid:1+test%7};
  const out=new Int32Array(64), expected=[];
  const ca=Math.cos(o.yaw),sa=Math.sin(o.yaw),cb=Math.cos(o.pitch),sb=Math.sin(o.pitch);
  for(let i=0;i<p.length;i+=3){
    const x=p[i]*ca+p[i+2]*sa,z=-p[i]*sa+p[i+2]*ca,y=p[i+1]*o.squash*cb-z*sb,depth=p[i+1]*sb+z*cb;
    const perspective=o.distance/(o.distance-depth);
    expected.push(Math.floor(Math.floor(o.cx+x*o.scale*perspective+.5)/o.grid+.5),Math.floor(Math.floor(o.cy+y*o.scale*perspective+o.lift+.5)/o.grid+.5));
  }
  projectPoints(p,o,out);equal([...out],expected,'Double projection '+test);
  const boundsOut=new Int32Array(4), selected=new Uint32Array([0,5,19,31]);
  equal(projectPointBounds(p,o,boundsOut),32,'random bounds count '+test);
  equal([...boundsOut],[Math.min(...expected.filter((_,i)=>i%2===0)),Math.min(...expected.filter((_,i)=>i%2===1)),Math.max(...expected.filter((_,i)=>i%2===0)),Math.max(...expected.filter((_,i)=>i%2===1))],'Double bounds '+test);
  const xs=[...selected].map(i=>expected[i*2]),ys=[...selected].map(i=>expected[i*2+1]);
  equal(projectPointBounds(p,o,boundsOut,selected),4,'random indexed bounds count '+test);
  equal([...boundsOut],[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],'Double indexed bounds '+test);
  // 令平移恰好抵消投影，使结果落在半像素边界；这里会放大隐式 FMA 的舍入差异。
  const px=p[0]*ca+p[2]*sa,pz=-p[0]*sa+p[2]*ca,pdepth=p[1]*sb+pz*cb;
  const correction=px*o.scale*(o.distance/(o.distance-pdepth));
  const boundary={...o,cx:100.5-correction,grid:1};
  const precise=Math.floor(Math.floor(boundary.cx+correction+.5)+.5);
  const boundaryOut=new Int32Array(2);
  projectPoints(p.subarray(0,3),boundary,boundaryOut);
  equal(boundaryOut[0],precise,'projection half-pixel rounding '+test);
}

function referenceProjection(points,options={}) {
  const o={yaw:0,pitch:0,squash:1,lift:0,scale:1,cx:0,cy:0,distance:64,grid:1,...options};
  const ca=Math.cos(o.yaw),sa=Math.sin(o.yaw),cb=Math.cos(o.pitch),sb=Math.sin(o.pitch),result=[];
  for(let i=0;i<points.length;i+=3) {
    const x=points[i]*ca+points[i+2]*sa,z=-points[i]*sa+points[i+2]*ca;
    const y=points[i+1]*o.squash*cb-z*sb,depth=points[i+1]*sb+z*cb;
    const perspective=o.distance/(o.distance-depth);
    result.push(Math.floor(Math.floor(o.cx+x*o.scale*perspective+.5)/o.grid+.5),
      Math.floor(Math.floor(o.cy+y*o.scale*perspective+o.lift+.5)/o.grid+.5));
  }
  return result;
}
function verifyProjection(points,options,label) {
  const expected=referenceProjection(points,options),out=new Int32Array(expected.length),bounds=new Int32Array(4);
  projectPoints(points,options,out);equal([...out],expected,label+' coords');
  const xs=expected.filter((_,i)=>i%2===0),ys=expected.filter((_,i)=>i%2===1);
  equal(projectPointBounds(points,options,bounds),points.length/3,label+' count');
  equal([...bounds],[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],label+' bounds');
}

// 确认真实快路径被覆盖；奇偶网格和负坐标的第二层舍入必须逐格等同 JS。
const gridPoints=f32(Array.from({length:129},(_,i)=>[(i-64)/4,(64-i)/4,0]).flat());
const gridBefore=projectionStats();
for(let grid=1;grid<=64;grid++) verifyProjection(gridPoints,{scale:16,cx:-512,cy:512,grid},'integer grid '+grid);
equal(projectionStats().fast-gridBefore.fast,129*64*2,'integer grids use fast path');
equal(projectionStats().fallback,gridBefore.fallback,'integer grids avoid Double fallback');

// Double 参数转 Float 的误差和取消相加会跨格；边界两侧必须进入精确回退。
const halfPoint=f32([9.12345,-7.54321,5.43210]);
const halfOptions={yaw:.314159265358979,pitch:-.2718281828459,squash:1.234567890123,lift:1.234567890123,scale:6.543210987654};
const ca=Math.cos(halfOptions.yaw),sa=Math.sin(halfOptions.yaw),cb=Math.cos(halfOptions.pitch),sb=Math.sin(halfOptions.pitch);
const hx=halfPoint[0]*ca+halfPoint[2]*sa,hz=-halfPoint[0]*sa+halfPoint[2]*ca;
const hy=halfPoint[1]*halfOptions.squash*cb-hz*sb,hd=halfPoint[1]*sb+hz*cb,hp=64/(64-hd);
const halfBefore=projectionStats();
for(const delta of [-Math.pow(2,-20),0,Math.pow(2,-20)]) {
  verifyProjection(halfPoint,{...halfOptions,cx:100.5-hx*halfOptions.scale*hp+delta,
    cy:-100.5-hy*halfOptions.scale*hp-halfOptions.lift+delta},'half boundary '+delta);
}
equal(projectionStats().fallback-halfBefore.fallback,6,'half boundaries use Double fallback');

// 次正规输入、有限域端点和极小正缩放不能受硬件次正规数处理影响。
for(const options of [{},{yaw:Math.PI/4,pitch:-Math.PI/4,squash:2,scale:16,cx:1024,cy:-1024,lift:64},
  {yaw:-Math.PI,pitch:Math.PI/2,squash:-2,scale:Number.MIN_VALUE,cx:-1024,cy:1024,lift:-64}]) {
  verifyProjection(f32([16,-16,16,-16,16,-16,0,0,0,Math.pow(2,-149),-Math.pow(2,-149),Math.pow(2,-149)]),options,'fast domain extremes');
}

// 非整数网格、略超域的 Double 参数以及透视极点附近全部保留原计算。
const fallbackPoint=f32([1.123456,2.234567,3.345678]),outsideBefore=projectionStats();
for(const options of [{grid:1.25},{grid:1+Number.EPSILON},{grid:63.999999999},{grid:65},
  {distance:64+Math.pow(2,-40)},{scale:16+Math.pow(2,-40)},{squash:2+Math.pow(2,-40)},
  {lift:64+Math.pow(2,-40)},{cx:1024+Math.pow(2,-40)},{cy:-1024-Math.pow(2,-40)}]) {
  verifyProjection(fallbackPoint,options,'outside fast options '+JSON.stringify(options));
}
verifyProjection(f32([16.000001,-16.000001,0]),{},'outside fast point');
verifyProjection(f32([.0001,-.0002,63.999996185302734]),{},'near perspective pole');
equal(projectionStats().fallback-outsideBefore.fallback,24,'outside domain uses Double fallback');

// runs 与坐标/边界共享快路径；重建连续行后逐格比较，覆盖去重和负网格坐标。
const runPoints=f32(Array.from({length:41},(_,i)=>[(i%9-4)/2,(Math.floor(i/9)-2)/2,(i%3-1)/2]).flat());
for(const grid of [1,2,3,7,64]) {
  const options={yaw:.31,pitch:-.27,squash:1.1,scale:8,cx:-2.25,cy:3.75,grid};
  const expected=referenceProjection(runPoints,options),cells=new Set();
  for(let i=0;i<expected.length;i+=2) cells.add(expected[i]+','+expected[i+1]);
  const output=new Int32Array(runPoints.length),count=projectPointRuns(runPoints,options,output),actual=[];
  for(let i=0;i<count;i++) for(let x=0;x<output[i*3+2];x++) actual.push((output[i*3]+x)+','+output[i*3+1]);
  equal(actual.sort(),[...cells].sort(),'fast projected runs '+grid);
}
const nonfinite=f32([NaN,Infinity,-Infinity]), result=f32(3);
blendPoints([nonfinite],f32([0]),result);equal([...result],[0,0,0],'zero weight skips NaN');
blendPoints([nonfinite],f32([1]),result);check(Number.isNaN(result[0])&&result[1]===Infinity&&result[2]===-Infinity,'nonfinite points propagate during blend');

// 大输入在原生循环中也必须消费停止信号；已写前缀可保留，未写区域不能被触碰。
const longPoints=new Float32Array(300*3).fill(1),partial=new Float32Array(longPoints.length).fill(-1);
armInterrupt(1);
throws(()=>blendPoints([longPoints],f32([1]),partial),InternalError,'blend interrupt');
equal([...partial.subarray(0,128)],Array(128).fill(1),'blend prefix before stop');
equal(partial[128],-1,'blend stops before next block');
const partialCoords=new Int32Array(600).fill(-1);armInterrupt(1);
throws(()=>projectPoints(longPoints,{},partialCoords),InternalError,'project interrupt');
equal(partialCoords[256],-1,'projection stops at next block');
armInterrupt(1);
throws(()=>projectPointRuns(f32([0,0,0]),{},new Int32Array(3)),InternalError,'mask generation interrupt');
const interruptedBounds=new Int32Array(4).fill(-1);armInterrupt(1);
throws(()=>projectPointBounds(longPoints,{},interruptedBounds),InternalError,'bounds interrupt');
equal([...interruptedBounds],[-1,-1,-1,-1],'bounds commit after successful projection');
armInterrupt(-1);

// 输出连续段对照独立point投影+排序；覆盖65536格和INT32端点平移。
(() => {
  let seed=0x4249173,checks=0;
  const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(const [w,h] of [[65536,1],[1,65536],[256,256],[32768,2],[2,32768],[1,1],[255,257],[17,17]]) {
    for(const [cx,cy] of [[0,0],[-2147483648,-2147483648],[2147483648-w,2147483648-h],[-(w>>1),-(h>>1)]]) {
      for(let round=0;round<8;round++) {
        const p=new Float32Array(128*3);p.set([0,0,0,w-1,h-1,0]);
        for(let i=6;i<p.length;i+=3){p[i]=next()%w;p[i+1]=next()%h;}
        const o={cx,cy},xy=new Int32Array(256),owner=new Int32Array(p.length+2).fill(0x43215678),runs=owner.subarray(1,-1);
        native.projectPoints(p,o,xy);
        const expected=new Set();for(let i=0;i<xy.length;i+=2)expected.add(xy[i]+','+xy[i+1]);
        const count=native.projectPointRuns(p,o,runs),got=[];
        for(let i=0;i<count;i++)for(let x=0;x<runs[i*3+2];x++)got.push((runs[i*3]+x)+','+runs[i*3+1]);
        equal(got.sort(),[...expected].sort(),'mask32 extreme '+w+','+h+','+cx+','+cy+','+round);
        check(owner[0]===0x43215678&&owner[owner.length-1]===0x43215678,'mask32 sentinels');checks++;
      }
    }
  }
  check(checks===256,'all mask32 edge cases executed');
})();
