// 完整背景+网格+原主体构成独立参照，初始非纯色图像暴露错误跳写留下的残影。
function referenceRestore(canvas,options,restore) {
  const scale=options.scale??1,logicalWidth=canvas.width/scale,logicalHeight=canvas.height/scale;
  const left=Math.max(0,Math.floor(restore[0])),top=Math.max(0,Math.floor(restore[1]));
  const right=Math.min(logicalWidth,Math.ceil(restore[2])),bottom=Math.min(logicalHeight,Math.ceil(restore[3]));
  layerPhysical(canvas,scale,left,top,right-left,bottom-top,restore[4]);
  if(!restore[8])return;
  const gridTop=restore[5],gridBottom=restore[6],color=restore[7];
  for(let x=24;x<logicalWidth-20;x+=20)
    if(x>=left&&x<right)
      layerPhysical(canvas,scale,x,Math.max(top,gridTop),1,Math.max(0,Math.min(bottom,gridBottom)-Math.max(top,gridTop)),color);
  for(let y=gridTop;y<gridBottom;y+=20)
    if(y>=top&&y<bottom)
      layerPhysical(canvas,scale,Math.max(left,24),y,Math.max(0,Math.min(right,logicalWidth-24)-Math.max(left,24)),1,color);
}
function compareRestored(values,options,description,width=79,height=63) {
  const runs=new Int32Array(values),restore=new Float64Array(description);
  const actual=new Canvas(width,height),expected=new Canvas(width,height);
  for(let i=0;i<actual._pixels.length;++i)actual._pixels[i]=expected._pixels[i]=(Math.imul(i+1,0x739e)&0xffffff);
  referenceRestore(expected,options,restore);
  const before=[...runs],beforeRestore=[...restore];
  const reference=referenceRunLayers(expected,runs,options);
  const result=actual.fillRunLayersRestored(runs,options,restore);
  for(const key of Object.keys(reference))check(Object.is(result[key],reference[key]),'restored bounds '+key);
  equal([...actual._pixels],[...expected._pixels],'restored pixels '+JSON.stringify(options)+' '+description);
  equal(actual._dirty,expected._dirty,'restored dirty union');
  equal([...runs],before,'restored geometry immutable');equal([...restore],beforeRestore,'restored description immutable');
}
const restorationBefore=native.canvasStats();
const restoreShapes=[[],[1,1,9],[1,1,2,8,1,2,1,2,9,1,3,9],
  [1,0,3,1,1,3,1,3,3],[-4,-2,8,-3,-1,7,-2,0,6],
  [-2147483648,0,2147483647,0,0,2147483647]];
for(const values of restoreShapes)for(const scale of [.25,.5,1,15/14,1.5,2,2048])
  for(const padding of [0,.5,1,2.5])for(const gridEnabled of [0,1])
    compareRestored(values,{step:5,scale,padding,margin:3.5,clipTop:-.5,clipBottom:55.5,
      left:-5.25,right:58.75,layers:new Int32Array([5,-5,0x112233,-5,5,0x445566])},
      [-3.5,1.5,66.5,59.25,0x080b0b,3.5,61.5,0x18201e,gridEnabled]);
for(let pass=0;pass<500;++pass) {
  const values=[];
  for(let y=-3;y<15;y++) {
    if(random()%7===0)continue;
    let x=-4;
    for(let n=0;n<1+pass%3;n++){const width=1+random()%7;values.push(x,y,width);x+=width+random()%6;}
  }
  compareRestored(values,{step:1+pass%7,scale:[.5,1,15/14,1.5,2,3][pass%6],padding:[0,.5,1,3][pass%4],
    margin:pass%2?.5:undefined,clipTop:(pass%5)*.25,clipBottom:42.75,
    color:pass%5?0xffffff:0x123456,layers:new Int32Array([7,-7,0x772211,-3,5,0x22aaff])},
    [(random()%23)-7.5,(random()%17)-3.5,45.75+random()%30,30.25+random()%30,
      pass%2?0x080b0b:0xffffff,-.25,58.75,0x234567,pass%3?1:0]);
}
const restorationAfter=native.canvasStats();
check(restorationAfter.restoredBatches-restorationBefore.restoredBatches===836,'restored coverage scene count');
check(restorationAfter.restoreSkippedPixels>restorationBefore.restoreSkippedPixels,'white-body background writes skipped');

// 描述长度/类型/数值/alias均在绘制前拒绝；count前缀不读尾部无效run。
const restoredRun=new Int32Array([0,0,1]),validRestore=new Float64Array([0,0,8,8,1,0,8,2,1]);
for(const value of [undefined,null,[],new Int32Array(9)])
  throws(()=>new Canvas(8,8).fillRunLayersRestored(restoredRun,{},value),TypeError,'restore typed array required');
