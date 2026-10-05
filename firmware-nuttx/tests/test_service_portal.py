#!/usr/bin/env python3
"""真实 SDK/devd/QuickJS/HTTP 配网监督器集成；仅 mock AP/Wi-Fi/DHCP，不操作真机。"""
from pathlib import Path
import argparse
import json
import os
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]; library = args.quickjs_library.resolve()
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-DPX_SERVICE_PORTAL', '-DPX_PORTAL_HOST_TEST',
             '-DPX_PORTAL_BIND_ADDRESS="127.0.0.1"', '-DPX_PORTAL_SUCCESS_MS=300',
             '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-I' + str(project / 'include'),
             '-I' + str(library.parent / 'generated/quickjs-ng')]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    sources = ['src/service.c', 'src/devd.c', 'src/mdns.c', 'src/net.c', 'src/tls.c', 'src/ws.c',
               'src/store.c', 'src/sha256.c', 'tests/portal_instrumented.c', 'src/portal_binding.c', 'tests/test_service_portal.c']
    with tempfile.TemporaryDirectory(prefix='pixelbox-service-portal-') as directory:
        root = Path(directory); binary = root / 'test'; sdk = root / 'sdk.cjs'; script = root / 'client.cjs'
        apps = root / 'apps'; credentials = root / 'wifi.json'
        credentials.write_text('{"ssid":"Finger","password":"original-password"}')
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags, *[str(project / p) for p in sources],
                        str(library), '-lpthread', '-lm', '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary), str(apps), str(credentials), 'init-conflict'], check=True, timeout=60)
        subprocess.run(['node', '-e', 'require(' + json.dumps(str(project.parent / 'sdk/node_modules/esbuild')) + ').buildSync(' + json.dumps({
            'entryPoints': [str(project.parent / 'sdk/src/devd.ts')], 'bundle': True, 'platform': 'node', 'format': 'cjs', 'outfile': str(sdk)}) + ')'], check=True, timeout=60)
        script.write_text('const {DevdClient}=require(' + json.dumps(str(sdk)) + ');\nconst portalPrelude=' +
                          json.dumps((project / 'src/prelude_portal.js').read_text()) + ';\n' + r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),readline=require('node:readline'),http=require('node:http');
