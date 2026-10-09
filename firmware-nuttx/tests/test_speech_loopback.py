#!/usr/bin/env python3
"""真实 QuickJS/POSIX/WebSocket 的 Azure ASR 协议回环；麦克风使用合成 PCM。"""
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
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve()
    headers = library.parent / 'generated/quickjs-ng'
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
             '-fsanitize=undefined', '-fno-sanitize-recover=all', '-I' + str(project / 'include'), '-I' + str(headers)]
    with tempfile.TemporaryDirectory(prefix='pixelbox-speech-loopback-') as directory:
        build = Path(directory)
        binary, script, server_file = build / 'speech', build / 'speech.js', build / 'azure.cjs'
        server_file.write_text('const {WebSocketServer}=require(' + json.dumps(str(project.parent / 'sdk/node_modules/ws')) + ');\n' + r"""
const assert=require('node:assert/strict');
const server=new WebSocketServer({host:'127.0.0.1',port:0});let completed=0;
const expected=Buffer.alloc(35*640);
for(let i=0;i<20*320;++i)expected.writeInt16LE(3000+i%97,i*2);
const fields=text=>Object.fromEntries(text.trimEnd().split('\r\n').map(line=>{
  const colon=line.indexOf(':');assert(colon>0);return [line.slice(0,colon).toLowerCase(),line.slice(colon+1).trim()];
}));
server.on('connection',(ws,request)=>{
  const id=request.headers['x-connectionid'];let configured=false,wav=false,ended=false;const pcm=[];
  assert.match(id,/^[0-9a-f]{32}$/);
  assert.equal(request.headers['ocp-apim-subscription-key'],'loopback-only-test-key');
  assert(request.url.startsWith('/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&'));
  ws.on('error',()=>{});
  ws.on('message',(data,binary)=>{try{
    assert(!ended,'结束帧后仍有上行音频');
    if(!binary){
      assert(!configured&&!wav);const text=data.toString(),boundary=text.indexOf('\r\n\r\n');assert(boundary>0);
      const header=fields(text.slice(0,boundary));assert.equal(header.path,'speech.config');assert.equal(header['x-requestid'],id);
      assert.equal(JSON.parse(text.slice(boundary+4)).context.os.platform,'NuttX');configured=true;return;
    }
    assert(configured);assert(data.length>=2);
    // 独立解包大端长度前缀，旧的文本头封包会在此处失败。
    const length=data.readUInt16BE(0);assert(length>0&&length<=data.length-2);
    const text=data.subarray(2,2+length).toString();assert(text.endsWith('\r\n'));assert(!text.includes('\r\n\r\n'));
    const header=fields(text),body=data.subarray(2+length);
    assert.equal(header.path,'audio');assert.equal(header['x-requestid'],id);assert(Number.isFinite(Date.parse(header['x-timestamp'])));
    if(body.length){
      assert.equal(header['content-type'],'audio/x-wav');
      if(!wav){
        assert.equal(body.length,44);assert.equal(body.toString('ascii',0,4),'RIFF');assert.equal(body.toString('ascii',8,16),'WAVEfmt ');
        assert.equal(body.readUInt32LE(4),0);assert.equal(body.readUInt16LE(20),1);assert.equal(body.readUInt16LE(22),1);
        assert.equal(body.readUInt32LE(24),16000);assert.equal(body.readUInt16LE(34),16);assert.equal(body.toString('ascii',36,40),'data');
        assert.equal(body.readUInt32LE(40),0);wav=true;
      }else pcm.push(body);
      return;
    }
    assert(wav);assert.equal(header['content-type'],undefined);assert.deepEqual(Buffer.concat(pcm),expected);ended=true;++completed;
    const response=(path,body)=>'Path: '+path+'\r\nX-RequestId: '+id+'\r\n\r\n'+(body?JSON.stringify(body):'');
    ws.send(response('speech.hypothesis',{Text:'你好'}));
    ws.send(response('speech.phrase',{RecognitionStatus:'Success',DisplayText:'你好。'}));
    ws.send(response('turn.end'));
  }catch(error){console.error(error.stack);ws.close(1002,'invalid Azure ASR frame');}});
});
server.on('listening',()=>process.stdout.write(String(server.address().port)+'\n'));
process.on('SIGTERM',()=>{for(const client of server.clients)client.terminate();server.close(()=>process.exit(completed===2?0:1));});
""")
        # 复用原生网络 runner，输出只描述本测试实际执行的 ASR 场景。
        runner = (project / 'tests/test_ws_binding.c').read_text()
        old = 'WebSocket真实QuickJS回环通过：标准ws服务端互通、文本/二进制/分片/ping/关闭、16条64KiB背压、坏握手与VM退出'
        assert runner.count(old) == 1
        harness = build / 'runner.c'
        harness.write_text(runner.replace(old, 'ASR 真实 QuickJS/WebSocket 回环脚本执行完成').replace('WS测试未完成或失败', 'ASR测试未完成或失败'))
        sources = ['src/net.c', 'src/net_binding.c', 'src/tls.c', 'src/ws.c', 'src/ws_binding.c']
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags,
                        *[str(project / name) for name in sources], str(harness), str(library), '-lm', '-lpthread', '-o', str(binary)],
                       check=True, timeout=60)
        server = subprocess.Popen(['node', str(server_file)], stdout=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(server.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=5):
                    raise TimeoutError('本地 ASR 服务端启动超时')
                port = int(server.stdout.readline().strip())
            setup = r"""
globalThis.testComplete=false;globalThis.testError=undefined;
const timers=new Map();let timerId=0;
globalThis.setTimeout=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:0});return id;};
globalThis.setInterval=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:Math.max(1,delay)});return id;};
globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
globalThis.testTick=()=>{for(const [id,item] of [...timers])if(item.at<=Date.now()&&timers.has(id)){if(item.interval)item.at=Date.now()+item.interval;else timers.delete(id);item.fn();}};
globalThis.console={error(){}};globalThis.performance={now:()=>Date.now()};
globalThis.TextEncoder=class{encode(text){const raw=unescape(encodeURIComponent(String(text)));return Uint8Array.from(raw,ch=>ch.charCodeAt(0));}};
globalThis.TextDecoder=class{decode(input){const bytes=input instanceof Uint8Array?input:new Uint8Array(input);let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return decodeURIComponent(escape(raw));}};
globalThis.btoa=raw=>{const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let out='';for(let i=0;i<raw.length;i+=3){const n=(raw.charCodeAt(i)<<16)|((raw.charCodeAt(i+1)||0)<<8)|(raw.charCodeAt(i+2)||0);out+=chars[n>>>18]+chars[(n>>>12)&63]+(i+1<raw.length?chars[(n>>>6)&63]:'=')+(i+2<raw.length?chars[n&63]:'=');}return out;};
const g=globalThis,px={audio:{player:{}}},exitHandlers=new Set();
const unsupported=()=>{throw new Error('ENOTSUP');},rejected=()=>Promise.reject(new Error('ENOTSUP'));
const u8=value=>value instanceof Uint8Array?value:new Uint8Array(value);
const assert=(value,message='assertion failed')=>{if(!value)throw new Error(message);};
let micActive=false,frame=0;
Object.assign(native,{
  audioAvailable:()=>true,micAvailable:()=>true,micActive:()=>micActive,micBusy:()=>false,
  micStart(rate,ms){assert(rate===16000&&ms===10);micActive=true;},micStop(){micActive=false;},
  micPoll(){
    if(!micActive||frame>=35)return null;
    const data=new ArrayBuffer(640),view=new DataView(data);
    for(let i=0;i<320;++i)view.setInt16(i*2,frame<20?3000+(frame*320+i)%97:0,true);
    ++frame;return {data,sampleRate:16000};
  }
});
"""
            body = r"""
// 仅替换连接目的地；真实握手、二进制封包和网络队列仍走固件实现。
const connect=px.net.connectTcp;let connections=0;
px.net.connectTcp=options=>{
  assert(options.host==='eastasia.stt.speech.microsoft.com'&&options.port===443&&options.tls,'ASR destination');
  ++connections;return connect({host:'127.0.0.1',port:localPort,tls:false,timeoutMs:5000});
};
(async()=>{
  assert(px.speech.available());px.speech.configure({region:'eastasia',key:'loopback-only-test-key'});
  for(let turn=0;turn<2;++turn){
    frame=0;const partial=[];
    const result=await px.speech.recognize({maxMs:1000,silenceMs:300,timeoutMs:5000,onPartial:text=>partial.push(text)});
    assert(result==='你好。','final transcript');assert(partial.join('|')==='你好|你好。','partial transcript');
    assert(frame===35&&!micActive,'microphone release');
  }
  assert(connections===2);for(const callback of exitHandlers)callback();assert(timers.size===0,'VM timer leak');
})().then(()=>{globalThis.testComplete=true;},error=>{globalThis.testError=String(error)+'\n'+error.stack;globalThis.testComplete=true;});
"""
            fragments = ('audio', 'mic', 'net', 'http', 'ws', 'speech_transport', 'speech')
            script.write_text(setup + '\nconst localPort=' + str(port) + ';\n' +
                              '\n'.join((project / 'src' / f'prelude_{name}.js').read_text() for name in fragments) + body)
            subprocess.run([str(binary), str(script)], check=True, timeout=60)
        finally:
            server.terminate()
            server.wait(timeout=10)
        if server.returncode:
            raise RuntimeError('本地服务端未验证两次完整 ASR 请求')
        print('ASR 真实 QuickJS + POSIX/WebSocket 回环通过：两轮 WAV/22400 字节 PCM/结束帧/中文字幕/资源释放；未访问 Azure，麦克风为合成数据。')


if __name__ == '__main__':
    main()
