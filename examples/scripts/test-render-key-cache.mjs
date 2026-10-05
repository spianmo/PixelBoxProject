import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourcePath = resolve(root, 'examples/06-obeing-pixel/src/render.ts');
const candidatePath = process.argv.find(value => value.startsWith('--candidate='))?.slice(12);
const candidateSource = readFileSync(candidatePath || sourcePath, 'utf8');
const baselineSource = readFileSync(new URL('./fixtures/render-key-cache-reference.ts', import.meta.url), 'utf8');
const entry = `
export {sceneKey,companionBody,beginScene,drawScene} from './examples/06-obeing-pixel/src/render';
export {drawHarness} from './examples/07-obeing-harness/src/render';
export {layoutScreen} from './examples/06-obeing-pixel/src/layout';
export {initialState} from './examples/06-obeing-pixel/src/state';
export {CatMotion,CAT_SHAPES,prepareCat} from './examples/06-obeing-pixel/src/model';
export {fillRunLayers,fillRectLayers} from './sdk/src/run-layers';`;
async function compile(candidate, format = 'esm') {
  return build({ stdin: { contents: format === 'iife' ? entry.replaceAll('export {', 'import {') +
    '\nglobalThis.__keyModule={sceneKey,companionBody,beginScene,drawScene,drawHarness,layoutScreen,initialState,CatMotion,CAT_SHAPES,prepareCat,fillRunLayers,fillRectLayers};' : entry,
    resolveDir: root, loader: 'ts' }, bundle: true, write: false, format, target: 'es2020',
    plugins: [{ name: 'immutable-candidate', setup(builder) {
      builder.onLoad({ filter: /06-obeing-pixel\/src\/render\.ts$/ }, args => ({ contents: candidate ? candidateSource : baselineSource, loader: 'ts' }));
    } }] });
}
function check(condition, message) { if (!condition) throw Error(message); }
function equalPixels(a, b, message) {
  if (typeof samePixels === 'function') { samePixels(a); check(samePixels(b), message); return; }
  check(a.length === b.length, message + ': size');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw Error(message + ': pixel=' + i);
}
function exactKey(view, input) {
  return JSON.stringify([view.theme, input.fullscreen, input.settings, input.battery, view.state,
    view.connected, view.authenticated, view.muted, view.displayName, view.enterpriseId,
    view.phoneName, view.pairingCode, view.pairingPending]);
}
function keyCases(reference, candidate) {
  const view = reference.initialState(), input = { fullscreen: false, settings: false, battery: 80 };
  const mutations = [
    ['theme', ['light','dark']], ['state', ['idle','speaking','thinking','sleep','error']],
    ['connected', [true,false]], ['authenticated', [true,false]], ['muted', [true,false]],
    ['displayName', ['name','a\",\"b','', '你好小川']], ['enterpriseId', ['enterprise','', '\u0000']],
    ['phoneName', ['phone','', '\n']], ['pairingCode', ['012345','999999','']], ['pairingPending', [true,false]],
  ];
  let cases = 0;
  const verify = () => { const expected = exactKey(view, input); check(candidate.sceneKey(view,input) === expected, 'sceneKey 内容');
    check(candidate.sceneKey(view,input) === expected, 'sceneKey 重复命中内容'); cases++; };
  verify();
  for (const [name, values] of mutations) for (const value of values) { view[name] = value; verify(); }
  for (const [name,values] of [['fullscreen',[true,false,undefined]], ['settings',[true,false]], ['battery',[0,-0,-1,100,NaN,Infinity,-Infinity,80]]])
    for (const value of values) { input[name] = value; verify(); }
  // 不属于场景键的动态信息仍由主体/字幕独立更新，不能导致场景错误清屏。
  for (const [name,value] of [['assistantText','reply'],['userText','user'],['errorText','error'],['thinkingText','progress'],['level',91]]) {
    view[name]=value; verify();
  }
  const order = ['v.theme','i.fullscreen','i.settings','i.battery','v.state','v.connected','v.authenticated','v.muted',
    'v.displayName','v.enterpriseId','v.phoneName','v.pairingCode','v.pairingPending'];
  for (const mode of ['plain','changing','cascading','throws']) {
   const outputs=[];
   for (const api of [reference,candidate]) {
    const events = [], state = {...view}, incoming = {...input}, keys=[]; let calls = 0;
    const trap = (target,prefix) => new Proxy(target,{get(target,name){ events.push(prefix+name);
      if(mode==='throws'&&name==='pairingPending') throw Error('getter failure');
      if(mode==='changing'&&name==='displayName') return 'name'+calls++;
      if(mode==='cascading'&&name==='theme')target.phoneName='changed'+calls++;
      return target[name]; }});
    const v=trap(state,'v.'), i=trap(incoming,'i.');
    for(let run=0;run<3;run++) { events.length=0; let failed=false; try {keys.push(api.sceneKey(v,i));} catch(e){failed=e.message==='getter failure';}
      check(events.join('|')===order.join('|'),'getter 必须完整且顺序一致 '+mode);
      check(failed===(mode==='throws'),'getter 异常必须传播'); cases++;
    }
    outputs.push(keys);
   }
   check(JSON.stringify(outputs[0])===JSON.stringify(outputs[1]),'getter返回值必须一致 '+mode);
  }
  // 每次只保留最近一次结果；交错不同对象、多屏输入不会共享错误的键。
  for(let i=0;i<60;i++){const v={...view,theme:i%2?'light':'dark',displayName:'user'+i%3};const p={...input,battery:i%101};
    check(candidate.sceneKey(v,p)===exactKey(v,p),'交错输入');cases++;}
  return cases;
}
function surface(width,height,api,nativeCanvas=false,fontHeight=12) {
  const target={width,height,pixels:new Uint32Array(width*height),textCalls:0,clearCalls:0,fontHeight,
    resize(w,h){this.width=w;this.height=h;this.pixels=new Uint32Array(w*h);},
    clear(color){this.clearCalls++;this.pixels.fill(color);},
    fillRect(x,y,w,h,color){const left=Math.max(0,x),top=Math.max(0,y),right=Math.min(this.width,x+w),bottom=Math.min(this.height,y+h);
      if(right<=left||bottom<=top)return;for(let row=top;row<bottom;row++)this.pixels.fill(color,row*this.width+left,row*this.width+right);},
    fillRects(rects,count=rects.length/5){if(nativeCanvas)return native.fillRects(this.pixels,this.width,this.height,rects,count);
      for(let i=0;i<count;i++)this.fillRect(...rects.subarray(i*5,i*5+5));},
    fillRectLayers(rects,options){if(nativeCanvas)return native.fillRectLayers(this.pixels,this.width,this.height,rects,options);return api.fillRectLayers(this,rects,options);},
    drawText(text,x,y,style){this.textCalls++;const scale=style?.scale||1;
      for(const [index,char] of Array.from(text).entries()){const code=char.codePointAt(0);for(let bit=0;bit<this.fontHeight;bit++)if(code&(1<<bit))
        this.fillRect(x+(index*6+bit%3)*scale,y+Math.floor(bit/3)*scale,scale,scale,style?.color??0xffffff);}},
    measureText(text,style){check(style?.font==='pixel12','渲染字体必须仍为 pixel12');return {width:Array.from(text).length*6*(style?.scale||1),height:this.fontHeight*(style?.scale||1)};},
  };
  if(nativeCanvas){target.fillRunLayers=(runs,options)=>native.fillRunLayers(target.pixels,target.width,target.height,runs,options).bounds;
    target.fillRunLayersRestored=(runs,options,restore)=>native.fillRunLayersRestored(target.pixels,target.width,target.height,runs,options,restore).bounds;}
  return target;
}
function formState(){return {page:'assistant',returnPage:'assistant',field:'question',values:{tenant:'tenant',account:'account',password:'secret',region:'region',key:'key',origin:'https://example.invalid',oem:'oem',domain:'domain',question:'question'},upper:false,symbols:false,busy:false,speechReady:false};}
function renderCases(reference,candidate,nativeCanvas=false){
  if(nativeCanvas)globalThis.px={util:native};
  for(const api of [reference,candidate])for(const shape of api.CAT_SHAPES)api.prepareCat({shape,yaw:0,pitch:0,lift:0,squash:1},2000);
  let frames=0;
  const names=['idle','speaking-imu','fullscreen','glitch','captions','theme','pages','resize','font','scene-fields','characters'];
  const scenes=[];
  for(const [width,height] of [[320,448],[368,448],[480,480]])for(const name of names){
    const font=name==='font'?18:12;
    const expected=surface(width,height,reference,nativeCanvas,font),actual=surface(width,height,candidate,nativeCanvas,font);
    const view=reference.initialState();Object.assign(view,{state:'idle',connected:true,authenticated:true});
    scenes.push({name,expected,actual,view,form:formState(),motion:new reference.CatMotion(()=>.37)});
  }
  // 交错全部场景，确保缓存不能依赖某一个 screen、ViewState 或连续调用方。
  for(let i=0;i<72;i++)for(const {name,expected,actual,view,form,motion} of scenes){
    const clock=1000+i*67,moving=name.includes('imu'),tiltX=moving?Math.sin(i/9)*1.5:0,tiltY=moving?Math.cos(i/13)*1.5:0;
    view.state=name.includes('speaking')?'speaking':name==='fullscreen'?['idle','thinking','speaking','sleep','muted','error'][Math.floor(i/12)%6]:'idle';view.level=i*7%101;
    if(name==='captions'){const block=Math.floor(i/4);view.thinkingText=block%5===0?'progress'+block:'';view.errorText=block%5===1?'error'+block:'';
      view.assistantText=block%5===2?'reply'+block+'x'.repeat(block*10):'';view.userText=block%5===3?'user'+block+'y'.repeat(block):'';}
    if(name==='theme')view.theme=Math.floor(i/4)%2?'light':'dark';
    if(name==='pages'){form.page=['assistant','settings','editor','login','speech','server'][Math.floor(i/4)%6];form.upper=i%3===0;form.symbols=i%5===0;
      form.values.question='query'+i;form.busy=i%5===0;form.speechReady=i%3===0;form.field=i%2?'question':'password';view.errorText=i%3?'':'error'+i;view.thinkingText=i%3?'progress'+i:'';}
    if(name==='resize'&&i%12===0){const [w,h]=i%24?[480,480]:[320,448];expected.resize(w,h);actual.resize(w,h);}
    if(name==='scene-fields'){view.connected=i%2===0;view.authenticated=i%3===0;view.muted=i%5===0;view.displayName='name'+i%4;
      view.enterpriseId='enterprise'+i%6;view.phoneName='phone'+i%3;view.pairingCode='code'+i%2;view.pairingPending=i%2===0;}
    const input={clock,tiltX,tiltY,battery:name==='scene-fields'?i%101:80,settings:name==='scene-fields'&&i%2===0,
      fullscreen:name==='fullscreen'||name==='captions'&&i%24<12,character:name==='characters'?['cat','kitty-classic','kitty-witch','kitty-fish'][Math.floor(i/6)%4]:name==='captions'?'kitty-classic':'cat',
      shake:name==='glitch'?[0,.15,.15001,.6,1][i%5]:0,pose:motion.sample(view.state,clock,tiltX,tiltY,view.level)};
    const wake=name==='captions'?'wake'+Math.floor(i/4):'你好小川';
    reference.drawHarness(expected,view,input,form,wake);candidate.drawHarness(actual,view,input,form,wake);
    equalPixels(expected.pixels,actual.pixels,name+' '+expected.width+'x'+expected.height+' frame='+i);
    check(expected.clearCalls===actual.clearCalls,'场景清屏次数 '+name);check(expected.textCalls===actual.textCalls,'字幕刷新次数 '+name);frames++;
  }
  // companionBody 的 status/fallback 可由多个调用方直接提供，独立于 harness 页面。
  for(const char of ['cat','kitty-classic']){
    const expected=surface(368,448,reference,nativeCanvas),actual=surface(368,448,candidate,nativeCanvas),view=reference.initialState();view.state='idle';
    for(let i=0;i<42;i++){
      const input={clock:1000+i*33,tiltX:0,tiltY:0,battery:80,settings:false,character:char,pose:{yaw:0,pitch:0,lift:0,squash:1},shake:0};
      const status=i%14<7?'first':'second',fallback=i%7<3?'fallback 1':'fallback 2';
      for(const [api,target] of [[reference,expected],[candidate,actual]]){const screen=api.layoutScreen(target);api.beginScene(screen,'direct',0x080b0b);
        api.companionBody(screen,view,input,status,fallback);screen.finish();}
      equalPixels(expected.pixels,actual.pixels,'direct status/fallback '+i);check(expected.textCalls===actual.textCalls,'直接字幕刷新');frames++;
    }
  }
  return frames;
}
function captionGetterCases(reference,candidate,nativeCanvas=false){
  let cases=0;
  for(const changing of [false,true]){
    const observations=[];
    for(const api of [reference,candidate]){
      const target=surface(368,448,api,nativeCanvas),events=[],values=api.initialState();values.state='idle';
      let reads=0;
      const view=new Proxy(values,{get(object,name){events.push(name);if(changing&&name==='errorText')return ++reads%3?'':'error'+reads;return object[name];}});
      const input={clock:1000,tiltX:0,tiltY:0,battery:80,settings:false,character:'kitty-classic',pose:{yaw:0,pitch:0,lift:0,squash:1},shake:0};
      const screen=api.layoutScreen(target);
      for(let i=0;i<3;i++){events.length=0;api.beginScene(screen,'getter',0x080b0b);api.companionBody(screen,view,input,'status','fallback');screen.finish();
        observations.push({events:events.slice(),pixels:target.pixels.slice()});cases++;}
    }
    for(let i=0;i<3;i++){check(observations[i].events.join('|')===observations[i+3].events.join('|'),'字幕getter读取次数和顺序');
      equalPixels(observations[i].pixels,observations[i+3].pixels,'字幕变化getter像素');}
  }
  return cases;
}
function stringifyCases(reference,candidate,nativeCanvas=false){
  const results=[];
  for(const api of [reference,candidate]){const target=surface(368,448,api,nativeCanvas),view=api.initialState();view.state='idle';
    const input={clock:1000,tiltX:0,tiltY:0,battery:80,settings:false,character:'kitty-classic',pose:{yaw:0,pitch:0,lift:0,squash:1}};
    const form=formState();api.drawHarness(target,view,input,form);
    const saved=JSON.stringify,counts={scene:0,caption:0};
    try{JSON.stringify=function(value,...args){if(Array.isArray(value)){if(value.length===13)counts.scene++;if(value.length===7)counts.caption++;}return saved.call(this,value,...args);};
      for(let i=0;i<20;i++)api.drawHarness(target,view,input,form);
    }finally{JSON.stringify=saved;}
    results.push(counts);
  }
  check(results[0].scene===20&&results[0].caption===20,'参考必须每帧序列化');
  check(results[1].scene===0&&results[1].caption===0,'候选稳定输入不得重复序列化');return results;
}
const nativeOutput=process.argv.find(value=>value.startsWith('--native-out='))?.slice(13);
if(nativeOutput){const base=await compile(false,'iife'),next=await compile(true,'iife');
  writeFileSync(nativeOutput,base.outputFiles[0].text+'\nconst reference=__keyModule;\n'+next.outputFiles[0].text+'\nconst candidate=__keyModule;\n'+
    [check,equalPixels,exactKey,keyCases,surface,formState,renderCases,captionGetterCases,stringifyCases].join('\n')+
    '\nprint(JSON.stringify({keyCases:keyCases(reference,candidate),frames:renderCases(reference,candidate,true),captionGetters:captionGetterCases(reference,candidate,true),stringify:stringifyCases(reference,candidate,true)}));');
  console.log('生成真实 native Canvas 对照: '+nativeOutput);
}else{const base=await compile(false),next=await compile(true);
  const reference=await import('data:text/javascript;base64,'+Buffer.from(base.outputFiles[0].text).toString('base64'));
  const candidate=await import('data:text/javascript;base64,'+Buffer.from(next.outputFiles[0].text).toString('base64'));
  console.log(JSON.stringify({keyCases:keyCases(reference,candidate),frames:renderCases(reference,candidate),captionGetters:captionGetterCases(reference,candidate),stringify:stringifyCases(reference,candidate)}));
}
