// 原生返回记录必须与对象字面量一致，不能触发 Object.prototype 上的 setter。
for (const key of ['left','top','right','bottom','dx','dy','pixels','bounds','dirty','x','y','width','height']) {
  const previous=Object.getOwnPropertyDescriptor(Object.prototype,key);
  let calls=0,result,rectangleDirty;
  Object.defineProperty(Object.prototype,key,{configurable:true,set(){calls++;throw new Error('inherited setter '+key);}});
  try {
    result=native.fillRunLayers(new Uint32Array(16),4,4,new Int32Array([0,0,1]),{});
    rectangleDirty=native.fillRectLayers(new Uint32Array(16),4,4,new Int32Array([0,0,1,1,7]),{});
  } finally {
    if(previous)Object.defineProperty(Object.prototype,key,previous);else delete Object.prototype[key];
  }
  check(calls===0,'native records bypass inherited setter '+key);
  for(const field of ['left','top','right','bottom','dx','dy','pixels'])
    check(Object.hasOwn(result.bounds,field),'native owns bounds field '+field);
  for(const record of [result.dirty,rectangleDirty])for(const field of ['x','y','width','height'])
    check(Object.hasOwn(record,field),'native owns dirty field '+field);
  check(Object.hasOwn(result,'bounds')&&Object.hasOwn(result,'dirty'),'native owns result fields');
}

