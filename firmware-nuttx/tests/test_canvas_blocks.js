// 真实QuickJS入口验证：dirtybits记录实际写入并跨调用累积，不能仅用最终像素差替代。
(() => {
  const assert=(v,m)=>{if(!v)throw Error(m);};
  const equal=(a,b,m)=>assert(JSON.stringify(a)===JSON.stringify(b),m);
  const throws=(f,m)=>{let failed=false;try{f();}catch{failed=true;}assert(failed,m);};
  let state=0x320e59b7,checks=0;
  const random=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
  const mask=w=>Math.ceil(w/8)%32?((2**(Math.ceil(w/8)%32))-1)>>>0:0xffffffff;
  function validate(bits,w,h,before,after,old) {
    const words=Math.ceil(w/256);
    for(let i=0;i<bits.length;i++)assert(((bits[i]&old[i])>>>0)===old[i],'old bits preserved '+i);
    for(let y=0;y<h;y++) {
      assert(((bits[y*words+words-1]&~mask(w))>>>0)===0,'invalid high bits '+w+','+y);
      for(let x=0;x<w;x++)if(before[y*w+x]!==after[y*w+x])
        assert(bits[y*words+(x>>>8)]&(1<<((x>>>3)&31)),'changed pixel omitted '+w+':'+x+','+y);
    }
    checks++;
  }
  for(const W of [1,7,8,9,31,255,256,257,480,2048]) {
    const H=13,words=Math.ceil(W/256),pixels=new Uint32Array(W*H),reference=new Uint32Array(W*H);
    const owner=new Uint32Array(words*H+4),bits=owner.subarray(2,-2),rows=new Uint16Array(H*2);
    owner[0]=0x12345678;owner[1]=0x9abcdef0;owner[owner.length-2]=0x87654321;owner[owner.length-1]=0xfedcba98;
    for(let frame=0;frame<160;frame++) {
      if(frame%2===0){bits.fill(0);rows.fill(0);}
      const before=new Uint32Array(pixels),old=new Uint32Array(bits),mode=frame%4,track=frame%3?rows:undefined;
      let a,b;
      if(mode===0) {
        const r=new Int32Array(9*5);
        for(let i=0;i<r.length;i+=5)r.set([(random()%(W+10))-5,(random()%23)-5,random()%(W+5),random()%9,random()&0xffffff],i);
        a=native.fillRects(pixels,W,H,r,r.length/5,track,bits);
        b=native.fillRects(reference,W,H,r,r.length/5);
      } else {
        const o={step:1+frame%4,scale:[.5,1,15/14,1.5,2.25][frame%5],padding:frame%5===0?.5:1,
          clipTop:frame%9===0?2.5:0,clipBottom:frame%11===0?10.5:H,margin:frame%3===0?.5:undefined,
          color:frame%5===0?0xff00ff:0xffffff,layers:new Int32Array([-3,-2,0xaa2233,3,1,0x2233aa])};
        let r;
        if(mode===1)r=new Int32Array([-2,1,6,3,random()%21+1,1,2,9,2,random()%21+1]);
        else {const values=[];for(let y=-1;y<9;y++)values.push((random()%9)-3,y,random()%11+1);r=new Int32Array(values);}
        if(mode===1){a=native.fillRectLayers(pixels,W,H,r,o,track,bits);b=native.fillRectLayers(reference,W,H,r,o);}
        else if(mode===2){a=native.fillRunLayers(pixels,W,H,r,o,track,bits);b=native.fillRunLayers(reference,W,H,r,o);}
        else {
          const restore=new Float64Array([-1.5,2.25,W-.5,H-.25,0x102030,3.5,H-.5,0x304050,frame%3?1:0]);
          a=native.fillRunLayersRestored(pixels,W,H,r,o,restore,track,bits);
          b=native.fillRunLayersRestored(reference,W,H,r,o,restore);
        }
      }
      equal(a,b,'return geometry '+W+','+frame);equal([...pixels],[...reference],'pixel geometry '+W+','+frame);
      validate(bits,W,H,before,pixels,old);
      equal([owner[0],owner[1],owner[owner.length-2],owner[owner.length-1]],
        [0x12345678,0x9abcdef0,0x87654321,0xfedcba98],'tracker offset sentinels');
    }
  }
  // 非对齐8像素组横跨bit31/下一word；相同组无真实写入，末端像素也要标记。
  {
    const p=new Uint32Array(520),bits=new Uint32Array(3),r=new Int32Array([255,0,8,1,7]);
    native.fillRects(p,520,1,r,1,undefined,bits);equal([...bits],[0x80000000,1,0],'unaligned cross word');
    bits.fill(0);native.fillRects(p,520,1,r,1,undefined,bits);equal([...bits],[0,0,0],'unchanged groups');
    native.fillRects(p,520,1,new Int32Array([519,0,1,1,7]),1,undefined,bits);equal([...bits],[0,0,1],'last tail');
    bits.fill(0);native.fillRects(p,520,1,new Int32Array([8,0,8,1,11,8,0,8,1,0]),2,undefined,bits);
    equal([...bits],[2,0,0],'write then restore must retain bit');assert(p.slice(8,16).every(v=>v===0),'final diff intentionally empty');
    bits.fill(0);p.fill(3);p[255]=4;
    native.fillRects(p,520,1,new Int32Array([255,0,8,1,3]),1,undefined,bits);
    equal([...bits],[0x80000000,1,0],'mark actual whole group, not just changed pixels');
  }
  function call(method,pixels,bits,geometry,options={},restore=new Float64Array([0,0,8,8,1,0,8,2,1]),rows) {
    if(method==='fillRects')return native[method](pixels,8,8,geometry,geometry.length/5,rows,bits);
    if(method==='fillRunLayersRestored')return native[method](pixels,8,8,geometry,options,restore,rows,bits);
    return native[method](pixels,8,8,geometry,options,rows,bits);
  }
  for(const method of ['fillRects','fillRectLayers','fillRunLayers','fillRunLayersRestored']) {
    const isRun=method.includes('Run'),geometry=new Int32Array(isRun?[1,1,2]:[1,1,2,2,3]);
    for(const invalid of [null,new Int32Array(8),new Uint16Array(16),new Uint32Array(7),new Uint32Array(9)]) {
      const p=new Uint32Array(64);throws(()=>call(method,p,invalid,geometry),'blocks type/length '+method);
      assert(p.every(v=>v===0),'invalid blocks no drawing');
    }
    for(const victim of ['pixels','geometry','layers','restore','rows']) {
      if(method==='fillRects'&&(victim==='layers'||victim==='restore'))continue;
      if(method!=='fillRunLayersRestored'&&victim==='restore')continue;
      const buffer=new ArrayBuffer(512),pixels=victim==='pixels'?new Uint32Array(buffer,0,64):new Uint32Array(64);
      const g=victim==='geometry'?new Int32Array(buffer,0,geometry.length):new Int32Array(geometry);g.set(geometry);
      const layers=victim==='layers'?new Int32Array(buffer,0,3):new Int32Array([1,1,7]);layers.set([1,1,7]);
      const restore=victim==='restore'?new Float64Array(buffer,0,9):new Float64Array(9);restore.set([0,0,8,8,1,0,8,2,1]);
      const rows=victim==='rows'?new Uint16Array(buffer,0,16):new Uint16Array(16);
      // 分离区间但共享ArrayBuffer也必须拒绝，避免异常失效篡改输入。
      const bits=new Uint32Array(buffer,400,8),before=[...pixels];
      throws(()=>call(method,pixels,bits,g,{layers},restore,rows),'same owner '+method+' '+victim);
      equal([...pixels],before,'alias no drawing');assert(bits.every(v=>v===0),'rejected bits untouched');
    }
    for(const when of ['already','getter']) {
      const bits=new Uint32Array(8),p=new Uint32Array(64);
      if(when==='already')detach(bits.buffer);
      if(method==='fillRects')throws(()=>native.fillRects(p,{valueOf(){if(when==='getter')detach(bits.buffer);return 8;}},8,geometry,1,undefined,bits),'rect blocks detached');
      else throws(()=>call(method,p,bits,geometry,{get scale(){if(when==='getter')detach(bits.buffer);return 1;}}),'layer blocks detached');
      assert(p.every(v=>v===0),'detach no writes');
    }
  }
  // 中断发生在校验之后，所有有效位置1，末字高位清0；首轮和部分写入两个时点均覆盖。
  for(const W of [1,255,256,257,480,2048])for(const method of ['fillRects','fillRectLayers','fillRunLayers','fillRunLayersRestored']) {
    const H=64,words=Math.ceil(W/256),p=new Uint32Array(W*H),bits=new Uint32Array(words*H),t=new Uint16Array(H*2);
    armInterrupt(0);
    throws(()=>method==='fillRects'?native.fillRects(p,W,H,new Int32Array([0,0,W,H,7]),1,t,bits):
      method==='fillRunLayersRestored'?native[method](p,W,H,new Int32Array([0,0,1]),{step:H,padding:0,color:7},new Float64Array([0,0,W,H,7,0,0,0,0]),t,bits):
      native[method](p,W,H,new Int32Array(method.includes('Run')?[0,0,1]:[0,0,W,H,7]),method.includes('Run')?{step:H,padding:0,color:7}:{},t,bits),'initial interrupt '+W+','+method);
    armInterrupt(-1);
    for(let y=0;y<H;y++)for(let w=0;w<words;w++)assert(bits[y*words+w]===(w===words-1?mask(W):0xffffffff),'interrupt full bits '+W+','+method);
  }
  for(const method of ['fillRects','fillRectLayers','fillRunLayers','fillRunLayersRestored']) {
    const W=129,H=64,p=new Uint32Array(W*H),bits=new Uint32Array(H);
    armInterrupt(method==='fillRunLayers'?2:1);
    throws(()=>method==='fillRects'?native.fillRects(p,W,H,new Int32Array([0,0,W,H,7]),1,undefined,bits):
      method==='fillRunLayersRestored'?native[method](p,W,H,new Int32Array(),{},new Float64Array([0,0,W,H,7,0,0,0,0]),undefined,bits):
      native[method](p,W,H,new Int32Array(method.includes('Run')?[0,0,3]:[0,0,W,H,7]),method.includes('Run')?{step:H,padding:0,color:7}:{},undefined,bits),'partial interrupt '+method);
    armInterrupt(-1);assert(p.some(v=>v===7),'interrupt wrote prefix '+method);
    assert(bits.every(v=>v===mask(W)),'partial interrupt invalidates full bits '+method);
  }
  globalThis.dirtyBlockChecks=checks;
})();