const [binary,root,credentials,mode]=process.argv.slice(2),old=fs.readFileSync(credentials,'utf8');
const child=spawn(binary,[root,credentials,...(mode?[mode]:[])],{stdio:['pipe','pipe','pipe']});
let stderr='',exited=false;child.stderr.on('data',data=>stderr+=data);
const lines=[],waiters=[];readline.createInterface({input:child.stdout}).on('line',line=>{
  const value=JSON.parse(line);if(waiters.length)waiters.shift().resolve(value);else lines.push(value);
});
const ended=new Promise(resolve=>child.on('exit',(code,signal)=>{exited=true;for(const waiter of waiters.splice(0))waiter.reject(new Error(`fixture exit ${code}/${signal}: ${stderr}`));resolve({code,signal});}));
const read=()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
const ask=async text=>{assert(!exited,stderr);child.stdin.write(text+'\n');return read();};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate,label,timeout=3000){
  const end=Date.now()+timeout;let status;
  while(Date.now()<end){status=await ask('status');if(predicate(status))return status;await delay(10);}
  throw new Error(label+': '+JSON.stringify(status));
}
const manifest=version=>({id:'test.portal',name:'门户监督',version,entry:'main.js'});
const source=version=>Buffer.from('globalThis.px={wifi:{}};'+portalPrelude+`globalThis.version=${JSON.stringify(version)};`);
function fetch(port,url,body){return new Promise((resolve,reject)=>{
  const request=http.request({host:'127.0.0.1',port,path:url,method:body===undefined?'GET':'POST',
    headers:body===undefined?{}:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)},timeout:3000},response=>{
      const chunks=[];response.on('data',data=>chunks.push(data));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString()}));
    });
  request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('HTTP timeout')));request.end(body);
});}
let client,control;
async function running(version,previous=0){
  const end=Date.now()+3000;
  while(Date.now()<end){try{
    if(await client.evalJs('version')===version){const next=Number(await client.evalJs('generation'));if(next>previous){assert.equal(await client.evalJs('activeCount()'),'1');return next;}}
  }catch{}await delay(10);}
  throw new Error('VM not running '+version+' after '+previous);
}
async function enter(expression='px.wifi.portal.start()'){
  await client.evalJs(expression).catch(error=>assert.match(error.message,/application stopping/));
  return wait(s=>s.phase==='waiting'&&s.owned&&s.serviceOwned&&!s.appPresent,'portal waiting');
}
(async()=>{
  const initial=await read();assert(initial.enabled&&initial.keyEnabled&&!initial.appPresent&&!initial.owned);
  assert.equal(initial.workerCreates,0);assert.equal(initial.workersUnjoined,0);
  const connect=()=>DevdClient.connect('127.0.0.1',{port:initial.devdPort,connectTimeoutMs:1000});
  client=await connect();control=await connect();const events=[];
  client.onEvent((event,data)=>events.push({event,data}));await client.subscribeLogs();
  await client.pushApp(manifest('1.0.0'),[{path:'main.js',data:source('v1')}]);
  let generation=await running('v1');assert.equal(generation,1);

  if(mode==='timeout'){
    // 使用 350 ms 配置加速同一超时分支；生产默认值仍为 180000 ms。
    let status=await enter();const disconnects=status.disconnects;
    generation=await running('v1',generation);status=await ask('status');
    assert(status.error<0&&!status.owned&&status.connected&&status.ssid==='Finger');
    assert.equal(status.disconnects,disconnects);assert.equal(fs.readFileSync(credentials,'utf8'),old);
    // 失败切网后无人操作，自动恢复原网络及原 VM。
    status=await enter();assert.equal((await fetch(status.port,'/connect','ssid=bad&pass=wrongpass')).status,200);
    await wait(s=>s.phase==='failed','failed connection before timeout');
    generation=await running('v1',generation);status=await ask('status');
    assert(status.connected&&status.ssid==='Finger'&&!status.owned);assert.equal(fs.readFileSync(credentials,'utf8'),old);
    // 正在连接时到期：取消/恢复尚未结束，不能提前启动下一代。
    await ask('connectms 1000');status=await enter();
    assert.equal((await fetch(status.port,'/connect','ssid=new&pass=new-password')).status,200);
    status=await wait(s=>s.phase==='stopping'&&s.error<0,'inflight connection timeout');
    assert(status.owned&&!status.appPresent&&status.generation===generation);
    assert.equal(fs.readFileSync(credentials,'utf8'),old);generation=await running('v1',generation);
    status=await ask('status');assert(status.connected&&status.ssid==='Finger'&&!status.owned);
    assert.equal(status.disconnects,disconnects+1);assert.equal(fs.readFileSync(credentials,'utf8'),old);
    await ask('connectms 80');
    // DHCP start 超时也只请求安全收尾；底层不返回时保留所有权，迟到成功后补 stop。
    const starts=status.dhcpStarts;await ask('holdstart 1');
    await client.evalJs('px.wifi.portal.start()').catch(error=>assert.match(error.message,/application stopping/));
    await wait(s=>s.dhcpStarts>starts,'held DHCP starts');
    status=await wait(s=>s.phase==='stopping'&&s.error<0,'DHCP session timeout');
    assert(status.owned&&status.supervising&&!status.appPresent);await delay(100);
    assert((await ask('status')).owned);assert.equal((await control.hello()).name,'service-portal-fixture');
    await ask('holdstart 0');generation=await running('v1',generation);
    assert.equal(fs.readFileSync(credentials,'utf8'),old);
    await ask('shutdown');await wait(s=>!s.supervising&&!s.owned,'timeout fixture shutdown');
    client.close();control.close();await ask('join');const exit=await ended;assert.equal(exit.code,0,stderr);assert.equal(stderr,'');
    console.log('service+portal超时通过：无人操作恢复VM且保持STA、失败/进行中切网恢复原凭据、迟到DHCP保留ownership后收尾');
    return;
  }

  // 内部栈不足时仍回收已创建线程，再恢复原VM；不让门户失败破坏远程入口。
  for(const nth of [1,2]){
    await ask('failcreate '+nth);
    await client.evalJs('px.wifi.portal.start()').catch(error=>assert.match(error.message,/application stopping/));
    generation=await running('v1',generation);
    const failed=await ask('status');
    assert(failed.error<0&&!failed.owned&&failed.appPresent&&failed.workersUnjoined===0);
    assert.equal(failed.apStarts,0);assert.equal((await control.hello()).name,'service-portal-fixture');
  }

  // 已 take 的请求在旧 VM 原生调用尚未退出时取消，不能迟到开启 AP。
  const held=client.evalJs('px.wifi.portal.start();hold(200)');const cancelled=assert.rejects(held,/application stopping/);
  let status=await wait(s=>s.pending&&s.appPresent&&!s.owned,'queued start');assert.equal(status.apStarts,0);
  await ask('stop');await cancelled;generation=await running('v1',generation);
  assert.equal((await ask('status')).apStarts,0);

  // 门户必须在整个 VM 清理完成后进入，HTTP/devd 继续响应，EVAL 明确已停止。
  status=await enter();assert.equal(status.applications,0);assert(status.keyActive);
  assert.equal((await control.hello()).name,'service-portal-fixture');
  await assert.rejects(client.evalJs('1'),/application stopped/);
  assert.equal((await fetch(status.port,'/')).status,200);
  assert.equal(JSON.parse((await fetch(status.port,'/status')).body).phase,'waiting');
  await ask('holdstop 1');await control.restartApp();
  status=await wait(s=>s.phase==='stopping'&&s.owned,'restart waits DHCP');
  assert.equal(status.generation,generation);assert.equal(status.applications,0);
  await delay(60);assert((await ask('status')).owned);await ask('holdstop 0');
  generation=await running('v1',generation);

  // STOP 撤销恢复意图，DHCP 收尾后仍保持停止。
  await enter();await ask('holdstop 1');await control.stopApp();
  await wait(s=>s.phase==='stopping'&&s.owned,'stop waits DHCP');await ask('holdstop 0');
  await wait(s=>!s.owned&&!s.appPresent,'stop remains idle');await delay(60);
  assert.equal((await ask('status')).generation,generation);
  await control.restartApp();generation=await running('v1',generation);

  // push 异步停止门户；DHCP/Wi-Fi收尾完成前不写staging，控制连接继续响应。
  await enter();await ask('holdstop 1');
  let pushed=false;
  const pushing=client.pushApp(manifest('2.0.0'),[{path:'main.js',data:source('v2')}]).then(()=>{pushed=true;});
  status=await wait(s=>s.phase==='stopping'&&s.owned,'push waits DHCP');assert.equal(status.generation,generation);
  assert(!pushed);assert(!fs.existsSync(path.join(root,'staging')));
  assert.equal(fs.readFileSync(path.join(root,'current/main.js'),'utf8'),source('v1').toString());
  assert.equal((await control.hello()).name,'service-portal-fixture');
  assert.equal(fs.readFileSync(credentials,'utf8'),old);await ask('holdstop 0');await pushing;
  generation=await running('v2',generation);

  // 扫描取消不 disconnect；尚未消费结果时禁止恢复下一代 VM。
  await ask('scanms 300');status=await enter();const scans=status.scans,disconnects=status.disconnects;
  const scan=fetch(status.port,'/scan').catch(()=>null);
  await wait(s=>s.scans>scans,'scan accepted');await control.restartApp();
  status=await wait(s=>s.phase==='stopping'&&s.owned,'scan cleanup');assert.equal(status.generation,generation);
  await delay(60);assert((await ask('status')).owned);await scan;generation=await running('v2',generation);
  assert.equal((await ask('status')).disconnects,disconnects);

  // DHCP stop 失败保留 ownership；后续远程动作可明确重试，不能伪报退出。
  await enter();await ask('failstop 1');await control.stopApp();
  status=await wait(s=>s.error<0&&s.owned,'DHCP stop error');assert.equal(status.applications,0);
  const stops=status.dhcpStops;await delay(60);assert.equal((await ask('status')).dhcpStops,stops);
  await ask('failstop 0');await control.restartApp();generation=await running('v2',generation);

  // 设置页进入门户，普通退出恢复设置；PWR 返回明确恢复用户应用。
  await client.evalJs('systemAction(1)').catch(error=>assert.match(error.message,/application stopping/));
  generation=await running('settings',generation);await enter('native.wifiPortal.start()');
  await ask('stop');generation=await running('settings',generation);assert.equal(await client.evalJs('settingsMode()'),'true');
  await enter('native.wifiPortal.start()');await ask('key 2');generation=await running('v2',generation);

  // 系统队列负 result 不得强行改成功；空闲也可由组合键进入，PWR 可返回。
  await control.stopApp();await wait(s=>!s.appPresent,'idle before key');
  const before=(await ask('status')).apStarts;await ask('key 5 -5');await delay(60);
  assert.equal((await ask('status')).apStarts,before);
  assert(events.some(item=>item.event==='log'&&/system key action 5 unavailable \(-5\)/.test(item.data.msg)));
  await ask('key 5');status=await wait(s=>s.phase==='waiting'&&s.keyActive,'system key provisioning');
  assert.equal(status.generation,generation);await ask('stop');await wait(s=>!s.owned,'idle portal finish');
  await delay(60);assert(!(await ask('status')).appPresent);
  assert.equal(events.filter(item=>item.event==='app.state').at(-1).data.state,'stopped');
  await ask('key 5');await wait(s=>s.phase==='waiting'&&s.keyActive,'idle portal return');
  await ask('key 2');generation=await running('v2',generation);

  // 门户成功后才落盘，自动退出也遵守 ownership 与 VM 单消费者边界。
  status=await enter();assert.equal((await fetch(status.port,'/connect','ssid=new&pass=new-password')).status,200);
  assert.equal(fs.readFileSync(credentials,'utf8'),old);
  await wait(s=>s.phase==='success','connection successful');
  assert.deepEqual(JSON.parse(fs.readFileSync(credentials,'utf8')),{ssid:'new',password:'new-password'});
  generation=await running('v2',generation);

  // 系统退出等待迟到 DHCP start 后补 stop；状态/devd 在阻塞期间仍响应。
  const started=(await ask('status')).dhcpStarts;await ask('holdstart 1');
  await client.evalJs('px.wifi.portal.start()').catch(error=>assert.match(error.message,/application stopping/));
  await wait(s=>s.dhcpStarts>started,'DHCP start held');await ask('shutdown');
  status=await wait(s=>s.owned&&s.supervising&&!s.appPresent,'shutdown waits portal');
  assert.equal((await control.hello()).name,'service-portal-fixture');assert.equal(status.applications,0);
  await delay(60);assert((await ask('status')).supervising);await ask('holdstart 0');
  status=await wait(s=>!s.supervising&&!s.owned&&!s.enabled,'shutdown completed');assert(!status.keyEnabled);
  client.close();control.close();await ask('join');const exit=await ended;assert.equal(exit.code,0,stderr);assert.equal(stderr,'');
  console.log('service+portal通过：真实SDK/QuickJS/HTTP、VM完全退出交接、排队取消、stop/restart/push、阻塞与失败重试、扫描保STA、设置恢复、系统键负错误、成功凭据、关闭回收');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  client?.close();control?.close();if(!exited)child.kill('SIGKILL');
});
''')
        subprocess.run(['node', str(script), str(binary), str(apps), str(credentials)], check=True, timeout=60)
        credentials.write_text('{"ssid":"Finger","password":"original-password"}')
        subprocess.run(['node', str(script), str(binary), str(root / 'timeout-apps'), str(credentials), 'timeout'], check=True, timeout=60)


if __name__ == '__main__':
    main()
