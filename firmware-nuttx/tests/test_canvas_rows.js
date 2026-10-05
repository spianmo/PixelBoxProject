// 追踪器只缩小转换范围；矩形返回值/像素仍与关闭追踪器完全一致。
(() => {
  const assert = (v, message) => { if (!v) throw Error(message); };
  const equal = (a,b,message) => assert(JSON.stringify(a)===JSON.stringify(b),message);
  const throws = (f,message) => { let failed=false;try{f();}catch{failed=true;}assert(failed,message); };
  let state=0x4591bf79,checks=0;
  const random=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
  function validate(rows,w,h,before,after) {
    for(let y=0;y<h;y++) {
      const l=rows[y*2],r=rows[y*2+1];
      assert(l===0?r===0:l>=1&&l<=r&&r<=w,'canonical row '+y+' '+l+','+r);
      for(let x=0;x<w;x++)if(before[y*w+x]!==after[y*w+x])
        assert(l&&x>=l-1&&x<r,'changed pixel omitted '+x+','+y);
    }
    checks++;
  }
  const W=37,H=41,pixels=new Uint32Array(W*H),reference=new Uint32Array(W*H);
  const owner=new Uint16Array(H*2+4);owner[0]=0xabcd;owner[1]=0xef01;owner[owner.length-2]=0x2345;owner[owner.length-1]=0x6789;
  const rows=owner.subarray(2,-2);
  for(let frame=0;frame<1200;frame++) {
    if(frame%7===0)rows.fill(0);
    const before=new Uint32Array(pixels),mode=frame%4;
    let a,b;
    if(mode===0) {
      const r=new Int32Array(9*5);
      for(let i=0;i<r.length;i+=5)r.set([(random()%55)-9,(random()%55)-8,random()%22,random()%15,random()&0xffffff],i);
      a=native.fillRects(pixels,W,H,r,r.length/5,rows);
      b=native.fillRects(reference,W,H,r,r.length/5);
    } else {
      const options={step:1+frame%4,scale:[.5,1,15/14,1.5,2.25][frame%5],padding:frame%5===0?.5:1,
        clipTop:frame%9===0?5.5:0,clipBottom:frame%11===0?30.5:H,margin:frame%3===0?.5:undefined,
        color:frame%5===0?0xff00ff:0xffffff,layers:new Int32Array([-3,-2,0xaa2233,3,1,0x2233aa])};
      let r;
      if(mode===1)r=new Int32Array([-2,1,6,3,random()%21+1,1,2,9,2,random()%21+1]);
      else {const values=[];for(let y=-1;y<9;y++)values.push((random()%9)-3,y,random()%11+1);r=new Int32Array(values);}
      if(mode===1) {
        a=native.fillRectLayers(pixels,W,H,r,options,rows);
        b=native.fillRectLayers(reference,W,H,r,options);
      } else if(mode===2) {
        a=native.fillRunLayers(pixels,W,H,r,options,rows);
        b=native.fillRunLayers(reference,W,H,r,options);
      } else {
        const restore=new Float64Array([-1.5,2.25,35.5,37.75,0x102030,3.5,38.5,0x304050,frame%3?1:0]);
        a=native.fillRunLayersRestored(pixels,W,H,r,options,restore,rows);
        b=native.fillRunLayersRestored(reference,W,H,r,options,restore);
      }
    }
    equal(a,b,'return geometry '+frame);equal([...pixels],[...reference],'pixel geometry '+frame);
    validate(rows,W,H,before,pixels);
    equal([owner[0],owner[1],owner[owner.length-2],owner[owner.length-1]],[0xabcd,0xef01,0x2345,0x6789],'tracker sentinels');
  }
  // 8像素组变更保守标整组，尾部逐像素；相同绘制不产生新标记。
  const p=new Uint32Array(24*3),t=new Uint16Array(6);
  native.fillRects(p,24,3,new Int32Array([2,1,17,1,0xffffff]),1,t);
  equal([...t],[0,0,3,19,0,0],'group and tail');
  t.fill(0);native.fillRects(p,24,3,new Int32Array([2,1,17,1,0xffffff]),1,t);
  equal([...t],[0,0,0,0,0,0],'unchanged span');
  p[1*24+10]=0;native.fillRects(p,24,3,new Int32Array([2,1,17,1,0xffffff]),1,t);
  equal([...t],[0,0,11,18,0,0],'only second8 group');
  native.fillRects(p,24,3,new Int32Array([0,1,1,1,1]),1,t);
  equal([...t],[0,0,1,18,0,0],'merge prior dirty');
  // 同一次调用先写后还原，最终diff为空仍须留tracker。
  t.fill(0);native.fillRects(p,24,3,new Int32Array([4,2,1,1,7,4,2,1,1,0]),2,t);
  equal([...t],[0,0,0,0,5,5],'write then restore retained');

  function call(method,pixels,rows,geometry,options={},restore=new Float64Array([0,0,8,8,1,0,8,2,1])) {
    if(method==='fillRects')return native[method](pixels,8,8,geometry,geometry.length/5,rows);
    if(method==='fillRunLayersRestored')return native[method](pixels,8,8,geometry,options,restore,rows);
    return native[method](pixels,8,8,geometry,options,rows);
  }
  for(const method of ['fillRects','fillRectLayers','fillRunLayers','fillRunLayersRestored']) {
    const isRun=method.includes('Run'),geometry=new Int32Array(isRun?[1,1,2]:[1,1,2,2,3]);
    for(const invalid of [null,new Int32Array(16),new Uint16Array(15),new Uint16Array(17)])
      throws(()=>call(method,new Uint32Array(64),invalid,geometry),'tracker type/length '+method);
    for(const victim of ['pixels','geometry','layers','restore']) {
      const buffer=new ArrayBuffer(512),pixels=victim==='pixels'?new Uint32Array(buffer,0,64):new Uint32Array(64);
      const g=victim==='geometry'?new Int32Array(buffer,0,geometry.length):new Int32Array(geometry);g.set(geometry);
      const layers=victim==='layers'?new Int32Array(buffer,0,3):new Int32Array([1,1,7]);layers.set([1,1,7]);
      const restore=victim==='restore'?new Float64Array(buffer,0,9):new Float64Array(9);restore.set([0,0,8,8,1,0,8,2,1]);
      // 与输入不重叠但共享owner也拒绝。unused字段不传入的接口不构成alias。
      if(method==='fillRects'&&(victim==='layers'||victim==='restore'))continue;
      if(method!=='fillRunLayersRestored'&&victim==='restore')continue;
      const tracked=new Uint16Array(buffer,400,16);tracked.fill(0);
      const before=[...pixels];throws(()=>call(method,pixels,tracked,g,{layers},restore),'same owner '+method+' '+victim);
      equal([...pixels],before,'alias no drawing');equal([...tracked],new Array(16).fill(0),'alias tracker untouched');
    }
    const tracked=new Uint16Array(16),pixels=new Uint32Array(64);
    if(method==='fillRects') {
      throws(()=>native.fillRects(pixels,{valueOf(){detach(tracked.buffer);return 8;}},8,geometry,1,tracked),'rect tracker detached');
    } else {
      throws(()=>call(method,pixels,tracked,geometry,{get scale(){detach(tracked.buffer);return 1;}}),'layer tracker detached');
    }
    assert(pixels.every(v=>v===0),'detach no pixel writes');
  }
  // 中断后的全表失效与保持像素前缀，且所有入口都覆盖。
  for(const method of ['fillRects','fillRectLayers','fillRunLayers','fillRunLayersRestored']) {
    const p=new Uint32Array(129*64),t=new Uint16Array(64*2),isRun=method.includes('Run');
    armInterrupt(method==='fillRunLayers'?2:1);
    throws(()=>method==='fillRects'?native.fillRects(p,129,64,new Int32Array([0,0,129,64,7]),1,t):
      method==='fillRunLayersRestored'?native[method](p,129,64,new Int32Array(),{},new Float64Array([0,0,129,64,7,0,0,0,0]),t):
      native[method](p,129,64,new Int32Array(isRun?[0,0,3]:[0,0,129,64,7]),isRun?{step:64,padding:0,color:7}:{},t),'interrupt '+method);
    armInterrupt(-1);assert(p.some(v=>v===7),'interrupt wrote prefix '+method);
    for(let y=0;y<64;y++)assert(t[y*2]===1&&t[y*2+1]===129,'interrupt invalidates '+method);
  }
  globalThis.rowTrackerChecks=checks;
})();
