#!/usr/bin/env python3
"""真实SDK → devd → 常驻监督者 → 独立QuickJS线程的push/restart/stop/eval集成。"""
from pathlib import Path
import argparse
import json
import os
import selectors
import shlex
import subprocess
import tempfile

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('quickjs_library', type=Path)
    parser.add_argument('--sanitize', choices=('undefined', 'address,undefined'))
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve(); headers = library.parent / 'generated/quickjs-ng'
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-I' + str(project / 'include'), '-I' + str(headers)]
    if args.sanitize:
        flags += ['-fsanitize=' + args.sanitize, '-fno-sanitize-recover=all']
    with tempfile.TemporaryDirectory(prefix='pixelbox-service-') as temporary:
        build = Path(temporary); binary = build / 'service'; script = build / 'client.cjs'; sdk = build / 'sdk.cjs'; root = build / 'apps'
        sources = ['src/service.c', 'src/devd.c', 'src/mdns.c', 'src/net.c', 'src/tls.c', 'src/ws.c', 'src/store.c', 'src/sha256.c', 'tests/test_service.c']
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags, *[str(project / path) for path in sources], str(library), '-lm', '-lpthread', '-o', str(binary)], check=True, timeout=60)
        subprocess.run(['node', '-e', 'require(' + json.dumps(str(project.parent / 'sdk/node_modules/esbuild')) + ').buildSync(' + json.dumps({
            'entryPoints':[str(project.parent / 'sdk/src/devd.ts')], 'bundle':True, 'platform':'node', 'format':'cjs', 'outfile':str(sdk)}) + ')'], check=True, timeout=60)
        script.write_text('const {DevdClient}=require(' + json.dumps(str(sdk)) + ');\n' + r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const port=Number(process.argv[2]),root=process.argv[3];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const connect=()=>DevdClient.connect('127.0.0.1',{port,connectTimeoutMs:1000});
const manifest=version=>({id:'test.service',name:'监督测试',version,entry:'main.js'});
const source=version=>Buffer.from(`globalThis.version=${JSON.stringify(version)};log('loaded '+version);`);
async function running(client,version){
  const until=Date.now()+3000;
  while(Date.now()<until){try{if(await client.evalJs('version')===version){assert.equal(await client.evalJs('activeCount()'),'1');return Number(await client.evalJs('generation'));}}catch{}await delay(10);}
  throw new Error('application failed to become ready: '+version);
}
async function stopped(client){
  const until=Date.now()+3000;
  while(Date.now()<until){try{await client.evalJs('1');}catch(error){if(/application stopped/.test(error.message))return;}await delay(10);}
  throw new Error('application did not stop');
}
(async()=>{
  const client=await connect(),control=await connect(),events=[];
  client.onEvent((event,data)=>events.push({event,data}));
  assert.equal((await client.hello()).name,'service-fixture');
  assert.equal((await client.hello()).ip,'0.0.0.0');
  const networkDeadline=Date.now()+2500;
  while((await client.hello()).ip==='0.0.0.0'&&Date.now()<networkDeadline)await delay(30);
  const network=await client.hello();assert.equal(network.ip,'192.0.2.16');assert.equal(network.mac,'00:11:22:33:44:55');assert.equal(network.heapFree,32123);
  await assert.rejects(client.evalJs('1+1'),/application stopped/);
  await client.restartApp();await delay(20);await assert.rejects(client.evalJs('1'),/application stopped/);
  await client.subscribeLogs();
  await client.pushApp(manifest('1.0.0'),[{path:'main.js',data:source('v1')},{path:'assets/empty',data:Buffer.alloc(0)}]);
  const first=await running(client,'v1');assert.equal(first,1);
  assert.equal(await client.evalJs('1+2'),'3');await assert.rejects(client.evalJs('throw new Error("test failure")'),/test failure/);
  await client.evalJs('globalThis.marker=41');await client.restartApp();
  let second;
  const until=Date.now()+3000;
  do{await delay(10);second=await running(client,'v1');}while(second===first&&Date.now()<until);
  assert.equal(second,first+1);assert.equal(await client.evalJs('typeof marker'),'undefined');
  assert.equal(fs.statSync(path.join(root,'current/assets/empty')).size,0);
  // 纯JS死循环只能由所属VM的interrupt回调协作终止，devd控制连接持续可用。
  const infinite=client.evalJs('while(true){}');const interrupted=assert.rejects(infinite,/application stopping/);
  await delay(20);assert.equal((await control.hello()).name,'service-fixture');
  await control.stopApp();await interrupted;await stopped(client);
  await control.restartApp();const third=await running(client,'v1');assert.equal(third,second+1);
  // native暂时不可中断：RESTART→STOP合并为停止，旧VM清理前不能出现新VM。
  const hold=client.evalJs('hold(180);"old"');const cancelled=assert.rejects(hold,/application stopping/);
  await delay(20);await control.restartApp();await control.stopApp();await cancelled;await delay(220);await stopped(client);
  await control.restartApp();const fourth=await running(client,'v1');assert.equal(fourth,third+1);
  // 8个EVAL中的等待项也必须被停止清理，不能在下一代VM执行。
  const held=client.evalJs('hold(180);"held"');const heldRejected=assert.rejects(held,/application stopping/);
  await delay(15);
  const waiting=Array.from({length:6},(_,i)=>client.evalJs(`globalThis.leaked=${i};${i}`));
  const waitingRejected=waiting.map(promise=>assert.rejects(promise,/application stop/));
  await delay(15);await control.stopApp();await Promise.all([heldRejected,...waitingRejected]);await delay(200);await stopped(client);
  // 空闲监督者继续接收真实push，并从停止状态启动v2；current/prev内容可核对。
  await client.pushApp(manifest('2.0.0'),[{path:'main.js',data:source('v2')}]);
  const fifth=await running(client,'v2');assert.equal(fifth,fourth+1);
  assert.equal(await client.evalJs('typeof leaked'),'undefined');assert.equal(fs.readFileSync(path.join(root,'prev/main.js'),'utf8'),source('v1').toString());
  await client.evalJs('log("service live log")');await delay(20);
  assert(events.some(item=>item.event==='log'&&item.data.msg==='service live log'));
  assert(!events.some(item=>item.event==='log'&&item.data.msg==='foreign caller'));
  const starts=events.filter(item=>item.event==='log'&&/^app-start /.test(item.data.msg));
  assert(starts.length>=5);
  for(let index=1;index<starts.length;++index){
    const previous=Number(starts[index-1].data.msg.split(' ')[1]);
    const end=events.findIndex(item=>item.event==='log'&&item.data.msg===`app-end ${previous}`);
    assert(end>=0&&end<events.indexOf(starts[index]),'new VM started before previous cleanup');
  }
  // 应用启动失败也不能让常驻devd退出，下一次push可恢复。
  await client.pushApp(manifest('bad'),[{path:'main.js',data:Buffer.from('throw new Error("boot failure")')}]);
  await delay(80);await stopped(client);assert.equal((await control.hello()).appVersion,'bad');
  await client.pushApp(manifest('3.0.0'),[{path:'main.js',data:source('v3')}]);await running(client,'v3');
  // push必须先等旧VM的native/析构完全退出；等待期间devd保持响应且没有staging写入。
  const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
  const packageFor=(version,data=source('v3'))=>({manifest:manifest(version),files:[{path:'main.js',size:data.length,sha256:digest(data)}]});
  const beginPush=who=>who.request('app.push_begin',packageFor('pending'));
  const abortPush=(who,push)=>who.request('app.push_abort',{session:push.session});
  const currentPath=path.join(root,'current/main.js'),stagingPath=path.join(root,'staging');
  const kept=fs.readFileSync(currentPath,'utf8');
  const beforeInvalid=await running(client,'v3');
  const invalid=packageFor('invalid');invalid.files[0].path='../escape';
  await assert.rejects(client.request('app.push_begin',invalid),error=>error.code===-32602);
  assert.equal(await running(client,'v3'),beforeInvalid);assert(!fs.existsSync(stagingPath));
  async function holdForPush(marker){
    const pending=client.evalJs(`log(${JSON.stringify(marker)});hold(350);"late"`);
    const rejected=assert.rejects(pending,/application stopping/);
    const until=Date.now()+1000;
    while(!events.some(item=>item.event==='log'&&item.data.msg===marker)){
      assert(Date.now()<until,'native hold did not enter');await delay(2);
    }
    return {rejected};
  }
  const holding=await holdForPush('push hold entered');
  let began=false;
  const waitingPush=beginPush(control).then(value=>{began=true;return value;});
  const helloStart=Date.now();assert.equal((await control.hello()).name,'service-fixture');
  assert(Date.now()-helloStart<250,'pause blocked the control connection');
  await delay(50);assert(!began,'push began before native returned');assert(!fs.existsSync(stagingPath));
  const paused=await waitingPush;await holding.rejected;await stopped(client);
  assert(events.some(item=>item.event==='log'&&item.data.msg===`app-end ${beforeInvalid}`));
  assert(fs.existsSync(stagingPath));assert.equal(fs.readFileSync(currentPath,'utf8'),kept);
  await abortPush(control,paused);assert.equal(await running(client,'v3'),beforeInvalid+1);
  assert(!fs.existsSync(stagingPath));assert.equal(fs.readFileSync(currentPath,'utf8'),kept);
  // checksum失败和storage_begin失败都必须恢复旧应用，不能残留paused状态。
  const corrupt=await beginPush(control);
  await control.request('app.push_chunk',{session:corrupt.session,path:'main.js',offset:0,dataB64:Buffer.from('x').toString('base64')});
  await assert.rejects(control.request('app.push_end',{session:corrupt.session}),/SHA-256/);
  await running(client,'v3');assert(!fs.existsSync(stagingPath));assert.equal(fs.readFileSync(currentPath,'utf8'),kept);
  fs.mkdirSync(path.join(stagingPath,...Array(34).fill('deep')),{recursive:true});
  await assert.rejects(beginPush(control),/storage preparation failed/);
  await running(client,'v3');assert.equal(fs.readFileSync(currentPath,'utf8'),kept);
  fs.rmSync(stagingPath,{recursive:true});
  // STOP/RESTART意图在上传期间继续生效，abort不得擅自撤销STOP。
  const stopPaused=await beginPush(control);await control.stopApp();await abortPush(control,stopPaused);
  await delay(60);await stopped(client);await control.restartApp();await running(client,'v3');
  const restartPaused=await beginPush(control);await control.stopApp();await control.restartApp();
  await abortPush(control,restartPaused);await running(client,'v3');
  // 成功提交也服从最新STOP；显式restart之后才启动已提交的同版本应用。
  const commitStopped=await beginPush(control);await control.stopApp();
  await control.request('app.push_chunk',{session:commitStopped.session,path:'main.js',offset:0,dataB64:source('v3').toString('base64')});
  await control.request('app.push_end',{session:commitStopped.session});await delay(60);await stopped(client);
  await control.restartApp();await running(client,'v3');
  // owner在PREPARE期间断开：还没有任何磁盘修改，旧VM退出后仍能恢复。
  const abandoned=await connect(),abandonedHold=await holdForPush('abandoned push hold');
  const abandonedBegin=beginPush(abandoned).catch(()=>{});await delay(40);abandoned.close();await abandonedBegin;
  assert(!fs.existsSync(stagingPath));await abandonedHold.rejected;await running(client,'v3');
  assert(!fs.existsSync(stagingPath));assert.equal(fs.readFileSync(currentPath,'utf8'),kept);
  assert.equal((await client.hello()).appVersion,'pending');
  // 队列故障每轮都会返回；验证真实监督循环与日志订阅只记录状态变化。
  const queueLogs=items=>items.filter(item=>item.event==='log'&&item.data.tag==='keys'&&/^system key queue failed/.test(item.data.msg));
  async function queueState(state){
    const error=Number(await client.evalJs(`systemQueue(${JSON.stringify(state)})`));
    const until=Date.now()+1000;
    while(Number(await client.evalJs('systemQueue()'))<8){
      assert(Date.now()<until,'supervisor did not poll key queue');await delay(10);
    }
    // 持续订阅只需处理本次状态变化；同时确认控制请求仍然响应。
    await client.hello();return error;
  }
  const again=await queueState('again');
  assert.deepEqual(queueLogs(events).map(item=>item.data.msg),[`system key queue failed (${again})`]);
  const io=await queueState('io');
  assert.equal(queueLogs(events).length,2);
  await queueState('ok');await queueState('io');
  assert.deepEqual(queueLogs(events).map(item=>item.data.msg),[
    `system key queue failed (${again})`,`system key queue failed (${io})`,`system key queue failed (${io})`]);
  await queueState('absent');await queueState('unsupported');
  assert.equal(queueLogs(events).length,3);
  await queueState('again');assert.equal(queueLogs(events).length,4);
  // 故障不终止控制服务；新订阅回放与推送后也不能重新刷相同故障。
  const replay=await connect(),replayed=[];
  replay.onEvent((event,data)=>replayed.push({event,data}));
  const subscribed=await replay.subscribeLogs(),replayDeadline=Date.now()+1000;
  while(!replayed.some(item=>item.event==='log'&&item.data.seq===subscribed.last_seq)){
    assert(Date.now()<replayDeadline,'log replay did not reach advertised last_seq');await delay(10);
  }
  assert.deepEqual(queueLogs(replayed).map(item=>item.data.msg),queueLogs(events).map(item=>item.data.msg));
  await replay.pushApp(manifest('3.0.0'),[{path:'main.js',data:source('v3')}]);await running(client,'v3');
  await queueState('again');assert.equal(queueLogs(events).length,4);
  assert.equal((await replay.hello()).appVersion,'3.0.0');replay.close();await queueState('ok');
  // 断开的客户端及其迟到结果不影响新连接，最终fixture在仍运行应用时协作shutdown。
  const transient=await connect();const late=transient.evalJs('hold(80);"late"').catch(()=>{});await delay(10);transient.close();await late;
  const fresh=await connect();assert.equal((await fresh.hello()).name,'service-fixture');await delay(90);assert.equal(await fresh.evalJs('version'),'v3');fresh.close();
  // 系统按键只要求监督者切换VM，不覆盖已安装current，也不在后台线程直接执行JS。
  const installed=fs.readFileSync(path.join(root,'current/main.js'),'utf8');
  async function switchMode(action,version){
    const previous=Number(await client.evalJs('generation'));
    await client.evalJs(`systemAction(${action})`).catch(error=>{assert.match(error.message,/application stopping/);});
    const until=Date.now()+3000;
    while(Date.now()<until){const next=await running(client,version);if(next>previous)return next;await delay(10);}
    throw new Error('system action did not switch generation');
  }
  await switchMode(1,'settings');assert.equal(await client.evalJs('settingsMode()'),'true');
  assert.equal(fs.readFileSync(path.join(root,'current/main.js'),'utf8'),installed);
  assert.equal((await control.hello()).appVersion,'3.0.0');
  const settingsGeneration=Number(await client.evalJs('generation'));
  await client.evalJs('systemAction(4)');await delay(60);
  assert.equal(Number(await client.evalJs('generation')),settingsGeneration);
  assert(events.some(item=>item.event==='log'&&/system key action 4 unavailable/.test(item.data.msg)));
  await client.evalJs('systemAction(4)');await delay(60);
  assert.equal(events.filter(item=>item.event==='log'&&/system key action 4 unavailable/.test(item.data.msg)).length,2);
  await switchMode(1,'settings');assert.equal(await client.evalJs('settingsMode()'),'true');
  await switchMode(2,'v3');assert.equal(await client.evalJs('settingsMode()'),'false');
  await switchMode(1,'settings');await control.restartApp();await running(client,'v3');
  assert.equal(await client.evalJs('settingsMode()'),'false');
  control.close();client.close();
  console.log('service真实SDK通过：无app启动、异步push暂停/回收后写入/abort/SHA及存储失败恢复/提交服从STOP/暂停时断线、单VM重启、stop/死循环/阻塞native/排队EVAL取消、日志顺序、队列故障恢复/回放、设置切换');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>setTimeout(()=>process.exit(process.exitCode||0),100));
''')
        process = subprocess.Popen([str(binary), str(root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=10):
                raise RuntimeError('service startup exceeded 10 seconds')
            port = process.stdout.readline().strip(); selector.close()
            if not port:
                raise RuntimeError('service failed: ' + process.stderr.read())
            subprocess.run(['node', str(script), port, str(root)], check=True, timeout=60)
        finally:
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); stdout, stderr = process.communicate()
                raise RuntimeError('service cooperative shutdown exceeded 10 seconds')
            if process.returncode:
                raise RuntimeError(f'service exited {process.returncode}: {stdout}{stderr}')
            print(stderr.strip())

if __name__ == '__main__':
    main()
