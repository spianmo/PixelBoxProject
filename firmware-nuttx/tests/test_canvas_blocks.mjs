import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const prelude=fs.readFileSync(new URL('../src/prelude.js',import.meta.url),'utf8');
const image=fs.readFileSync(new URL('../src/prelude_image.js',import.meta.url),'utf8');
const source=prelude.slice(prelude.indexOf('  class Canvas {'),prelude.indexOf('  px.screen = screen;'));
function setup(width=480,height=5) {
  const draws=[],flushes=[];let failDraw=false,failFlush=false;
  const native={width,height,
    flush(...args){flushes.push({args,rows:args[6]&&[...args[6]],bits:args[7]&&[...args[7]]});if(failFlush)throw Error('flush failed');},
    paint(p,w,h,rs,n,rows,bits){
      draws.push({rows,bits});let dirty=null;
      for(let i=0;i<n;i++) {
        const at=i*5,l=Math.max(0,rs[at]),t=Math.max(0,rs[at+1]),r=Math.min(w,rs[at]+rs[at+2]),b=Math.min(h,rs[at+1]+rs[at+3]),color=rs[at+4];
        if(l>=r||t>=b)continue;
        dirty=dirty?{x:Math.min(l,dirty.x),y:Math.min(t,dirty.y),right:Math.max(r,dirty.right),bottom:Math.max(b,dirty.bottom)}:{x:l,y:t,right:r,bottom:b};
        for(let y=t;y<b;y++)for(let x=l;x<r;x++)if(p[y*w+x]!==color){
          p[y*w+x]=color;
          if(rows){rows[y*2]=rows[y*2]?Math.min(rows[y*2],x+1):x+1;rows[y*2+1]=Math.max(rows[y*2+1],x+1);}
          if(bits)bits[y*Math.ceil(w/256)+(x>>8)]|=1<<((x>>3)&31);
        }
      }
      if(failDraw)throw Error('draw failed');
      return dirty?{x:dirty.x,y:dirty.y,width:dirty.right-dirty.x,height:dirty.bottom-dirty.y}:null;
    },
    fillRects(...args){return this.paint(...args);},
    fillRectLayers(p,w,h,rs,o,rows,bits){void o?.scale;return this.paint(p,w,h,rs,rs.length/5,rows,bits);},
    fillRunLayers(p,w,h,rs,o,rows,bits){return {dirty:this.fillRectLayers(p,w,h,new Int32Array([0,0,16,1,7]),o,rows,bits),bounds:{}};},
    fillRunLayersRestored(p,w,h,rs,o,restore,rows,bits){return this.fillRunLayers(p,w,h,rs,o,rows,bits);},
    drawText(p){p[0]=99;if(failDraw)throw Error('text failed');}
  };
  const state=new Function('native',`const g=globalThis,unsupported=()=>{throw Error('ENOTSUP');},u8=x=>x;${source}\n${image}\nreturn {screen,Canvas,bitsOf:c=>c._dirtyBlocks};`)(native);
  return {...state,native,draws,flushes,setDrawFailure:value=>{failDraw=value;},setFlushFailure:value=>{failFlush=value;}};
}
function expected(width,height,boxes) {
  const words=new Uint32Array(Math.ceil(width/256)*height);
  for(const [x,y,w,h] of boxes)if(w>0&&h>0)for(let row=Math.max(0,Math.floor(y));row<Math.min(height,Math.ceil(y+h));row++)
    for(let col=Math.max(0,Math.floor(x));col<Math.min(width,Math.ceil(x+w));col++)words[row*Math.ceil(width/256)+(col>>8)]|=1<<((col>>3)&31);
  return [...words];
}
test('主屏精确分配dirty bits、离屏不分配；每入口bits紧接rows',()=>{
  for(const method of ['fillRect','fillRects','fillRectLayers','fillRunLayers','fillRunLayersRestored']) {
    const {screen,Canvas,draws,bitsOf}=setup();assert.equal(bitsOf(screen).length,10);
    const input=new Int32Array([0,0,16,1,7]);
    const invoke=c=>method==='fillRect'?c.fillRect(0,0,16,1,7):method==='fillRects'?c.fillRects(input):c[method](input,{},new Float64Array(9));
    invoke(screen);assert.equal(draws.at(-1).bits,bitsOf(screen));assert.equal(draws.at(-1).rows,screen._changedRows);
    assert.deepEqual([...bitsOf(screen)],expected(480,5,[[0,0,16,1]]));
    screen.flush(true);invoke(screen);assert.ok(bitsOf(screen).every(v=>v===0),'同色native bbox不可再次扩bits');
    const other=new Canvas(480,5);invoke(other);assert.equal(draws.at(-1).bits,undefined);assert.equal(bitsOf(other),undefined);
  }
});
test('随机矩形与所有8px/256px边界逐像素参考相符，高padding位保持零',()=>{
  let seed=0x23d81983;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(const width of [1,7,8,9,31,32,63,64,127,128,255,256,257,479,480,511,512,513,2048]) {
    const {screen,bitsOf}=setup(width,9),bits=bitsOf(screen);
    for(let round=0;round<200;round++) {
      bits.fill(0);const boxes=[];
      for(let i=0;i<5;i++) {
        const box=[(random()%(width+20))-10+.25,(random()%17)-4+.25,random()%(width+4),random()%12];
        boxes.push(box);screen._markDirty(...box);
      }
      assert.deepEqual([...bits],expected(width,9,boxes),`width${width} round${round}`);
    }
    bits.fill(0);screen._markDirty(0,0,width,9,false);assert.ok(bits.every(v=>v===0));
    screen.clear(0);assert.deepEqual([...bits],expected(width,9,[[0,0,width,9]]));
  }
});
test('JS单点和图片写入保守bits，图片getter重入合并，文字异常全屏标记',()=>{
  const {screen,Canvas,bitsOf,setDrawFailure}=setup(513,5),bits=bitsOf(screen);
  screen.setPixel(255,1,9);screen.setPixel(256,1,7);screen.setPixel(512,4,3);
  assert.deepEqual([...bits],expected(513,5,[[255,1,2,1],[512,4,1,1]]));
  screen.flush(true);const input=new Canvas(3,1);input.clear(7);
  input._alpha={get 0(){screen.fillRect(300,3,16,1,7);return 255;}};
  screen.drawImage(input,255,1);
  assert.deepEqual([...bits],expected(513,5,[[255,1,3,1],[300,3,16,1]]));
  screen.flush(true);setDrawFailure(true);assert.throws(()=>screen.drawText('x',0,0),/text failed/);
  assert.deepEqual([...bits],expected(513,5,[[0,0,513,5]]));
});
test('native部分异常全屏标记；flush失败保留，成功第8参数传bits并清除',()=>{
  const {screen,bitsOf,flushes,setDrawFailure,setFlushFailure}=setup(257,3),bits=bitsOf(screen);
  setDrawFailure(true);assert.throws(()=>screen.fillRect(0,0,16,1,7),/draw failed/);
  const saved=[...bits],rows=[...screen._changedRows],dirty={...screen._dirty};assert.deepEqual(saved,expected(257,3,[[0,0,257,3]]));
  setDrawFailure(false);setFlushFailure(true);assert.throws(()=>screen.flush(true),/flush failed/);
  assert.deepEqual([...bits],saved);assert.deepEqual([...screen._changedRows],rows);assert.deepEqual(screen._dirty,dirty);
  assert.equal(flushes.at(-1).args[7],bits);assert.deepEqual(flushes.at(-1).bits,saved);
  setFlushFailure(false);screen.flush(true);assert.ok(bits.every(v=>v===0));assert.ok(screen._changedRows.every(v=>v===0));assert.equal(screen._dirty,null);
  screen.flush(true);assert.equal(flushes.at(-1).args.length,6);assert.equal(flushes.at(-1).args[5],true);
});
test('手动flush全扫描；正常读取_pixels不改变自动帧bits路径',()=>{
  const {screen,bitsOf,flushes}=setup();screen.setPixel(0,0,7);
  const pixels=screen._pixels;assert.equal(pixels[0],7);screen.flush(true);
  assert.equal(flushes.at(-1).args.length,8);assert.equal(flushes.at(-1).args[7],bitsOf(screen));
  pixels[400]=8;screen.flush();assert.equal(flushes.at(-1).args.length,1);assert.ok(bitsOf(screen).every(v=>v===0));
});
test('dispose同时释放bits；使用原_pixels存储保留native12语义',()=>{
  const {screen,bitsOf}=setup();const bits=bitsOf(screen);
  assert.ok(Object.hasOwn(screen,'_pixels'));assert.ok(screen._pixels instanceof Uint32Array);
  screen.setPixel(256,1,7);assert.deepEqual([...bits],expected(480,5,[[256,1,1,1]]));
  screen.dispose();assert.equal(bitsOf(screen),undefined);assert.throws(()=>screen.setPixel(0,0,7),/disposed/);
});
