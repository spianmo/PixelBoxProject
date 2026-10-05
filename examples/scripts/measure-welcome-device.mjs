#!/usr/bin/env node
/** 原欢迎页临时推送验证；不删除已安装应用来触发欢迎页。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { DevdClient } from '../../sdk/dist/devd.js';
import { callbackProbe, snapshotCode, metrics } from './device-fps-metrics.mjs';
const { values } = parseArgs({ options: { host: { type:'string' }, output: { type:'string' }, seconds: { type:'string', default:'10' } } });
const seconds=Number(values.seconds);
if(!values.host||!values.output||!Number.isFinite(seconds)||seconds<2||seconds>60)throw new Error('--host IP --output NEW_FILE [--seconds 10]');
if(fs.existsSync(values.output))throw new Error('结果文件已存在');
fs.mkdirSync(path.dirname(path.resolve(values.output)),{recursive:true});
const data=Buffer.concat([Buffer.from(callbackProbe),fs.readFileSync(new URL('../../firmware/components/appmgr/src/default_app.js',import.meta.url))]);
const sha=crypto.createHash('sha256').update(data).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={startedAt:new Date().toISOString(),source:'firmware/components/appmgr/src/default_app.js',sha256:sha,seconds};
let client;
try {
 client=await DevdClient.connect(values.host,{connectTimeoutMs:15000});
 await client.pushApp({id:'com.pixelbox.tests.welcome-fps',name:'欢迎页性能验证',version:'1.0.0',entry:'main.js',assets:[],minFirmware:'0.1.0'},[{path:'main.js',data}]);
 let ready=false;
 for(let i=0;i<120;i++) {
  try {if(await client.evalJs("Array.from(new Uint8Array(px.util.sha256(px.storage.fs.readBytes('/app/main.js'))),x=>x.toString(16).padStart(2,'0')).join('')",5000)===sha&&await client.evalJs('typeof __deviceFps',5000)==='object'){ready=true;break;}}catch{}
  await sleep(250);
 }
 if(!ready)throw new Error('欢迎页bundle未就绪');
 await sleep(2000);
 const before=JSON.parse(await client.evalJs(snapshotCode,10000));
 await sleep(seconds*1000);
 const after=JSON.parse(await client.evalJs(snapshotCode,10000));
 report.sample={...metrics(before,after),before,after};
 console.log(JSON.stringify(report.sample));
} catch(error) {report.error=error.message;process.exitCode=1;console.error(error);}
finally {client?.close();report.finishedAt=new Date().toISOString();fs.writeFileSync(values.output,JSON.stringify(report,null,2)+'\n');}
