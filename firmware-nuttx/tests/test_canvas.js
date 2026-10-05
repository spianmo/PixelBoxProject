const check = (value, message) => { if (!value) throw new Error(message); };
const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
function throws(fn, Type, label) {
  try { fn(); } catch (error) { check(error instanceof Type, label + ': ' + error); return; }
  throw new Error(label + ': did not throw');
}
const rect = (x=0,y=0,w=1,h=1,c=0xffffff) => new Int32Array([x,y,w,h,c]);
const {fillRects} = native;
const output = new Uint32Array([0xaabbccdd,0,0,0,0,0,0,0x12345678]);
const input = new Int32Array([123,0,0,2,2,-1,456]);
equal(fillRects(output.subarray(1,7),3,2,input.subarray(1,6),1),{x:0,y:0,width:2,height:2},'native clipped dirty bounds');
equal([...output],[0xaabbccdd,0xffffff,0xffffff,0,0xffffff,0xffffff,0,0x12345678],'both view offsets and sentinels');
equal([...input],[123,0,0,2,2,-1,456],'rectangle input unchanged');

for (const value of [null,[],new Int32Array(4),new Float32Array(4),new DataView(new ArrayBuffer(16))])
  throws(()=>fillRects(value,2,2,rect(),1),TypeError,'pixel typed array');
for (const value of [null,[],new Uint32Array(5),new Float32Array(5),new DataView(new ArrayBuffer(20))])
  throws(()=>fillRects(new Uint32Array(4),2,2,value,1),TypeError,'rectangle typed array');
for (const dim of [NaN,Infinity,-Infinity,-1,0,1.5,2049,2147483647]) {
  throws(()=>fillRects(new Uint32Array(4),dim,2,rect(),1),RangeError,'width validation');
  throws(()=>fillRects(new Uint32Array(4),2,dim,rect(),1),RangeError,'height validation');
}
for (const count of [NaN,Infinity,-Infinity,-1,.5,8193,2147483647])
  throws(()=>fillRects(new Uint32Array(4),2,2,rect(),count),RangeError,'count validation');
throws(()=>fillRects(new Uint32Array(3),2,2,rect(),1),RangeError,'small pixel view');
throws(()=>fillRects(new Uint32Array(4),2,2,rect().subarray(0,4),1),RangeError,'small rectangle view');
const noOp=new Uint32Array([1,2,3,4]);equal(fillRects(noOp,2,2,new Int32Array(0),0),null,'empty dirty bounds');
equal([...noOp],[1,2,3,4],'empty rectangle list');
const maxSize=new Canvas(2048,2048);maxSize.fillRects(rect(2047,2047,2147483647,2147483647,0xabcdef));
equal(maxSize.getPixel(2047,2047),0xabcdef,'max canvas boundary');maxSize.dispose();
const maxCount=new Canvas(1,1), many=new Int32Array(8192*5);
many.set([0,0,1,1,0x445566],many.length-5);maxCount.fillRects(many);
equal(maxCount.getPixel(0,0),0x445566,'maximum count');

// 所有执行用户代码的转换必须先完成；getter分离后的地址不能继续使用。
for (const field of [1,2,4]) for(const victim of ['pixels','rectangles']) {
  const pixels=new Uint32Array(4), rectangles=rect(), args=[pixels,2,2,rectangles,1];
  const value=args[field];
  args[field]={valueOf(){detach((victim==='pixels'?pixels:rectangles).buffer);return value;}};
  throws(()=>fillRects(...args),TypeError,'valueOf detach '+field+' '+victim);
}
for (const victim of ['pixels','rectangles']) {
  const pixels=new Uint32Array(4),rectangles=rect();detach((victim==='pixels'?pixels:rectangles).buffer);
  throws(()=>fillRects(pixels,2,2,rectangles,1),TypeError,'already detached '+victim);
}
const marker=new Error('valueOf failed'), conversions=[];
try {fillRects(new Uint32Array(4),{valueOf(){throw marker;}},2,rect(),1);throw new Error('missing failure');}
catch(error){check(error===marker,'conversion error identity');}
fillRects(new Uint32Array(4),{valueOf(){conversions.push('w');return 2;}},
  {valueOf(){conversions.push('h');return 2;}},rect(),{valueOf(){conversions.push('n');return 1;}});
