#!/usr/bin/env node
/** 串行独占设备，测量所有 example；零有效提交表示采样期间无像素变化。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DevdClient } from '../../sdk/dist/devd.js';
import { buildApp, collectPushFiles } from '../../sdk/dist/build.js';
import { callbackProbe, snapshotCode, sampleMetrics } from './device-fps-metrics.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  host:{type:'string'}, output:{type:'string'}, seconds:{type:'string',default:'10'},
} });
const seconds=Number(values.seconds);
if(!values.host||!values.output||!Number.isFinite(seconds)||seconds<1||seconds>60)
  throw new Error('用法: --host IP --output NEW_DIR [--seconds 10]');
const output=path.resolve(values.output);
fs.mkdirSync(output,{recursive:true});
if(fs.existsSync(path.join(output,'results.json')))throw new Error('请使用新的输出目录，保留已有测量证据');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shaOf=data=>crypto.createHash('sha256').update(data).digest('hex');
const identity="JSON.stringify({id:px.app.id,sha:Array.from(new Uint8Array(px.util.sha256(px.storage.fs.readBytes('/app/main.js'))),v=>v.toString(16).padStart(2,'0')).join('')})";
const dirs=fs.readdirSync(path.join(root,'examples'),{withFileTypes:true})
  .filter(e=>e.isDirectory()&&fs.existsSync(path.join(root,'examples',e.name,'pixelbox.json'))).map(e=>e.name).sort();
const result={host:values.host,seconds,startedAt:new Date().toISOString(),
  method:'设备performance.now差值；onFrame包装计数且保留原返回值；有效FBIO_UPDATE计数；不代表面板物理刷新率',
  examples:[],restoredSettings:false};
let client;
const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2)+'\n');
async function evalJson(code){return JSON.parse(await client.evalJs(code,10000));}
async function push(manifest,files){
  for(let attempt=0;;attempt++)try{return await client.pushApp(manifest,files);}catch(error){
    if(attempt>=3||!/another push is active|application stopped|updating|busy/i.test(error.message))throw error;
    await delay(1000*(attempt+1));
  }
}
async function sample(name){
  const measured=await sampleMetrics(()=>evalJson(snapshotCode),delay,seconds*1000);
  return {scenario:name,...measured};
}
try{
  client=await DevdClient.connect(values.host,{port:8765,connectTimeoutMs:15000});
  result.hello=await client.hello();
  for(const name of dirs){
    const item={name,samples:[]};result.examples.push(item);
    try{
      const built=await buildApp(path.join(root,'examples',name));
      item.id=built.manifest.id;
      const files=collectPushFiles(built);
      const entry=files.find(file=>file.path===built.manifest.entry);
      if(!entry)throw new Error('bundle entry missing');
      item.sourceSha256=shaOf(entry.data);
      entry.data=Buffer.concat([Buffer.from(callbackProbe),entry.data]);
      item.measuredSha256=shaOf(entry.data);
      await push(built.manifest,files);
      const deadline=Date.now()+30000;
      let ready=false;
      while(Date.now()<deadline){
        try{const cur=await evalJson(identity);
          if(cur.id===item.id&&cur.sha===item.measuredSha256&&await client.evalJs('typeof __deviceFps',5000)==='object'){ready=true;break;}
        }catch{/* VM热切换，下一次轮询确认实际bundle。 */}
        await delay(300);
      }
      if(!ready)throw new Error('30秒内未启动本次bundle');
      await delay(name==='07-obeing-harness'?6000:1500);
      item.samples.push(await sample('default'));
      if(name==='08-fps-touch-probe'){
        // 用设备定时器持续送 move，排除网络逐点发送的吞吐限制；并非物理手指测试。
        await client.evalJs(`__refreshProbe.down(100,390);globalThis.__probeStart=performance.now();
          globalThis.__probeTimer=setInterval(()=>{
            const phase=((performance.now()-__probeStart)%1600)/800;
            __refreshProbe.move(100,390-260*(phase<=1?phase:2-phase));
          },16);true`,5000);
        try{item.samples.push(await sample('continuous-injected-drag'));}
        finally{await client.evalJs('clearInterval(__probeTimer);__refreshProbe.up(100,390);true',5000);}
      }
      const finalId=await evalJson(identity);
      if(finalId.id!==item.id||finalId.sha!==item.measuredSha256)throw new Error('测量中bundle被其他任务切换');
      item.success=true;
    }catch(error){item.error=error.message;process.exitCode=1;}
    save();console.log(JSON.stringify({name,success:item.success,error:item.error,samples:item.samples.map(({scenario,callbackFps,submittedFps,elapsedMs,errors})=>({scenario,callbackFps,submittedFps,elapsedMs,errors}))}));
    await delay(1000);
  }
}finally{
  try{
    await client?.openSettings();
    for(let i=0;i<40;i++){
      try{if(await client.evalJs('typeof __pxset',3000)==='object'){result.restoredSettings=true;break;}}catch{}
      await delay(300);
    }
  }catch(error){result.restoreError=error.message;}
  client?.close();result.finishedAt=new Date().toISOString();save();
}
console.log(`已写入 ${path.join(output,'results.json')}`);
