#!/usr/bin/env node
/** 独占真机的滚动基准：可热推送候选设置页，也可验证固件内置设置页。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { DevdClient } from '../../sdk/dist/devd.js';
import { snapshotCode, metrics } from './device-fps-metrics.mjs';

const { values } = parseArgs({ options: {
  host: { type: 'string' }, output: { type: 'string' },
  source: { type: 'string' }, seconds: { type: 'string', default: '10' },
} });
const seconds = Number(values.seconds);
if (!values.host || !values.output || !Number.isFinite(seconds) || seconds < 2 || seconds > 60)
  throw new Error('--host IP --output NEW_FILE [--source settings_app.js] [--seconds 10]');
if (fs.existsSync(values.output)) throw new Error('结果文件已存在');
fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), seconds,
  method: '设备16ms定时器注入拖动；设备单调时钟统计有效提交；未经物理触摸采样', samples: [] };
let client;
const ev = code => client.evalJs(code, 15000);
const json = async code => JSON.parse(await ev(`JSON.stringify(${code})`));
try {
  client = await DevdClient.connect(values.host, { connectTimeoutMs: 15000 });
  if (values.source) {
    const data = fs.readFileSync(values.source);
    report.sourceSha256 = crypto.createHash('sha256').update(data).digest('hex');
    await client.pushApp({ id: 'com.pixelbox.tests.settings-fps', name: '设置页刷新率验证',
      version: '1.0.0', entry: 'main.js', assets: [], minFirmware: '0.1.0' }, [{ path: 'main.js', data }]);
  } else await client.openSettings();
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if (await ev('typeof __pxset') === 'object') {
        if (values.source) {
          const actual = await ev("Array.from(new Uint8Array(px.util.sha256(px.storage.fs.readBytes('/app/main.js'))),x=>x.toString(16).padStart(2,'0')).join('')");
          if (actual !== report.sourceSha256) { await sleep(250); continue; }
        }
        ready = true; break;
      }
    } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('设置页未就绪或源码摘要不匹配');
  await sleep(1000);
  // 只在诊断 VM 内替换扫描方法，保留原方法并在 finally 恢复。
  await ev(`globalThis.__scrollOriginalScan=px.wifi.scan;
    globalThis.__scrollProfile={};
    globalThis.__scrollOriginalDraw={};
    for(const key of ['drawImage','fillRect','drawText','fillRects','_drawImageRegions','_composeRows']) {
      if(typeof px.screen[key]!=='function')continue;
      __scrollOriginalDraw[key]=px.screen[key];
      px.screen[key]=function(...args) {
        const at=performance.now();
        try{return __scrollOriginalDraw[key].apply(this,args)}
        finally {const p=__scrollProfile[key]||(__scrollProfile[key]={calls:0,ms:0});p.calls++;p.ms+=performance.now()-at}
      };
    } true`);
  for (const page of ['main', 'wifi']) {
    if (page === 'wifi') {
      await ev(`px.wifi.scan=()=>Promise.resolve(Array.from({length:20},(_,i)=>({ssid:'FPS-Test-'+String(i+1).padStart(2,'0'),rssi:-30-i*2,secure:true})));
        __pxset.tap(__pxset.rows.wifi.x,__pxset.rows.wifi.y);true`);
      await sleep(1000);
    }
    const state = await json('__pxset.state()');
    if (state.page !== page || (page === 'wifi' && state.aps !== 20)) throw new Error('场景状态错误');
    const amplitude = page === 'main' ? state.mainMaxScroll : 240;
    await ev(`__pxset.down(100,360);__pxset.move(100,340);
      globalThis.__scrollAt=performance.now();globalThis.__scrollTimer=setInterval(()=>{
        const p=((performance.now()-__scrollAt)%1600)/800;
        __pxset.move(100,340-${amplitude}*(p<=1?p:2-p));
      },16);true`);
    await sleep(1200);
    await ev('__scrollProfile={};true');
    const before = JSON.parse(await ev(snapshotCode));
    await sleep(seconds * 1000);
    const after = JSON.parse(await ev(snapshotCode));
    const profile = await json('__scrollProfile');
    await ev('clearInterval(__scrollTimer);__pxset.up(100,340);true');
    const sample = { page, ...metrics(before, after), profile, before, after };
    report.samples.push(sample);
    console.log(JSON.stringify({ page, fps: sample.submittedFps, callbackFps: sample.callbackFps,
      conversionMs: sample.conversionMs, updateMs: sample.updateMs,
      transmittedPixels: sample.transmittedPixels, changedPixels: sample.changedPixels, profile }));
    await sleep(400);
  }
} catch (error) {
  report.error = error.message; process.exitCode = 1; console.error(error);
} finally {
  if (client) {
    try {
      await ev(`if(typeof __scrollTimer!=='undefined')clearInterval(__scrollTimer);
        if(typeof __pxset==='object')__pxset.up(100,340);
        if(typeof __scrollOriginalScan==='function')px.wifi.scan=__scrollOriginalScan;
        if(typeof __scrollOriginalDraw==='object')for(const k of Object.keys(__scrollOriginalDraw))px.screen[k]=__scrollOriginalDraw[k];
        if(typeof __pxset==='object'&&__pxset.state().page==='wifi')__pxset.tap(20,Math.floor(px.screen.height*0.05));true`);
      report.restored = true;
    } catch (e) { report.restoreError = e.message; }
    client.close();
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
}
