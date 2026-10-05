#!/usr/bin/env python3
"""真实现有DevdClient → WebSocket → 独立devd线程 → C邮箱/QuickJS/原子存储。"""
from pathlib import Path
import argparse
import json
import os
import shlex
import subprocess
import tempfile

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('quickjs_library',type=Path)
    parser.add_argument('--sanitize',choices=('undefined','address,undefined'));args=parser.parse_args()
    project=Path(__file__).resolve().parents[1];library=args.quickjs_library.resolve();headers=library.parent/'generated/quickjs-ng'
    flags=['-std=c11','-D_POSIX_C_SOURCE=200809L','-O1','-g','-Wall','-Wextra','-Werror','-I'+str(project/'include'),'-I'+str(headers)]
    if args.sanitize:flags+=['-fsanitize='+args.sanitize,'-fno-sanitize-recover=all']
    with tempfile.TemporaryDirectory(prefix='pixelbox-devd-') as temporary:
        build=Path(temporary);binary=build/'devd';script=build/'client.cjs';sdk=build/'sdk.cjs';root=build/'apps'
        sources=['src/devd.c','src/mdns.c','src/net.c','src/tls.c','src/ws.c','src/store.c','src/sha256.c','tests/test_devd.c']
        # 先固定污染消息尾部，验证真实 JSON 入口不依赖分配器残留内容。
        json_binary=build/'devd-json'
        json_sources=sources[1:-1]+['tests/test_devd_json.c']
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),*flags,*[str(project/path) for path in json_sources],str(library),'-lm','-lpthread','-o',str(json_binary)],check=True,timeout=60)
        subprocess.run([str(json_binary)],check=True,timeout=60)
        subprocess.run([*shlex.split(os.environ.get('CC','cc')),*flags,*[str(project/path) for path in sources],str(library),'-lm','-lpthread','-o',str(binary)],check=True,timeout=60)
        subprocess.run(['node','-e','require('+json.dumps(str(project.parent/'sdk/node_modules/esbuild'))+').buildSync('+json.dumps({
            'entryPoints':[str(project.parent/'sdk/src/devd.ts')],'bundle':True,'platform':'node','format':'cjs','outfile':str(sdk)})+')'],check=True,timeout=60)
        script.write_text('const {DevdClient}=require('+json.dumps(str(sdk))+');\nconst WebSocket=require('+json.dumps(str(project.parent/'sdk/node_modules/ws'))+');\n'+r"""
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const port=Number(process.argv[2]),root=process.argv[3],url=`ws://127.0.0.1:${port}/devd`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const connect=()=>DevdClient.connect('127.0.0.1',{port,connectTimeoutMs:1000});
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const manifest=version=>({id:'test.devd',name:'测试应用',version,entry:'main.js'});
const raw=()=>new Promise((resolve,reject)=>{const ws=new WebSocket(url,{perMessageDeflate:false});ws.once('open',()=>resolve(ws));ws.once('error',reject);});
const rawReply=(ws,send)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('raw response timeout')),3000);const listener=data=>{const parsed=JSON.parse(data);if('id'in parsed){ws.off('message',listener);clearTimeout(timer);resolve(parsed);}};ws.on('message',listener);send();});
(async()=>{
  const client=await connect(),events=[];client.onEvent((event,data)=>events.push({event,data}));
  const hello=await client.hello();assert.equal(hello.name,'fixture');assert.equal(hello.model,'host');assert.equal(hello.ip,'127.0.0.1');
  assert.equal(await client.evalJs('1+2'),'3');await assert.rejects(client.evalJs('throw new Error("expected")'),/expected/);
  const sub=await client.subscribeLogs();assert.equal(typeof sub.boot,'number');assert(sub.last_seq>=1);await delay(30);
  assert(events.some(item=>item.event==='log'&&item.data.msg==='fixture ready'));
  const bytes=Buffer.alloc(65537);for(let i=0;i<bytes.length;i++)bytes[i]=i&255;
  await client.pushApp(manifest('1.0.0'),[{path:'main.js',data:bytes},{path:'assets/empty',data:Buffer.alloc(0)}]);
  assert.deepEqual(fs.readFileSync(path.join(root,'current/main.js')),bytes);assert.equal(fs.statSync(path.join(root,'current/assets/empty')).size,0);
  assert.equal((await client.hello()).appVersion,'1.0.0');assert.equal(await client.evalJs('generation'),'2');
  await client.pushApp(manifest('2.0.0'),[{path:'main.js',data:Buffer.from('v2')}]);
  assert.equal(fs.readFileSync(path.join(root,'current/main.js'),'utf8'),'v2');assert.deepEqual(fs.readFileSync(path.join(root,'prev/main.js')),bytes);
  await assert.rejects(client.request('app.push_begin',{manifest:manifest('bad'),files:[{path:'../escape',size:0,sha256:sha(Buffer.alloc(0))}]}),error=>error.code===-32602);
  const bad=await client.request('app.push_begin',{manifest:manifest('bad'),files:[{path:'main.js',size:1,sha256:sha(Buffer.from('x'))}]});
  await client.request('app.push_chunk',{session:bad.session,path:'main.js',offset:0,dataB64:Buffer.from('y').toString('base64')});
  await assert.rejects(client.request('app.push_end',{session:bad.session}),/SHA-256/);assert.equal((await client.hello()).appVersion,'2.0.0');
  await assert.rejects(client.request('app.push_chunk',{session:bad.session,path:'main.js',offset:0,dataB64:'eB=='}),error=>error.code===409);
  const invalid=await client.request('app.push_begin',{manifest:manifest('invalid'),files:[{path:'main.js',size:1,sha256:sha(Buffer.from('x'))}]});
  await assert.rejects(client.request('app.push_chunk',{session:invalid.session,path:'main.js',offset:0,dataB64:'eB=='}),error=>error.code===-32602);
  await assert.rejects(client.request('app.push_end',{session:invalid.session}),error=>error.code===409);
  const other=await connect();await assert.rejects(other.request('app.push_end',{session:bad.session}),error=>error.code===409);other.close();
  await client.pushApp(manifest('3.0.0'),[{path:'main.js',data:Buffer.from('v3')}]);
  const currentGeneration=Number(await client.evalJs('generation'));await client.stopApp();await delay(10);
  await assert.rejects(client.evalJs('1'),/application stopped/);assert.equal((await client.hello()).appVersion,'3.0.0');
  await client.restartApp();await delay(10);assert.equal(Number(await client.evalJs('generation')),currentGeneration+1);
  await client.evalJs('log("live log")');await delay(20);const last=events.filter(item=>item.event==='log').at(-1);assert.equal(last.data.msg,'live log');
  await client.unsubscribeLogs();events.length=0;await client.evalJs('log("replay log")');await delay(20);assert(!events.some(item=>item.event==='log'));
  await client.subscribeLogs(last.data.seq);await delay(20);assert.equal(events.filter(item=>item.event==='log').length,1);assert.equal(events.find(item=>item.event==='log').data.msg,'replay log');
  // 一次回放100条必须等待TCP排空，不能塞满32条输出队列而误断开正常客户端。
  await client.unsubscribeLogs();await client.evalJs('for(let i=0;i<100;i++)log("burst "+i)');events.length=0;
  const replayed=await client.subscribeLogs();const replayDeadline=Date.now()+2500;
  while(!events.some(item=>item.event==='log'&&item.data.seq===replayed.last_seq)){
    assert(Date.now()<replayDeadline,'bounded log replay disconnected or stalled');await delay(10);
  }
  assert.equal(events.filter(item=>item.event==='log'&&/^burst /.test(item.data.msg)).length,100);
  assert.equal((await client.hello()).name,'fixture');
  const ws=await raw();let response=await rawReply(ws,()=>ws.send('{'));assert.equal(response.error.code,-32700);
  response=await rawReply(ws,()=>ws.send('['.repeat(3000)+'0'+']'.repeat(3000)));assert.equal(response.error.code,-32700);
  response=await rawReply(ws,()=>ws.send(JSON.stringify({id:10,method:'hello',params:{nested:Array.from({length:8000},()=>({a:1}))}})));assert.equal(response.error.code,-32700);
  response=await rawReply(ws,()=>ws.send(JSON.stringify({id:2,method:'unknown',params:{}})));assert.equal(response.error.code,-32601);
  response=await rawReply(ws,()=>{ws.send('{"id":3,"method":',{fin:false});ws.ping('during');ws.send('"hello","params":{}}',{fin:true});});assert.equal(response.result.name,'fixture');
  const pong=new Promise(resolve=>ws.once('pong',data=>{assert.equal(data.toString(),'ping');resolve();}));ws.ping('ping');await pong;
  const binaryClosed=new Promise(resolve=>ws.once('close',code=>{assert.equal(code,1003);resolve();}));ws.send(Buffer.from([1]));await binaryClosed;
  /* 已关闭连接上的迟到eval结果不能投递给新连接；服务仍独立响应hello。 */
  const old=await raw();old.send(JSON.stringify({id:99,method:'js.eval',params:{code:'const end=Date.now()+150;while(Date.now()<end){};"late"'}}));await delay(10);old.terminate();
  const fresh=await connect();assert.equal((await fresh.hello()).name,'fixture');await delay(180);assert.equal(await fresh.evalJs('4+5'),'9');fresh.close();
  /* 错误HTTP路径、重复key和无掩码客户端帧都应主动关闭。 */
  const badHttp=header=>new Promise((resolve,reject)=>{const socket=net.connect(port,'127.0.0.1',()=>socket.write(header));socket.on('error',()=>{});socket.on('data',()=>{});socket.on('close',resolve);setTimeout(()=>{socket.destroy();reject(new Error('invalid handshake retained'));},1500).unref();});
  await badHttp('GET /wrong HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await badHttp('GET /devd HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n');
  const malformed=await raw(),malformedClose=new Promise(resolve=>malformed.once('close',code=>{assert.equal(code,1002);resolve();}));malformed._socket.write(Buffer.from([0x81,1,65]));await malformedClose;
  const oversized=await raw(),oversizedClose=new Promise(resolve=>oversized.once('close',code=>{assert.equal(code,1009);resolve();}));oversized.send('x'.repeat(96*1024+1));await oversizedClose;
  await delay(20);const held=[];for(let i=0;i<3;i++)held.push(await connect());await assert.rejects(connect(),/连接/);for(const item of held)item.close();await delay(20);
  const abandoned=await connect();await abandoned.request('app.push_begin',{manifest:manifest('abandoned'),files:[{path:'main.js',size:1,sha256:sha(Buffer.from('z'))}]});abandoned.close();await delay(30);
  assert(!fs.existsSync(path.join(root,'staging')));assert.equal((await client.hello()).appVersion,'3.0.0');
  const recovery=await client.subscribeLogs();fs.writeFileSync(path.join(root,'test-boot.json'),JSON.stringify(recovery));
  assert.equal((await client.hello()).appVersion,'3.0.0');client.close();
  console.log('devd真实SDK通过：hello/eval/stop/restart、32KiB分块/空文件/SHA/路径、current-prev切换、日志回放、分片/ping/非法握手/迟到结果');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>setTimeout(()=>process.exit(process.exitCode||0),100));
""")
        process=subprocess.Popen([str(binary),str(root)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            port=process.stdout.readline().strip()
            if not port:raise RuntimeError('service failed: '+process.stderr.read())
            subprocess.run(['node',str(script),port,str(root)],check=True,timeout=60)
        finally:
            process.terminate()
            try:stdout,stderr=process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill();stdout,stderr=process.communicate();raise RuntimeError('devd stop timed out')
            if process.returncode:raise RuntimeError(f'devd exited {process.returncode}: {stdout}{stderr}')
        # 模拟掉电窗口：current已改名prev但新current还没出现，重启应恢复旧版本。
        (root/'current').rename(root/'simulated-interrupted-new-version')
        recovery=build/'recovery.cjs'
        recovery.write_text('const {DevdClient}=require('+json.dumps(str(sdk))+');\n'+r"""
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{const client=await DevdClient.connect('127.0.0.1',{port:Number(process.argv[2])});
  assert.equal((await client.hello()).appVersion,'2.0.0');
  assert.equal(fs.readFileSync(path.join(process.argv[3],'current/main.js'),'utf8'),'v2');
  const previous=JSON.parse(fs.readFileSync(path.join(process.argv[3],'test-boot.json'))),current=await client.subscribeLogs();
  assert.notEqual(current.boot,previous.boot);assert(current.last_seq<previous.last_seq);client.close();
  console.log('devd重启通过：prev恢复current、读取提交manifest、boot变化、日志序号重置');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>setTimeout(()=>process.exit(process.exitCode||0),100));
""")
        process=subprocess.Popen([str(binary),str(root)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            port=process.stdout.readline().strip()
            if not port:raise RuntimeError('service restart failed: '+process.stderr.read())
            subprocess.run(['node',str(recovery),port,str(root)],check=True,timeout=60)
        finally:
            process.terminate();stdout,stderr=process.communicate(timeout=10)
            if process.returncode:raise RuntimeError(f'devd restart exited {process.returncode}: {stdout}{stderr}')
if __name__=='__main__':main()