for(const length of [0,8,10])throws(()=>new Canvas(8,8).fillRunLayersRestored(restoredRun,{},new Float64Array(length)),RangeError,'restore exact length');
for(let field=0;field<9;field++)for(const value of [NaN,Infinity,-Infinity]) {
  const description=new Float64Array(validRestore);description[field]=value;
  const canvas=new Canvas(8,8);
  throws(()=>canvas.fillRunLayersRestored(restoredRun,{},description),RangeError,'restore finite fields');
  check(canvas._pixels.every(value=>value===0),'invalid restoration writes nothing');
}
for(const [field,value] of [[0,1000001],[5,-1000001],[4,-1],[4,.5],[7,4294967296],[8,.5],[8,2]]) {
  const description=new Float64Array(validRestore);description[field]=value;
  throws(()=>new Canvas(8,8).fillRunLayersRestored(restoredRun,{},description),RangeError,'restore field limits');
}
for(const victim of ['pixels','runs','restore','layers']) {
  const canvas=new Canvas(8,8),runs=new Int32Array(restoredRun),restore=new Float64Array(validRestore),layers=new Int32Array([1,1,3]);
  const buffer={pixels:canvas._pixels.buffer,runs:runs.buffer,restore:restore.buffer,layers:layers.buffer}[victim];
  throws(()=>canvas.fillRunLayersRestored(runs,{layers,get scale(){detach(buffer);return 1;}},restore),TypeError,'getter detaches restore '+victim);
}
for(const victim of ['pixels','runs','layers']) {
  const owner=new ArrayBuffer(8*8*4),restore=new Float64Array(owner,0,9);restore.set(validRestore);
  const pixels=victim==='pixels'?new Uint32Array(owner):new Uint32Array(64);
  const runs=victim==='runs'?new Int32Array(owner,0,3):restoredRun;
  const options=victim==='layers'?{layers:new Int32Array(owner,0,3)}:{};
  throws(()=>native.fillRunLayersRestored(pixels,8,8,runs,options,restore),RangeError,'restore overlap '+victim);
}
compareRestored([0,0,1,0,-1,-1],{count:1,scale:1},[0,0,6,6,1,0,8,2,0],8,8);
compareRestored([0,0,1],{step:2048,scale:1/2048},[-.5,-.5,100000,100000,1,-1000.25,1000.75,2,1],8,8);
compareRestored([0,0,1],{scale:1},[7,7,1,1,1,0,8,2,1],8,8);
const interruptedRestore=new Canvas(128,128);armInterrupt(1);
throws(()=>interruptedRestore.fillRunLayersRestored(new Int32Array(),{},
  new Float64Array([0,0,128,128,7,0,0,0,0])),InternalError,'restoration writes poll interruption');
check(interruptedRestore._pixels.some(value=>value===7),'restoration partially wrote before interrupt');
equal(interruptedRestore._dirty,{x:0,y:0,right:128,bottom:128},'restoration failure remains dirty');
armInterrupt(-1);

// 连续融合在同一画布反复移动，交替网格平移/小数padding/裁剪，暴露跨帧缓存或残影。
{
  const actual=new Canvas(80,96),expected=new Canvas(80,96);
  for(let frame=0;frame<160;frame++) {
    const values=[];
    for(let row=0;row<7;row++)values.push(14+(frame%5)+row%2,12+row*4,10+row%3);
    const runs=new Int32Array(values),scale=[.5,1,15/14,1.5,2][frame%5];
    const options={scale,step:1,padding:frame%7===0?.5:1,margin:frame%2?0:-0,
      left:-(frame%4)*2**-44,right:36,clipTop:frame%11===0?14:0,
      clipBottom:frame%13===0?30.5:96/scale,
      layers:new Int32Array([-2,-2,0x335577,2,2,0x993311])};
    const restore=new Float64Array([0,0,80/scale,96/scale,0x101312,3.5,96/scale,0x223322,frame%3?1:0]);
    referenceRestore(expected,options,restore);
    const reference=referenceRunLayers(expected,runs,options);
    const result=actual.fillRunLayersRestored(runs,options,restore);
    for(const key of Object.keys(reference))check(Object.is(result[key],reference[key]),'continuous restored bounds '+frame+' '+key);
    equal([...actual._pixels],[...expected._pixels],'continuous restored pixels '+frame);
    equal(actual._dirty,expected._dirty,'continuous restored dirty '+frame);
  }
}