// 参照原逐矩形算法，不调用新增接口；逐像素比较取整、遮挡、裁剪与绘制顺序。
function layerPhysical(canvas,scale,x,y,w,h,color) {
  const left=Math.round(x*scale),top=Math.round(y*scale);
  referenceFill(canvas,left,top,Math.round((x+w)*scale)-left,Math.round((y+h)*scale)-top,color);
}
function referenceRectLayers(canvas,rects,o={}) {
  const count=o.count??rects.length/5,step=o.step??1,scale=o.scale??1,x=o.x??0,y=o.y??0;
  const layers=o.layers??new Int32Array();
  for(let l=0;l<layers.length;l+=3)for(let i=0;i<count*5;i+=5) {
    if(rects[i+2]>0&&rects[i+3]>0)
      layerPhysical(canvas,scale,x+rects[i]*step+layers[l],y+rects[i+1]*step+layers[l+1],
        rects[i+2]*step,rects[i+3]*step,layers[l+2]);
  }
  for(let i=0;i<count*5;i+=5)if(rects[i+2]>0&&rects[i+3]>0)
    layerPhysical(canvas,scale,x+rects[i]*step,y+rects[i+1]*step,rects[i+2]*step,rects[i+3]*step,rects[i+4]);
}
function referenceRunLayers(canvas,input,o={}) {
  const count=o.count??input.length/3,step=o.step??1,scale=o.scale??1,padding=o.padding??1;
  const layers=o.layers??new Int32Array(),width=canvas.width/scale;
  const clipTop=o.clipTop??0,clipBottom=o.clipBottom??canvas.height/scale;
  const result={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity,dx:0,dy:0,pixels:0};
  if(!count)return result;
  let edge=0,left=o.left??Infinity,right=o.right??-Infinity,top=Infinity,bottom=-Infinity;
  const xs=[],ys=[],ws=[];
  for(let l=0;l<layers.length;l+=3)edge=Math.max(edge,Math.abs(layers[l]),Math.abs(layers[l+1]));
  for(let i=0;i<count*3;i+=3) {
    const x=input[i]*step,y=input[i+1]*step,w=input[i+2]*step;
    left=Math.min(left,x-edge);right=Math.max(right,x+w+edge+1);
    top=Math.min(top,y-edge);bottom=Math.max(bottom,y+step+edge+1);
    result.pixels+=input[i+2];
    const last=xs.length-1;
    if(last>=0&&y===ys[last]&&x-xs[last]-ws[last]<=step)ws[last]=x+w-xs[last];
    else {xs.push(x);ys.push(y);ws.push(w);}
  }
  if(o.margin!==undefined) {
    result.dx=left<o.margin?o.margin-left:right>width-o.margin?width-o.margin-right:0;
    result.dy=top<clipTop?clipTop-top:bottom>clipBottom?clipBottom-bottom:0;
  }
  const paint=(x,y,w,h,color)=>{
    x+=result.dx;y+=result.dy;
    if(x<0){w+=x;x=0;}if(y<clipTop){h-=clipTop-y;y=clipTop;}
    if(x+w>width)w=width-x;if(y+h>clipBottom)h=clipBottom-y;
    if(w<=0||h<=0)return;
    result.left=Math.min(result.left,x);result.top=Math.min(result.top,y);
    result.right=Math.max(result.right,x+w);result.bottom=Math.max(result.bottom,y+h);
    layerPhysical(canvas,scale,x,y,w,h,color);
  };
  for(let l=0;l<layers.length;l+=3) {
    let row=0;
    for(let i=0;i<xs.length;i++) {
      const x=xs[i]+layers[l],y=ys[i]+layers[l+1],end=x+ws[i]+padding,base=y+step+padding;
      const gridY=Math.floor(y/step)*step;
      while(row<ys.length&&ys[row]<gridY)row++;
      let area=0,lc=0,tc=0,rc=0,bc=0;
      for(let j=row;j<ys.length&&ys[j]===gridY;j++) {
        const left=Math.max(x,xs[j]),top=Math.max(y,ys[j]);
        const right=Math.min(end,xs[j]+ws[j]+padding),bottom=Math.min(base,ys[j]+step+padding);
        if(right<=left||bottom<=top)continue;
        const overlap=(right-left)*(bottom-top);
        if(overlap>area){area=overlap;lc=left;tc=top;rc=right;bc=bottom;}
      }
      if(!area)paint(x,y,end-x,base-y,layers[l+2]);
      else {
        if(tc>y)paint(x,y,end-x,tc-y,layers[l+2]);
        if(bc<base)paint(x,bc,end-x,base-bc,layers[l+2]);
        if(lc>x)paint(x,tc,lc-x,bc-tc,layers[l+2]);
        if(rc<end)paint(rc,tc,end-rc,bc-tc,layers[l+2]);
      }
    }
  }
  for(let i=0;i<xs.length;i++)paint(xs[i],ys[i],ws[i]+padding,step+padding,o.color??0xffffff);
  return result;
}
function compareLayers(kind,geometry,options,w=31,h=23) {
  const actual=new Canvas(w,h),expected=new Canvas(w,h),before=[...geometry];
  const layers=options?.layers,beforeLayers=layers?[...layers]:undefined;
  if(kind==='runs') {
    const result=actual.fillRunLayers(geometry,options),reference=referenceRunLayers(expected,geometry,options);
    for(const key of Object.keys(reference))check(Object.is(result[key],reference[key]),'run result '+key+' '+JSON.stringify(options));
  } else {
    actual.fillRectLayers(geometry,options);referenceRectLayers(expected,geometry,options);
  }
  equal([...actual._pixels],[...expected._pixels],kind+' pixels '+JSON.stringify(options));
  equal(actual._dirty,expected._dirty,kind+' physical dirty');
  equal([...geometry],before,kind+' immutable geometry');
  if(layers)equal([...layers],beforeLayers,kind+' immutable layers');
}
const scales=[1/2048,.25,.5,.75,1,1.0714285714285714,1.5,2,2048];
// 乘法与原点相消后恰为0.5；融合乘加会向左跨一像素。
compareLayers('rects',new Int32Array([232,0,1,1,7]),
  {step:18.033596534625385,x:-4183.2943960330895},32,32);
for(let pass=0;pass<600;pass++) {
  const layers=new Int32Array((pass%5)*3);
  for(let i=0;i<layers.length;i+=3)layers.set([(random()%17)-8,(random()%17)-8,random()],i);
  const records=[],rows=1+random()%7;
  for(let y=-4;y<rows;y++) {
    let x=-8;
    for(let i=0,n=1+random()%4;i<n;i++) {
      const w=1+random()%5;records.push(x,y,w);x+=w+random()%4;
    }
  }
  const input=new Int32Array(records.length+3).subarray(3);input.set(records);
  const o={count:pass%7?input.length/3:0,step:1+pass%5,scale:scales[pass%scales.length],layers,
    padding:pass%3===0?.5:1,color:random()};
  if(pass%2){o.clipTop=-.5+pass%3;o.clipBottom=10.5+pass%7;o.margin=pass%4;}
  if(pass%3){o.left=-5.25;o.right=22.75;}
  compareLayers('runs',input,o);
  const rects=new Int32Array((1+pass%17)*5+5).subarray(5);
  for(let i=0;i<rects.length;i+=5)rects.set([(random()%80)-40,(random()%50)-25,(random()%20)-3,(random()%17)-3,random()],i);
  compareLayers('rects',rects,{count:pass%11?rects.length/5:0,step:[.5,1,2,3][pass%4],scale:o.scale,
    x:(pass%5)*.5-2,y:(pass%7)*.5-3,layers});
}
compareLayers('runs',new Int32Array(),{});
const emptyResult=new Canvas(1,1).fillRunLayers(new Int32Array());
check(emptyResult.left===Infinity&&emptyResult.right===-Infinity,'empty bounds keep infinities');
compareLayers('runs',new Int32Array([-2147483648,0,2147483647,0,0,2147483647]),{step:2048,scale:.75});
for(const edge of [-2147483648,-2147483647,2147483646,2147483647])
  compareLayers('rects',new Int32Array([edge,edge,2147483647,2147483647,-1]),{step:2048,scale:2048,x:.5,y:-.5});