equal(conversions,['w','h','n'],'conversion order');
const getterCanvas=new Canvas(2,2),getterPixels=getterCanvas._pixels,getterRects=rect();
Object.defineProperty(getterCanvas,'_pixels',{get(){detach(getterRects.buffer);return getterPixels;}});
throws(()=>getterCanvas.fillRects(getterRects,1),RangeError,'Canvas pixel getter detaches rectangles before count check');
const lengthCanvas=new Canvas(2,2),lengthRects=rect();
Object.defineProperty(lengthRects,'length',{get(){detach(lengthCanvas._pixels.buffer);return 5;}});
throws(()=>lengthCanvas.fillRects(lengthRects),TypeError,'Canvas rectangle length getter detaches pixels');
const dead=new Canvas(1,1);dead.dispose();throws(()=>dead.fillRects(rect()),Error,'disposed Canvas');

// 用已有逐矩形 Canvas 实现作为语义参照，覆盖INT32极值与确定性随机裁剪。
function referenceFill(canvas,x,y,width,height,color) {
  x|=0;y|=0;width|=0;height|=0;
  const right=Math.min(canvas.width,x+width),bottom=Math.min(canvas.height,y+height);
  if(width<=0||height<=0||x>=canvas.width||y>=canvas.height||right<=0||bottom<=0)return;
  for(let row=Math.max(0,y);row<bottom;++row)
    canvas._pixels.fill(color&0xffffff,row*canvas.width+Math.max(0,x),row*canvas.width+Math.max(0,right));
  canvas._markDirty(x,y,width,height);
}
const edges=[-2147483648,-2147483647,-100,-1,0,1,3,10,2147483646,2147483647];
let seed=0x734123aa;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return seed>>>0;};
for(let pass=0;pass<400;pass++) {
  const w=1+random()%23,h=1+random()%17,batched=new Canvas(w,h),reference=new Canvas(w,h);
  const rs=new Int32Array(1+pass%31*5+4).subarray(1); // 带偏移，最后4项留作尾部容量。
  const count=Math.floor(rs.length/5);
  for(let i=0;i<count;i++) {
    const values=Array.from({length:4},()=>random()%3===0?edges[random()%edges.length]:(random()%60)-20);
    rs.set([...values,random()],i*5);
    referenceFill(reference,...rs.subarray(i*5,i*5+5));
  }
  const before=[...rs];batched.fillRects(rs,count);
  equal([...batched._pixels],[...reference._pixels],'clipped pixel equivalence '+pass);
  equal(batched._dirty,reference._dirty,'clipped dirty equivalence '+pass);
  equal([...rs],before,'source lifetime '+pass);
}

// 共享owner不引发越界；不重叠视图保持矩形数据，重叠视图按逐矩形顺序读取。
const shared=new ArrayBuffer(64),sharedPixels=new Uint32Array(shared,0,4),sharedRects=new Int32Array(shared,20,5);
sharedRects.set([0,0,2,2,0x987654]);fillRects(sharedPixels,2,2,sharedRects,1);
equal([...sharedPixels],[0x987654,0x987654,0x987654,0x987654],'shared owner disjoint views');
equal([...sharedRects],[0,0,2,2,0x987654],'shared owner source stable');
const alias=new Int32Array([0,0,5,1,0x112233,0,0,1,1,0xabcdef]);
fillRects(new Uint32Array(alias.buffer),10,1,alias,2);
equal([...new Uint32Array(alias.buffer).subarray(0,5)],[0xabcdef,0x112233,0x112233,0x112233,0x112233],'overlap defined sequential reads');

