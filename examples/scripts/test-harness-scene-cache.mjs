// 可放入examples/scripts；默认审查生产源码，也支持--candidate=独立候选路径。
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {transformSync}=await import(pathToFileURL(resolve('examples/node_modules/esbuild/lib/main.js')).href);
const candidate=process.argv.find(x=>x.startsWith('--candidate='))?.slice(12)||'examples/07-obeing-harness/src/render.ts';
const source=readFileSync(candidate,'utf8');
const start=source.indexOf('type HarnessSceneCache'),end=source.indexOf('function renderHarness');
assert.ok(start>=0&&end>start,'候选需包含harnessSceneKey');
const compiled=transformSync(source.slice(start,end),{loader:'ts',target:'es2020'}).code;
const create=new Function('sceneKey',compiled+';return harnessSceneKey;');
const reference=sceneKey=>(view,input,form,phrase)=>sceneKey(view,input)+JSON.stringify(form.page==='assistant'?[form.page,phrase]:[form,view.errorText,view.thinkingText]);
function fixture(make,mode) {
 const log=[],marker=new Error('getter failed');let page='assistant',base='base',phrase='wake',phase=0,throws=false;
 const view={get errorText(){log.push('errorText');return 'err';},get thinkingText(){log.push('thinkingText');return 'think';}};
 const form={get page(){log.push('page');if(throws)throw marker;
  if(mode==='changing')return phase++%2===0?'assistant':page;
  if(mode==='cascading')view.sideEffect=phase++;
  return page;},toJSON(){log.push('toJSON');return {page};}};
 const sceneKey=()=>{log.push('scene');return base;},key=make(sceneKey);
 return {log,run(i){page=['assistant','settings','assistant','editor','assistant'][i%5];base='b'+Math.floor(i/11);phrase=['wake','你好','a"\\b','','wake'][Math.floor(i/7)%5];throws=mode==='throws'&&i%37===0;
  try{return {key:key(view,{},form,phrase)};}catch(e){return {thrown:e===marker};}}};
}
let cases=0;
for(const mode of ['plain','changing','cascading','throws']) {
 const a=fixture(reference,mode),b=fixture(create,mode);
 for(let i=0;i<1000;i++){a.log.length=b.log.length=0;assert.deepEqual(b.run(i),a.run(i));assert.deepEqual(b.log,a.log);cases++;}
}
// 同一字段变化必须失效；assistant稳定时停止序列化，非assistant仍执行form.toJSON。
const fn=create(()=> 'base'),view={errorText:'',thinkingText:''},form={page:'assistant'};
const original=JSON.stringify;let serializations=0;
try {
 JSON.stringify=(...args)=>{serializations++;return original(...args);};
 for(let i=0;i<20;i++)assert.equal(fn(view,{},form,'wake'),'base["assistant","wake"]');
 assert.equal(serializations,1);assert.equal(fn(view,{},form,'changed'),'base["assistant","changed"]');assert.equal(serializations,2);
 form.page='settings';for(let i=0;i<3;i++)fn(view,{},form,'changed');assert.equal(serializations,5);
}finally{JSON.stringify=original;}
console.log(JSON.stringify({cases,stableAssistantSerializations:1,nonAssistantSerializations:3}));
