// 加载最终图片覆盖入口后验证：不能只测被覆盖的基础Canvas方法。
let actualBlits=0;
const originalBlit=native.blitCanvas;
native.blitCanvas=function(...args){actualBlits++;return originalBlit(...args);};
for(let n=0;n<350;n++) {
 const src=new Canvas(19,17),a=new Canvas(23,21),b=new Canvas(23,21);
 for(let i=0;i<src._pixels.length;i++)src._pixels[i]=(i*7919+n*31+1)&0xffffff;
 a.clear(123);b.clear(123);
 const x=n%31-12,y=n%27-10,opts={sx:n%25-4,sy:n%23-3,sw:n%24,sh:n%22};
 a.drawImage(src,x,y,opts);
 // 全不透明mask强制原16.16循环作像素oracle，不引入第二套裁剪公式。
 src._alpha=new Uint8Array(3*17);src._alpha.fill(255);
 b.drawImage(src,x,y,opts);
 equal([...a._pixels],[...b._pixels],'final image wrapper equivalence '+n);
}
check(actualBlits>50,'final image override must reach native blit');
{
 const a=new Canvas(2,1),b=new Canvas(2,1);a._pixels.set([123,456]);let reads=0;
 b.drawImage(a,0,0,new Proxy({}, {get(target,key){if(key==='colorKey'){reads++;return 123;}}}));
 equal([...b._pixels],[0,456],'final Proxy colorKey semantics');equal(reads,1,'final key getter count');
 const c=new Canvas(2,1);c.drawImage(a,0,0,{colorKey:null});equal([...c._pixels],[123,456],'null key opaque');
 const d=new Canvas(2,1);const buf=a._pixels.buffer;
 throws(()=>d.drawImage(a,0,0,{get sw(){detach(buf);return 2;}}),TypeError,'final options detach buffer');
}
native.blitCanvas=originalBlit;

// 批量内容块与独立逐像素参照对比，覆盖重叠块、空块和上下视口裁剪。
for(let pass=0;pass<320;pass++) {
  const width=37,height=29,src=new Canvas(31,23),actual=new Canvas(width,height);
  const expected=new Uint32Array(width*height);expected.fill(0x314159);actual.clear(0x314159);
  actual._dirty=null;actual._changedRows=new Uint16Array(height*2);
  actual._dirtyBlocks=new Uint32Array(height);
  for(let i=0;i<src._pixels.length;i++)src._pixels[i]=(i*7399+pass)&0xffffff;
  const x=(pass%21)-10,y=(pass%25)-12,top=pass%8,bottom=height-(pass%5);
  const values=[];
  for(let n=0;n<pass%13;n++)values.push((random()%39)-4,(random()%29)-3,random()%14,random()%12);
  const regions=new Int32Array(values);
  for(let n=0;n<values.length;n+=4) {
    const [rx,ry,rw,rh]=values.slice(n,n+4);
    for(let sy=Math.max(0,ry);sy<Math.min(src.height,ry+rh);sy++)
      for(let sx=Math.max(0,rx);sx<Math.min(src.width,rx+rw);sx++) {
        const dx=x+sx,dy=y+sy;
        if(dx>=0&&dx<width&&dy>=top&&dy<bottom)expected[dy*width+dx]=src._pixels[sy*src.width+sx];
      }
  }
  actual._drawImageRegions(src,x,y,regions,top,bottom);
  equal([...actual._pixels],[...expected],'batch blit pixels '+pass);
  for(let i=0;i<expected.length;i++)if(expected[i]!==0x314159) {
    const xx=i%width,yy=Math.floor(i/width);
    check(actual._changedRows[yy*2]&&actual._changedRows[yy*2]<=xx+1&&actual._changedRows[yy*2+1]>xx,'batch rows');
    check(actual._dirtyBlocks[yy]&(1<<(xx>>3)),'batch blocks');
  }
}
{
  const src=new Canvas(8,8),dst=new Canvas(8,8);
  src.clear(0xabcdef);
  const args=[dst._pixels,8,8,src._pixels,8,8,0,0,0,0,8,8,undefined,undefined];
  for(const invalid of [[],new Uint16Array(4),new Int32Array(3),new Int32Array(257*4),
    new Int32Array([0,0,8,8,0,0,-1,1]),new Int32Array([2147483647,0,1,1])]) {
    let failed=false;try{native.blitCanvas(...args,invalid,0,8)}catch{failed=true}
    check(failed,'invalid batch rejected');check(dst._pixels.every(v=>v===0),'batch validates before painting');
  }
  throws(()=>native.blitCanvas(...args,new Int32Array(dst._pixels.buffer),0,8),RangeError,'batch owner alias');
  const rects=new Int32Array([0,0,8,8]);
  throws(()=>native.blitCanvas(...args,rects,0,{valueOf(){detach(rects.buffer);return 8}}),TypeError,'viewport getter detach');
  throws(()=>native.blitCanvas(...args,new Int32Array([0,0,8,8])),TypeError,'batch needs viewport');
}