// 原生大批次不等完成才处理停止：一次全屏矩形也会在行间检查，屏外批次同样检查。
const interrupted=new Canvas(128,128);armInterrupt(1);
throws(()=>interrupted.fillRects(rect(0,0,128,128,7)),InternalError,'interruption inside one large rectangle');
equal(interrupted._pixels.reduce((n,v)=>n+(v===7),0),4096,'bounded pixels before interruption');
armInterrupt(1);
throws(()=>new Canvas(1,1).fillRects(new Int32Array(128*5)),InternalError,'clipped rectangles poll interruption');
armInterrupt(-1);

// 相同像素允许省去内存写回，但不能漏掉组内任一不同像素或改变脏区契约。
for (const width of [1,7,8,9,15,16,17,31,32,33]) for(let offset=0;offset<4;offset++) {
  for(let changed=-1;changed<width;changed++) {
    const backing=new Uint32Array(offset+width+4).fill(0xdeadbeef);
    const view=backing.subarray(offset,offset+width);view.fill(0x13579b);
    if(changed>=0)view[changed]=changed%2?0x13579a:0xff13579b;
    const dirty=fillRects(view,width,1,rect(0,0,width,1,0x13579b),1);
    equal(dirty,{x:0,y:0,width,height:1},'same-color dirty bounds');
    check(view.every(pixel=>pixel===0x13579b),'same-color span contents '+width+'/'+changed);
    check(backing.subarray(0,offset).every(pixel=>pixel===0xdeadbeef)&&
      backing.subarray(offset+width).every(pixel=>pixel===0xdeadbeef),'same-color span sentinels');
  }
}
const unchangedInterrupt=new Canvas(128,128);unchangedInterrupt._pixels.fill(7);armInterrupt(1);
throws(()=>unchangedInterrupt.fillRects(rect(0,0,128,128,7)),InternalError,'unchanged spans still poll interruption');
armInterrupt(-1);

// 横竖线快路径逐像素对照原 Bresenham，验证闭区间、反向、裁剪和稀疏脏区。
function referenceLine(canvas,x0,y0,x1,y1,color) {
  x0|=0;y0|=0;x1|=0;y1|=0;
  const dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
  if(dx>1000000||-dy>1000000)throw new RangeError('line coordinates too large');
  let e=dx+dy;
  for(;;){canvas.setPixel(x0,y0,color);if(x0===x1&&y0===y1)break;const e2=e*2;
    if(e2>=dy){e+=dy;x0+=sx;}if(e2<=dx){e+=dx;y0+=sy;}}
}
for(let pass=0;pass<600;pass++) {
  const w=1+random()%41,h=1+random()%37,a=new Canvas(w,h),b=new Canvas(w,h);
  for(const canvas of [a,b]){
    canvas._changedRows=new Uint16Array(h*2);
    canvas._dirtyBlocks=new Uint32Array(Math.ceil(w/256)*h);
  }
  let x0=random()%100-30,x1=random()%100-30,y0=random()%90-30,y1=random()%90-30;
  if(pass%3===0)x1=x0;else if(pass%3===1)y1=y0;
  const color=random()|1;
  a.drawLine(x0,y0,x1,y1,color);referenceLine(b,x0,y0,x1,y1,color);
  equal([...a._pixels],[...b._pixels],'line pixels '+pass);
  equal(a._dirty,b._dirty,'line dirty bbox '+pass);
  equal([...a._changedRows],[...b._changedRows],'line dirty rows '+pass);
  equal([...a._dirtyBlocks],[...b._dirtyBlocks],'line dirty blocks '+pass);
}
for(const coords of [[1.9,2.9,4.8,2.3],['4','2','0','2'],[NaN,0,3,0],
  [2147483647,0,2147483646,0],[-2147483648,0,-2147483647,0]]) {
  const a=new Canvas(8,8),b=new Canvas(8,8);
  a.drawLine(...coords,0xffffff);referenceLine(b,...coords,0xffffff);
  equal([...a._pixels],[...b._pixels],'line coercion '+coords);
}
for(const coords of [[0,0,1000001,0],[0,0,0,-1000001]])
  throws(()=>new Canvas(8,8).drawLine(...coords,1),RangeError,'line range check before fast path');