// 连续写入覆盖全部尾段长度及4字节对齐子视图，前后哨兵必须保持不变。
for(let offset=0;offset<18;offset++)for(const length of [...Array(18).keys(),31,32,33]) {
  for(const method of ['fillRects','fillRectLayers','fillRunLayers']) {
    const width=37,height=5,sentinel=0xa1b2c3d4,color=0xffabcdef;
    const owner=new Uint32Array(offset+width*height+19).fill(sentinel);
    const pixels=owner.subarray(offset,offset+width*height),expected=new Canvas(width,height);
    expected._pixels.set(pixels);
    const x=offset-3,y=offset%5-1,rows=method==='fillRunLayers'?1:3;
    referenceFill(expected,x,y,length,rows,color);
    if(method==='fillRects')native.fillRects(pixels,width,height,rect(x,y,length,rows,color),1);
    else if(method==='fillRectLayers')native.fillRectLayers(pixels,width,height,rect(x,y,length,rows,color));
    else native.fillRunLayers(pixels,width,height,
      length?new Int32Array([x,y,length]):new Int32Array(),{padding:0,color});
    equal([...pixels],[...expected._pixels],method+' span pixels '+offset+':'+length);
    check(owner.subarray(0,offset).every(value=>value===sentinel),method+' leading span sentinel');
    check(owner.subarray(offset+width*height).every(value=>value===sentinel),method+' trailing span sentinel');
  }
}
// 超过Int32的坐标仍按2^32回绕；回绕后可见的矩形不能被快路径漏掉。
for(const edge of [-2147483648,-2147483647,2147483646,2147483647])
  for(const step of [1,2])for(const x of [-.5,0,.5,1])
    compareLayers('rects',rect(edge,0,7,2,0xabcdef),{step,x},19,7);

// 逐端点Float认证：整数格全部命中，单轴半像素只回退对应的两个端点。
const fastBefore=native.canvasStats();
compareLayers('rects',rect(0,0,3,3,7),{scale:1},9,9);
const allFast=native.canvasStats();
equal(allFast.fastRects-fastBefore.fastRects,1,'ordinary physical rect uses Float certificate');
equal(allFast.fastEdges-fastBefore.fastEdges,4,'all four physical endpoints certified');
compareLayers('rects',rect(0,1,2,2,7),{scale:.5},9,9);
const partialFast=native.canvasStats();
equal(partialFast.partialRects-allFast.partialRects,1,'half pixels only fall back per endpoint');
equal(partialFast.fastEdges-allFast.fastEdges,2,'unrelated X endpoints stay fast');
equal(partialFast.fallbackEdges-allFast.fallbackEdges,2,'Y half pixels retain Double');
compareLayers('rects',rect(1,1,2,2,7),{scale:.5},9,9);
compareLayers('rects',rect(3000,0,2,2,7),{scale:1},9,9);
compareLayers('rects',rect(0,0,2,2,7),{scale:2.0000000000000004},9,9);
const fullFallback=native.canvasStats();
equal(fullFallback.fallbackRects-partialFast.fallbackRects,3,'half pixels and domain edges fall back');
for(const scale of [1/2048,.25,.5,.75,1,15/14,1.5,2,2.0000000000000004])
  for(const delta of [-1/128,-1/256,-1e-8,-1e-13,0,1e-13,1e-8,1/256,1/128])
    for(const half of [-.5,.5,7.5,15.5])
      compareLayers('rects',rect(0,0,7,7,0xaabbcc),
        {scale,x:half/scale+delta,y:(7.5-half)/scale-delta},41,39);

