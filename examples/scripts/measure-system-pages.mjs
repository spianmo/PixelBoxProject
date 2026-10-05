#!/usr/bin/env node
/** 设置页真机验收：真实扫描 + 显式标记的合成列表/连接状态，只影响测试 VM。 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DevdClient } from '../../sdk/dist/devd.js';
import { snapshotCode, sampleMetrics } from './device-fps-metrics.mjs';
const {values}=parseArgs({options:{host:{type:'string'},output:{type:'string'},seconds:{type:'string',default:'8'}}});
const seconds=Number(values.seconds);
if(!values.host||!values.output||!Number.isFinite(seconds)||seconds<2||seconds>30)throw new Error('--host IP --output NEW_DIR [--seconds 8]');
const output=path.resolve(values.output);fs.mkdirSync(output,{recursive:true});
if(fs.existsSync(path.join(output,'results.json')))throw new Error('输出目录已有结果');
const report={host:values.host,startedAt:new Date().toISOString(),seconds,method:'设备单调时钟；JS回调及有效FBIO_UPDATE；拖动为设备定时器注入，未经物理触摸采样',items:[]};
const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let c;
const ev=code=>c.evalJs(code,10000);
const j=async code=>JSON.parse(await ev(`JSON.stringify(${code})`));
async function waitForState(predicate, timeoutMs=3000){
 const deadline=Date.now()+timeoutMs;
 let last;
 while(Date.now()<deadline){
  last=await j('__pxset.state()');
  if(predicate(last))return last;
  await sleep(50);
 }
 throw new Error(`等待设备状态超时: ${JSON.stringify(last)}`);
}
async function open(){
 await c.openSettings();await sleep(500);
 for(let i=0;i<160;i++){
  try{if(await ev('typeof __pxset')==='object'){await sleep(500);return;}}catch{}
  await sleep(250);
 }
 throw new Error('设置页未在期限内启动');
}
async function sample(name,page,notes=''){
 const state=await j('__pxset.state()');if(state.page!==page)throw new Error(`${name}: 预期${page}，实际${state.page}`);
 const measured=await sampleMetrics(async()=>JSON.parse(await ev(snapshotCode)),sleep,seconds*1000);
 const item={name,notes,...measured,beforeState:state,afterState:await j('__pxset.state()')};
 if(item.afterState.page!==page)throw new Error(`${name}: 测量中页面改变`);
 report.items.push(item);save();console.log(JSON.stringify({name,callbackFps:item.callbackFps,submittedFps:item.submittedFps,elapsedMs:item.elapsedMs,errors:item.errors}));
}
async function drag(name,page,amplitude){
 // x=100选择左侧标签滚动手柄；初次move跨过TAP_SLOP并重设锚点。
 await ev(`__pxset.down(100,360);__pxset.move(100,340);globalThis.__dragAt=performance.now();
  globalThis.__dragTimer=setInterval(()=>{const p=((performance.now()-__dragAt)%1600)/800;
    __pxset.move(100,340-${amplitude}*(p<=1?p:2-p));},16);true`);
 try{await sample(name,page,'设备端16ms move注入，连续三角波往返拖动');}
 finally{await ev('clearInterval(__dragTimer);__pxset.up(100,340);true');}
 await sleep(400);
}
async function capture(name){
 const {width,height}=await j('({width:px.screen.width,height:px.screen.height})');
 const bytes=Buffer.alloc(width*height*3);let offset=0;
 // 分块读取帧缓冲，避免一次巨大JSON阻塞设备；输出是软件截图，不是实拍。
 for(let top=0;top<height;top+=16){
  const runs=await j(`(()=>{const a=[],p=px.screen._pixels;let color=-1,n=0;for(let i=${top*width};i<${Math.min(height,top+16)*width};i++){
    const v=p[i];if(v===color)n++;else{if(n)a.push(color,n);color=v;n=1;}}if(n)a.push(color,n);return a})()`);
  for(let i=0;i<runs.length;i+=2)for(let n=0;n<runs[i+1];n++){
    bytes[offset++]=(runs[i]>>16)&255;bytes[offset++]=(runs[i]>>8)&255;bytes[offset++]=runs[i]&255;
  }
 }
 fs.writeFileSync(path.join(output,`${name}.ppm`),Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),bytes]));
}
try{
  // devd 固定监听 8765；显式传端口，避免客户端默认端口导致握手超时。
  c=await DevdClient.connect(values.host,{port:8765,connectTimeoutMs:15000});
 await open();report.system=await j('px.system.info()');report.wifi=await j('px.wifi.status()');
 await sample('main-idle','main');await capture('main');
 const st=await j('__pxset.state()');await drag('main-continuous-scroll','main',st.mainMaxScroll);
 await ev('__pxset.tap(__pxset.rows.wifi.x,__pxset.rows.wifi.y);true');
 await sample('wifi-real-scan-and-list','wifi','调用真实Wi-Fi扫描，扫描完成后保留真实列表');
 for(let i=0;i<80&&(await j('__pxset.state()')).scanning;i++)await sleep(250);
 if((await j('__pxset.state()')).scanning)throw new Error('真实扫描未完成');
 await sample('wifi-real-list-idle','wifi');await capture('wifi');
 // 当前环境只有少量AP，另用固定20项数据验收可滚动列表，不冒称扫描到20个AP。
 await waitForState(state=>!state.scanning&&!state.pendingAps);
 await ev(`__pxset.up(0,0);px.wifi.scan=()=>Promise.resolve(Array.from({length:20},(_,i)=>({ssid:'FPS-Test-'+String(i+1).padStart(2,'0'),rssi:-30-i*2,secure:true})));__pxset.tap(px.screen.width-20,Math.floor(px.screen.height*0.05));true`);
 await waitForState(state=>!state.scanning&&!state.pendingAps&&state.aps===20);
 await drag('wifi-20-rows-continuous-scroll','wifi',240);
 // 回到顶部，进入测试网络密码页；后续连接方法被替换，不断开真实Finger连接。
 await ev('__pxset.tap(20,Math.floor(px.screen.height*0.05));true');await sleep(300);
 await ev('__pxset.tap(__pxset.rows.wifi.x,__pxset.rows.wifi.y);true');await sleep(500);
 await ev(`px.wifi.scan=()=>Promise.resolve([{ssid:'FPS-Test',rssi:-35,secure:true}]);__pxset.tap(px.screen.width-20,Math.floor(px.screen.height*0.05));true`);
 await sleep(600);await ev('__pxset.tap(__pxset.listRow(0).x,__pxset.listRow(0).y);true');await sleep(400);
 await sample('password-cursor','pass');await capture('password');
 await ev(`globalThis.__typeIndex=0;globalThis.__typeUpTimer=null;globalThis.__typeTimer=setInterval(()=>{const k=__pxset.key((__typeIndex++%2)?'bksp':'a');if(!k)throw new Error('missing typing key');__pxset.down(k.x,k.y);__typeUpTimer=setTimeout(()=>{__pxset.up(k.x,k.y);__typeUpTimer=null},70)},180);true`);
 try{await sample('password-typing','pass','按键事件注入：a与退格交替，每180ms一次，按下高亮保持70ms');}
 finally{await ev('clearInterval(__typeTimer);if(__typeUpTimer!==null)clearTimeout(__typeUpTimer);__pxset.up(0,0);true');}
 for(const mode of ['num','sym','abc','shift']){
  const key=await j(`__pxset.key('${mode}')`);if(!key)throw new Error(`键盘缺少${mode}键`);
  await ev(`__pxset.down(${key.x},${key.y});true`);await sleep(80);
  await ev(`__pxset.up(${key.x},${key.y});true`);await sleep(300);
  const expected={num:'num',sym:'sym',abc:'lower',shift:'upper'}[mode];
  if((await j('__pxset.state()')).kbMode!==expected)throw new Error(`键盘未切换到${expected}`);
  await sample(`password-mode-${mode}`,'pass');
 }
 await ev(`px.wifi.connect=()=>new Promise(resolve=>{globalThis.__finishConnect=resolve});
   for(let i=0;i<8;i++){const k=__pxset.key('a')||__pxset.key('A');if(k)__pxset.tap(k.x,k.y);}
   const ok=__pxset.key('ok');__pxset.tap(ok.x,ok.y);true`);
 if(!(await j('__pxset.state()')).connecting)throw new Error('未进入连接遮罩');
 await sample('connecting-overlay','pass','连接Promise延迟，用于持续显示遮罩；没有发起真实网络连接');
 await ev(`__finishConnect({connected:true,ssid:'FPS-Test',ip:'test'});true`);await sleep(250);
 await sample('connection-result-toast','wifi','合成连接完成状态；真实Wi-Fi仍为Finger');
 // 显式清空旧AP，否则页面保留列表，不能把零更新误报为扫描动画。
 await ev(`px.wifi.scan=()=>Promise.resolve([]);__pxset.tap(px.screen.width-20,Math.floor(px.screen.height*0.05));true`);
 await sleep(600);
 if((await j('__pxset.state()')).aps!==0)throw new Error('扫描动画场景未清空旧列表');
 await ev(`px.wifi.scan=()=>new Promise(resolve=>{globalThis.__finishScan=resolve});__pxset.tap(px.screen.width-20,Math.floor(px.screen.height*0.05));true`);
 await sample('wifi-pending-scan-animation','wifi','合成挂起扫描Promise，仅测扫描动画，不代表真实扫描耗时');
 await ev(`__finishScan([{ssid:'Open-FPS-Test',rssi:-30,secure:false}]);px.wifi.connect=()=>Promise.reject(new Error('test failure'));true`);
 await sleep(500);await ev('__pxset.tap(__pxset.listRow(0).x,__pxset.listRow(0).y);true');await sleep(200);
 await sample('open-network-connection-failure','wifi','合成开放AP连接拒绝，验证遮罩恢复；真实Wi-Fi保持连接');
 await capture('open-network-failure');
 await ev('__pxset.tap(20,Math.floor(px.screen.height*0.05));true');await sleep(500);
 await sample('restored-main','main');report.restored=true;
}catch(error){report.error=error.message;process.exitCode=1;console.error(error);}
finally{try{if(c&&!report.restored){await open();report.restored=true;}}catch(e){report.restoreError=e.message;}
 if(c){try{report.finalWifi=await j('px.wifi.status()');}catch{}}
 c?.close();report.finishedAt=new Date().toISOString();save();}