let lineColorCalls=0;const lineObjectColor={valueOf(){return ++lineColorCalls;}};
const sideEffectLine=new Canvas(4,1);sideEffectLine.drawLine(0,0,3,0,lineObjectColor);
equal([...sideEffectLine._pixels],[1,2,3,4],'object color per-pixel conversion');

// 原生行缓存拷贝对照原逐像素实现：裁剪、输入偏移、负坐标、重叠与透明色。
for(let n=0;n<700;n++) {
  const src=new Canvas(19,17),a=new Canvas(23,21),b=new Canvas(23,21);
  for(let i=0;i<src._pixels.length;i++)src._pixels[i]=(i*7919+n*31)&0xffffff;
  a._pixels.fill(123);b._pixels.fill(123);
  a._changedRows=new Uint16Array(42);a._dirtyBlocks=new Uint32Array(21);
  const x=n%31-12,y=n%27-10,sx=n%25-4,sy=n%23-3,w=n%24,h=n%22;
  for(let row=0;row<h;row++)for(let col=0;col<w;col++) {
    const u=sx+col,v=sy+row;
    if(u>=0&&v>=0&&u<19&&v<17)b.setPixel(x+col,y+row,src._pixels[v*19+u]);
  }
  native.blitCanvas(a._pixels,a.width,a.height,src._pixels,src.width,src.height,x,y,sx,sy,w,h,a._changedRows,a._dirtyBlocks);
  equal([...a._pixels],[...b._pixels],'blit clipping '+n);
  for(let i=0;i<a._pixels.length;i++)if(a._pixels[i]!==123) {
    const py=Math.floor(i/23),px=i%23;
    check(a._changedRows[py*2]&&a._changedRows[py*2]<=px+1&&a._changedRows[py*2+1]>px,'blit changed row');
    check(a._dirtyBlocks[py]&(1<<(px>>3)),'blit changed block');
  }
}
{
 const a=new Canvas(3,1),b=new Canvas(3,1);a._pixels.set([1,2,3]);
 b.drawImage(a,0,0,{colorKey:2});equal([...b._pixels],[1,0,3],'color key fallback');
 let reads=0;b.drawImage(a,0,0,{get colorKey(){reads++;return undefined;}});
 equal(reads,3,'color key getter once per pixel');
 a.drawImage(a,1,0);equal([...a._pixels],[1,1,2],'overlap snapshot');
}
{
 const a=new Canvas(8,8),b=new Canvas(8,8);
 throws(()=>native.blitCanvas(a._pixels,8,8,a._pixels,8,8,0,0,0,0,8,8),RangeError,'native alias reject');
 throws(()=>native.blitCanvas(a._pixels,8,8,b._pixels,8,8,0,0,0,0,8,8,new Uint16Array(2)),RangeError,'native invalid tracker');
 const buf=b._pixels.buffer;
 throws(()=>native.blitCanvas(a._pixels,8,8,b._pixels,8,8,{valueOf(){detach(buf);return 0;}},0,0,0,8,8),TypeError,'blit getter detaches');
}
{
 const a=new Canvas(129,64),b=new Canvas(129,64);b.clear(7);
 a._changedRows=new Uint16Array(128);a._dirtyBlocks=new Uint32Array(64);
 armInterrupt(0);
 throws(()=>a.drawImage(b,0,0),InternalError,'blit interruption');armInterrupt(-1);
 equal(a._dirty,{x:0,y:0,right:129,bottom:64},'blit failed prefix dirty');
}