const runOne=new Int32Array([0,0,1]),rectOne=rect(),layerOne=new Int32Array([1,1,0x123456]);
for(const method of ['fillRunLayers','fillRectLayers']) {
  const geometry=method==='fillRunLayers'?runOne:rectOne;
  const deadCanvas=new Canvas(1,1);deadCanvas.dispose();throws(()=>deadCanvas[method](geometry),Error,'disposed '+method);
  for(const invalid of [null,[],new Uint32Array(3),new Float64Array(3)])
    throws(()=>new Canvas(2,2)[method](invalid),TypeError,'geometry type '+method);
  for(const options of [null,3,'x'])throws(()=>new Canvas(2,2)[method](geometry,options),TypeError,'options type');
  for(const count of [-1,-.5,.5,NaN,Infinity,8193,2147483647])
    throws(()=>new Canvas(2,2)[method](geometry,{count}),RangeError,'layer count');
  for(const scale of [0,-1,NaN,Infinity,1/4096,2049])
    throws(()=>new Canvas(2,2)[method](geometry,{scale}),RangeError,'layer scale');
  for(const step of [0,-1,NaN,Infinity,2049])
    throws(()=>new Canvas(2,2)[method](geometry,{step}),RangeError,'layer step');
  for(const layers of [[],new Uint32Array(3),new Float64Array(3)])
    throws(()=>new Canvas(2,2)[method](geometry,{layers}),TypeError,'layer type');
  for(const layers of [new Int32Array(1),new Int32Array(49),new Int32Array(51)])
    throws(()=>new Canvas(2,2)[method](geometry,{layers}),RangeError,'layer length');
  const canvas=new Canvas(2,2),truncated=geometry.subarray(0,geometry.length-1);
  throws(()=>canvas[method](truncated,{count:0}),RangeError,'geometry partial record');
  equal([...canvas._pixels],[0,0,0,0],'invalid record leaves canvas unchanged');
}
for(const option of ['padding','left','right','clipTop','clipBottom','margin'])
  for(const invalid of [NaN,Infinity,-Infinity,1000001,-1000001])
    throws(()=>new Canvas(2,2).fillRunLayers(runOne,{[option]:invalid}),RangeError,'run layout range '+option);
throws(()=>new Canvas(2,2).fillRunLayers(runOne,{step:.5}),RangeError,'fractional run step');
throws(()=>new Canvas(2,2).fillRunLayers(runOne,{padding:-1}),RangeError,'negative padding');
throws(()=>new Canvas(2,2).fillRunLayers(runOne,{margin:-1}),RangeError,'negative margin');
throws(()=>new Canvas(2,2).fillRunLayers(runOne,{clipTop:2,clipBottom:1}),RangeError,'reversed clip');
for(const option of ['x','y'])for(const invalid of [NaN,Infinity,-Infinity,1000001,-1000001])
  throws(()=>new Canvas(2,2).fillRectLayers(rectOne,{[option]:invalid}),RangeError,'rect origin range');
for(const input of [new Int32Array([0,0,0]),new Int32Array([0,0,-1]),new Int32Array([0,1,1,0,0,1]),
    new Int32Array([0,0,2,1,0,1])]) {
  const canvas=new Canvas(2,2);throws(()=>canvas.fillRunLayers(input),RangeError,'invalid sorted runs');
  equal([...canvas._pixels],[0,0,0,0],'invalid runs never paint');
}
compareLayers('runs',runOne,{layers:layerOne,color:4294967295});
compareLayers('runs',runOne,{layers:layerOne,color:-1});
compareLayers('runs',runOne,{layers:layerOne,color:1e308});

