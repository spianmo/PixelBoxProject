#!/usr/bin/env python3
"""现有SDK → pixelbox --serve → 实际runtime/prelude全链回归，不访问串口。"""
from pathlib import Path
import argparse
import json
import re
import selectors
import signal
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    binary = args.binary.resolve()
    with tempfile.TemporaryDirectory(prefix='pixelbox-service-runtime-') as temporary:
        build = Path(temporary)
        root = build / 'fallback'
        data = build / 'data'
        root.mkdir()
        data.mkdir()
        sdk = build / 'sdk.cjs'
        script = build / 'client.cjs'
        subprocess.run(['node', '-e', 'require(' + json.dumps(str(project.parent / 'sdk/node_modules/esbuild')) + ').buildSync(' + json.dumps({
            'entryPoints': [str(project.parent / 'sdk/src/devd.ts')], 'bundle': True,
            'platform': 'node', 'format': 'cjs', 'outfile': str(sdk)}) + ')'], check=True, timeout=60)
        script.write_text('const {DevdClient}=require(' + json.dumps(str(sdk)) + ');\n' + r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const port=Number(process.argv[2]),dataRoot=process.argv[3],fallbackRoot=process.argv[4],events=[],clients=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(){const client=await DevdClient.connect('127.0.0.1',{port,connectTimeoutMs:1000});clients.push(client);return client;}
const manifest=version=>({id:'test.runtime',name:'实际运行时测试',version,entry:'src/main.js'});
const source=version=>Buffer.from(`
globalThis.version=${JSON.stringify(version)};
globalThis.bootCount=Number(px.storage.kv.get('boots')||'0')+1;
px.storage.kv.set('boots',bootCount);
globalThis.previousExit=px.storage.kv.get('lastExit');
console.log('runtime-start '+version+' #'+bootCount);
px.app.onExit(()=>{px.storage.kv.set('lastExit',bootCount);console.log('runtime-exit '+version+' #'+bootCount);});
`);
async function running(client,version,after=0){
  const until=Date.now()+4000;
  let last='';
  while(Date.now()<until){
    try{if(await client.evalJs('version')===version){
      const count=version==='fallback'?1:Number(await client.evalJs('bootCount'));
      if(count>after)return count;
    }}catch(error){last=error.message;}
    await delay(15);
  }
  throw new Error('runtime failed to become ready: '+version+' '+last);
}
async function stopped(client){
  const until=Date.now()+4000;
  while(Date.now()<until){try{await client.evalJs('1');}catch(error){if(/application stopped/.test(error.message))return;}await delay(15);}
  throw new Error('runtime did not stop');
}
async function push(client,version,body=source(version)){
  await client.pushApp(manifest(version),[{path:'src/main.js',data:body},{path:'assets/message.txt',data:Buffer.from('asset '+version)}]);
}
(async()=>{
  const client=await connect(),control=await connect();
  client.onEvent((event,data)=>events.push({event,data}));
  assert.equal((await client.hello()).name,'PixelBox');
  await client.subscribeLogs();
  // 未安装main.js时仍保留内置welcome VM；不能把默认入口误当显式ENOENT而退出。
  const welcomeDeadline=Date.now()+4000;
  let welcome=false;
  while(Date.now()<welcomeDeadline){try{welcome=await client.evalJs('px.app.version')==='0.1.0';if(welcome)break;}catch{}await delay(15);}
  assert(welcome,'default missing main.js did not keep welcome VM alive');
  await delay(100);assert.equal(await client.evalJs('typeof px.system.info'),'function');
  assert(events.some(item=>item.event==='log'&&/PixelBox NuttX ready/.test(item.data.msg)));
  fs.writeFileSync(path.join(fallbackRoot,'main.js'),"globalThis.version='fallback';console.log('fallback ready');");
  await client.restartApp();
  await running(client,'fallback');
  // 没有timer的托管应用仍保持event loop，可持续接受SDK EVAL。
  await delay(100);assert.equal(await client.evalJs('1+2'),'3');
  await assert.rejects(client.evalJs('throw new Error("runtime eval failure")'),/runtime eval failure/);
  await assert.rejects(client.evalJs('"x".repeat(70000)'),/eval result unavailable/);
  assert.equal(await client.evalJs('6*7'),'42');
  // 单轮超时只拒绝本次调试代码；之后仍能接收调试与控制请求。
  await assert.rejects(client.evalJs('while(true){}'),/interrupted/);
  assert.equal(await client.evalJs('version'),'fallback');
  await push(client,'1.0.0');const first=await running(client,'1.0.0');assert.equal(first,1);
  assert.equal(await client.evalJs('px.app.version'),'1.0.0');
  assert.equal(await client.evalJs('px.app.readAssetText("message.txt")'),'asset 1.0.0');
  assert.equal((await client.hello()).appVersion,'1.0.0');
  await client.evalJs('globalThis.marker=41');await client.restartApp();
  const second=await running(client,'1.0.0',first);assert.equal(second,2);
  assert.equal(await client.evalJs('typeof marker'),'undefined');
  assert.equal(await client.evalJs('previousExit'),String(first));
  // 控制连接在另一个连接执行无限JS时仍能hello和stop；退出钩子获得独立期限。
  const infinite=assert.rejects(client.evalJs('while(true){}'),/application stopping/);
  await delay(30);assert.equal((await control.hello()).name,'PixelBox');
  await control.stopApp();await infinite;await stopped(client);
  await control.restartApp();const third=await running(client,'1.0.0',second);assert.equal(third,3);
  assert.equal(await client.evalJs('previousExit'),String(second));
  await push(client,'2.0.0');const fourth=await running(client,'2.0.0',third);assert.equal(fourth,4);
  assert.equal(await client.evalJs('previousExit'),String(third));
  assert.equal(fs.readFileSync(path.join(dataRoot,'apps/prev/src/main.js'),'utf8'),source('1.0.0').toString());
  await client.evalJs('console.log("runtime live log")');await delay(40);
  assert(events.some(item=>item.event==='log'&&item.data.msg==='runtime live log'));
  const starts=events.filter(item=>item.event==='log'&&/^runtime-start /.test(item.data.msg));
  assert.equal(starts.length,4);
  for(let i=1;i<starts.length;++i){
    const previous=starts[i-1].data.msg.replace('runtime-start','runtime-exit');
    const exit=events.findIndex(item=>item.event==='log'&&item.data.msg===previous);
    assert(exit>=0&&exit<events.indexOf(starts[i]),'new runtime started before previous exit hook');
  }
  // 实际入口抛错不能带走常驻devd；后续push恢复新VM。
  await push(client,'bad',Buffer.from('throw new Error("expected startup failure")'));
  await delay(100);await stopped(client);assert.equal((await control.hello()).appVersion,'bad');
  await push(client,'3.0.0');const fifth=await running(client,'3.0.0',fourth);assert.equal(fifth,5);
  assert.equal(await client.evalJs('previousExit'),String(fourth));
  await client.evalJs('px.app.exit()');await stopped(client);
  assert.equal((await control.hello()).name,'PixelBox');
  await control.restartApp();const sixth=await running(client,'3.0.0',fifth);assert.equal(sixth,6);
  assert.equal(await client.evalJs('previousExit'),String(fifth));
  await control.stopApp();await stopped(client);
  const saved=JSON.parse(fs.readFileSync(path.join(dataRoot,'.pixelbox-kv.json'),'utf8'));
  assert.equal(saved.boots,'6');assert.equal(saved.lastExit,'6');
  console.log('实际runtime SDK通过：缺省main.js的welcome保活、无timer保活、嵌套entry、manifest/asset、异常与超大EVAL、单轮超时、stop死循环、6代VM、onExit顺序、KV持久化、失败push恢复、自然退出后重启');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{for(const client of clients)client.close();setTimeout(()=>process.exit(process.exitCode||0),100);});
''')
        process = subprocess.Popen([str(binary), '--serve', '--port', '0', '--turn-timeout-ms', '400',
                                    '--app-root', str(root), '--data-root', str(data)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=10):
                raise RuntimeError('runtime service startup exceeded 10 seconds')
            line = process.stdout.readline().strip()
            selector.close()
            matched = re.fullmatch(r'\[pixelbox\] devd listening on port (\d+)', line)
            if not matched:
                raise RuntimeError('unexpected runtime startup output: ' + line)
            subprocess.run(['node', str(script), matched[1], str(data), str(root)], check=True, timeout=60)
        finally:
            # CLI尚无信号协作退出入口：应用已由SDK stop验证，这里只终止空闲宿主进程。
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate(timeout=10)
                raise RuntimeError('idle host process termination exceeded 10 seconds')
            if process.returncode != -signal.SIGTERM:
                raise RuntimeError(f'runtime service exited unexpectedly {process.returncode}: {stdout}{stderr}')
            print(stderr.strip())


if __name__ == '__main__':
    main()