// 合成器直接比较最终值：新旧区域交叠时不能产生擦除后重画的假脏。
for (let pass=0;pass<160;pass++) {
  const w=pass%3===0?513:37,h=31,bg=0x172839;
  const dst=new Canvas(w,h),sources=[new Canvas(w,12),new Canvas(w,9)];
  const geometry=new Int32Array([-3+pass%5,12,15+pass%4,9]);
  for(let n=0;n<sources.length;n++)for(let i=0;i<sources[n]._pixels.length;i++)
    sources[n]._pixels[i]=(i*7717+n*123)&0xffffff;
  dst.clear(bg);dst._changedRows=new Uint16Array(h*2);
  const stride=Math.ceil(w/256);dst._dirtyBlocks=new Uint32Array(stride*h);
  const values=[];for(let i=0;i<pass%17;i++)values.push((random()%(w+12))-6,(random()%40)-5,random()%60,random()%17);
  const regions=new Int32Array(values),top=pass%7,bottom=25+pass%6;
  const expected=new Uint32Array(dst._pixels);
  for(let y=top;y<bottom;y++)for(let x=0;x<w;x++) {
    let selected=false;
    for(let n=0;n<values.length;n+=4)if(values[n+2]>0&&Math.min(w,values[n]+values[n+2])>Math.max(0,values[n])&&y>=values[n+1]&&y<values[n+1]+values[n+3]&&
      x>=Math.floor(Math.max(0,values[n])/8)*8&&x<Math.ceil(Math.min(w,values[n]+values[n+2])/8)*8)selected=true;
    if(!selected)continue;
    let color=bg;
    for(let n=0;n<sources.length;n++)if(y>=geometry[n*2]&&y<geometry[n*2]+geometry[n*2+1])
      color=sources[n]._pixels[(y-geometry[n*2])*w+x];
    expected[y*w+x]=color;
  }
  dst._composeRows(sources,geometry,regions,top,bottom,bg);
  const mismatch=dst._pixels.findIndex((v,i)=>v!==expected[i]);
  check(mismatch<0,'compose pixels '+pass+' index '+mismatch+' rects '+JSON.stringify(values)+' actual '+dst._pixels[mismatch]+' expected '+expected[mismatch]);
  for(let i=0;i<expected.length;i++)if(expected[i]!==bg) {
    const x=i%w,y=Math.floor(i/w);
    check(dst._changedRows[y*2]>0&&dst._changedRows[y*2]<=x+1&&dst._changedRows[y*2+1]>x,'compose row tracked');
    check(dst._dirtyBlocks[y*stride+(x>>8)]&(1<<((x>>3)%32)),'compose block tracked');
  }
  dst._changedRows.fill(0);dst._dirtyBlocks.fill(0);
  dst._composeRows(sources,geometry,regions,top,bottom,bg);
  check(dst._changedRows.every(v=>v===0)&&dst._dirtyBlocks.every(v=>v===0),'identical final pixels produce no dirty blocks');
}
{
  const dst=new Canvas(8,8),src=new Canvas(8,4),rects=new Int32Array([0,0,8,8]);
  src.clear(0x123456);
  const call=(sources,g= new Int32Array([0,4]),r=rects)=>native.composeRows(dst._pixels,8,8,sources,g,r,0,8,0);
  for(const g of [new Int32Array([0,-1]),new Int32Array([0,4,1,4]),new Int32Array(0)]) {
    throws(()=>call([src._pixels],g),RangeError,'invalid composed row geometry');
    check(dst._pixels.every(v=>v===0),'validate composition before writing');
  }
  throws(()=>call([src._pixels,src._pixels],new Int32Array([0,4,1,4])),RangeError,'overlapping composed rows');
  throws(()=>call([dst._pixels],new Int32Array([0,8])),RangeError,'source cannot share output');
  const second=new Canvas(8,4),buffer=src._pixels.buffer;
  const malicious={length:2,0:src._pixels,get 1(){detach(buffer);return second._pixels}};
  throws(()=>call(malicious,new Int32Array([0,4,4,4])),TypeError,'later source getter detaches earlier source safely');
}
{
  const dst=new Canvas(64,64),src=new Canvas(64,64);src.clear(7);
  dst._changedRows=new Uint16Array(128);dst._dirtyBlocks=new Uint32Array(64);
  const geometry=new Int32Array([0,64]),regions=new Int32Array([0,0,64,64]);
  armInterrupt(2);
  throws(()=>dst._composeRows([src],geometry,regions,0,64,0),InternalError,'composition is interruptible');
  armInterrupt(0);
  for(let y=0;y<64;y++) {
    check(dst._changedRows[y*2]===1&&dst._changedRows[y*2+1]===64,'cancelled composition invalidates rows');
    check(dst._dirtyBlocks[y]===255,'cancelled composition invalidates blocks');
  }
  /* clear() 现在走可中断的原生快路径，先关闭上一断言留下的中断预算。 */
  armInterrupt(-1);
  dst.clear(0);
  throws(()=>dst._composeRows([src],geometry,new Int32Array([0,0,64,64,0,0,-1,2]),0,64,0),RangeError,'all composition rectangles prevalidated');
  check(dst._pixels.every(v=>v===0),'late invalid region leaves pixels untouched');
}