// 所有参数 getter/valueOf 在指针取得前执行；最后字段也能安全分离任意缓冲。
for(const method of ['fillRunLayers','fillRectLayers']) {
  const values=method==='fillRunLayers'?{count:1,step:1,scale:1,layers:null,padding:1,left:0,right:1,
    clipTop:0,clipBottom:2,margin:0,color:1}:{count:1,step:1,scale:1,layers:null,x:0,y:0};
  for(const key of Object.keys(values))for(const victim of ['pixels','geometry','layers']) {
    for(const throughValueOf of [false,true]) {
      if(key==='layers'&&throughValueOf)continue;
      const canvas=new Canvas(2,2),geometry=method==='fillRunLayers'?new Int32Array(runOne):new Int32Array(rectOne);
      const layers=new Int32Array(layerOne),options={layers},value=key==='layers'?layers:values[key];
      const target=victim==='pixels'?canvas._pixels:victim==='geometry'?geometry:layers;
      if(throughValueOf)options[key]={valueOf(){detach(target.buffer);return value;}};
      else Object.defineProperty(options,key,{get(){detach(target.buffer);return value;}});
      throws(()=>canvas[method](geometry,options),TypeError,'getter detach '+method+' '+key+' '+victim);
    }
  }
  const canvas=new Canvas(2,2),geometry=method==='fillRunLayers'?new Int32Array(runOne):new Int32Array(rectOne);
  const marker=new Error('layer getter failure');
  try{canvas[method](geometry,{get scale(){throw marker;}});throw new Error('missing failure');}
  catch(error){check(error===marker,'getter exception identity');}
  for(const victim of ['pixels','geometry','layers']) {
    const canvas=new Canvas(2,2),geometry=method==='fillRunLayers'?new Int32Array(runOne):new Int32Array(rectOne),layers=new Int32Array(layerOne);
    detach((victim==='pixels'?canvas._pixels:victim==='geometry'?geometry:layers).buffer);
    throws(()=>canvas[method](geometry,{layers}),TypeError,'already detached '+method+' '+victim);
  }
}
const keys=['count','step','scale','layers','padding','left','right','clipTop','clipBottom','margin','color'];
const onceOptions={},onceCounts={},onceValues={count:1,step:1,scale:1,layers:layerOne,padding:1,
  left:0,right:1,clipTop:0,clipBottom:2,margin:0,color:1};
for(const key of keys)Object.defineProperty(onceOptions,key,{get(){onceCounts[key]=(onceCounts[key]||0)+1;return onceValues[key];}});
new Canvas(2,2).fillRunLayers(runOne,onceOptions);
for(const key of keys)equal(onceCounts[key],1,'read each option once '+key);

for(const method of ['fillRunLayers','fillRectLayers']) {
  const width=method==='fillRunLayers'?3:5,aliasCanvas=new Canvas(width,1);
  const geometry=new Int32Array(aliasCanvas._pixels.buffer);
  geometry.set(method==='fillRunLayers'?[0,0,1]:[0,0,1,1,2]);
  throws(()=>aliasCanvas[method](geometry),RangeError,'geometry/pixel alias rejected');
  const canvas=new Canvas(3,1),layers=new Int32Array(canvas._pixels.buffer);
  layers.set([0,0,2]);
  throws(()=>canvas[method](method==='fillRunLayers'?runOne:rectOne,{layers}),RangeError,'layer/pixel alias rejected');
}
const sharedOwner=new ArrayBuffer(64),sharedPixelView=new Uint32Array(sharedOwner,0,4);
const sharedRunView=new Int32Array(sharedOwner,20,3),sharedLayerView=new Int32Array(sharedOwner,40,3);
sharedRunView.set([0,0,1]);sharedLayerView.set([1,1,2]);
const sharedResult=native.fillRunLayers(sharedPixelView,2,2,sharedRunView,{layers:sharedLayerView});
equal([...sharedPixelView],[0xffffff,0xffffff,0xffffff,0xffffff],'shared owner disjoint layers');
equal([...sharedRunView],[0,0,1],'shared owner run remains stable');
check(sharedResult.bounds.pixels===1,'shared owner result');
const sentinelPixels=new Uint32Array([0xabcdef,0,0,0,0,0x123456]);
native.fillRunLayers(sentinelPixels.subarray(1,5),2,2,new Int32Array([999,0,0,1,999]).subarray(1,4));
equal([...sentinelPixels],[0xabcdef,0xffffff,0xffffff,0xffffff,0xffffff,0x123456],'run pixel view sentinels');

