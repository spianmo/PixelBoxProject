// 使用真实文字C绑定，验证左/中/右对齐、坐标回绕、getter只读取一次和异常标脏。
for(const align of ['left','center','right']) {
  const canvas=new Canvas(64,32),x=align==='left'?1:align==='center'?32:64;
  canvas.drawText('AB\nC',x,1,{align});
  check(canvas._pixels.some(value=>value!==0),'text writes pixels '+align);
  equal(canvas._dirty,{x:0,y:0,right:64,bottom:32},'text full dirty '+align);
}
const wrappedText=new Canvas(64,16);
wrappedText.drawText('A',4294967296,0);
check(wrappedText._pixels.some(value=>value!==0),'text ToInt32 wrapped origin writes visible pixels');
equal(wrappedText._dirty,{x:0,y:0,right:64,bottom:16},'wrapped text keeps dirty');
const onceText=new Canvas(64,16),textReads={},textValues={color:0xabcdef,font:'pixel8',scale:1,align:'right',smooth:false};
const textStyle={};
for(const key of Object.keys(textValues))Object.defineProperty(textStyle,key,{get(){
  textReads[key]=(textReads[key]||0)+1;
  if(textReads[key]>1)throw new Error('text style reread '+key);
  return textValues[key];
}});
let contentReads=0;
onceText.drawText({toString(){if(++contentReads>1)throw new Error('text content reread');return 'AB';}},64,0,textStyle);
for(const key of Object.keys(textValues))equal(textReads[key],1,'text reads style once '+key);
equal(contentReads,1,'text converts content once');
check(onceText._pixels.some(value=>value===0xabcdef),'text with getter styles is painted');
const failedText=new Canvas(16,16),textMarker=new Error('style getter failed');
try {failedText.drawText('A',0,0,{get color(){throw textMarker;}});throw new Error('missing text failure');}
catch(error){check(error===textMarker,'text preserves original exception');}
equal(failedText._dirty,{x:0,y:0,right:16,bottom:16},'failed text remains dirty');