const maximumRuns=new Int32Array(8192*3);
for(let i=0;i<8192;i++)maximumRuns.set([i*2,0,1],i*3);
const maximumResult=new Canvas(1,1).fillRunLayers(maximumRuns);
check(maximumResult.pixels===8192,'maximum run count');
const largeRectCanvas=new Canvas(128,128);armInterrupt(1);
throws(()=>largeRectCanvas.fillRectLayers(rect(0,0,128,128,7)),InternalError,'layer pixels interrupt');
equal(largeRectCanvas._pixels.reduce((n,value)=>n+(value===7),0),4096,'layer pixels bounded before interrupt');
// 非8倍数行宽仍在原有行边界中断，不能提前或越过下一行继续写入。
for(const method of ['fillRects','fillRectLayers','fillRunLayers']) {
  const canvas=new Canvas(129,64);
  armInterrupt(method==='fillRunLayers'?2:1);
  throws(()=>method==='fillRunLayers'
    ?canvas.fillRunLayers(new Int32Array([0,0,3]),{step:64,padding:0,color:7})
    :canvas[method](rect(0,0,129,64,7)),InternalError,method+' unaligned row interruption');
  check(canvas._pixels.every((value,index)=>value===(index<129*32?7:0)),
    method+' interrupted prefix ends after exactly32 rows');
}
armInterrupt(1);throws(()=>new Canvas(1,1).fillRunLayers(maximumRuns),InternalError,'run preprocessing interruption');
armInterrupt(1);throws(()=>new Canvas(1,1).fillRectLayers(new Int32Array(128*5)),InternalError,'empty rect interruption');
armInterrupt(-1);

// 整数布局覆盖：整数快速域边界、负整除、部分小数裁剪和大坐标Double回退。
const integerBefore=native.canvasStats();
for(const step of [1,2,3,7,31,2048])
  for(const gy of [-2048,-511,-7,-1,0,1,7,511])
    for(const ly of [-2049,-2048,-33,-7,-1,0,1,7,33,2048,2049])
      compareLayers('runs',new Int32Array([-2,gy,2,1,gy,3,-2,gy+1,6]),
        {step,padding:1,scale:15/14,layers:new Int32Array([-1,ly,0xff1100,1,ly+1,0x223355]),
          clipTop:-.25,clipBottom:11.5,margin:.5},17,13);
for(const padding of [0,1,2048,2049,.5,1.0000000000000002])
  for(const offset of [-2147483648,-1048577,-1048576,-1,0,1,1048576,1048577,2147483647])
    for(const origin of [-2147483648,-1048577,-1048576,0,1048576,1048577,2147483646])
      compareLayers('runs',new Int32Array([origin,-1,1,origin,0,1]),
        {padding,step:1,layers:new Int32Array([offset,offset,0x112233]),margin:0,
          left:-4.25,right:8.75,scale:.75},13,11);
for(const step of [1,7,2048])
  for(const padding of [0,1,2048,.5])
    compareLayers('runs',new Int32Array([-1048576,0,1048576,0,0,1048576]),
      {step,padding,layers:new Int32Array([3,-1,0x123456]),margin:0,scale:.75},17,13);
for(let pass=0;pass<2000;++pass) {
  const records=[],layers=[];
  for(let y=-2;y<=2;++y) {
    let x=-12;
    for(let n=0;n<4;++n) {const width=1+random()%7;records.push(x,y,width);x+=width+random()%4;}
  }
  for(let l=0;l<pass%5;++l)layers.push((random()%101)-50,(random()%101)-50,random());
  compareLayers('runs',new Int32Array(records),{step:1+random()%2048,padding:pass%3===0?.5:random()%2049,
    layers:new Int32Array(layers),scale:[.5,1,15/14,2][pass%4],margin:(pass%7)*.125,
    clipTop:(pass%5)*.25-1,clipBottom:12.75},19,17);
}
const integerAfter=native.canvasStats();
check(integerAfter.integerShadowBatches>integerBefore.integerShadowBatches,'integer shadow fast domain exercised');
check(integerAfter.doubleShadowBatches>integerBefore.doubleShadowBatches,'fractional and out-of-range fallback exercised');

// 原生写到一半抛错，调用者捕获后自动flush仍需提交已改像素。
for(const method of ['fillRect','fillRects','fillRectLayers','fillRunLayers']) {
  const canvas=new Canvas(128,128);
  armInterrupt(method==='fillRunLayers'?2:1);
  throws(()=>method==='fillRunLayers'
    ?canvas.fillRunLayers(new Int32Array([0,0,2]),{step:64,padding:0,color:7})
    :method==='fillRect'?canvas.fillRect(0,0,128,128,7)
    :canvas[method](rect(0,0,128,128,7)),InternalError,method+' partial native write');
  equal(canvas._pixels.reduce((count,value)=>count+(value===7),0),4096,method+' wrote prefix before failure');
  equal(canvas._dirty,{x:0,y:0,right:128,bottom:128},method+' caught failure remains dirty');
  armInterrupt(-1);
}
