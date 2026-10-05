#!/usr/bin/env python3
"""真实 QuickJS/POSIX/RFC6455 与 Node 中继验证；音频 DMA 使用明确的驱动替身。"""
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
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    library = args.quickjs_library.resolve()
    headers = library.parent / 'generated/quickjs-ng'
    flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
             '-fsanitize=undefined', '-fno-sanitize-recover=all', '-I' + str(project / 'include'), '-I' + str(headers)]
    with tempfile.TemporaryDirectory(prefix='pixelbox-voice-loopback-') as directory:
        build = Path(directory)
        binary, script, server_file = build / 'voice', build / 'voice.js', build / 'relay.cjs'
        server_file.write_text('const {WebSocketServer}=require(' + json.dumps(str(project.parent / 'sdk/node_modules/ws')) + ');\n' + r"""
const server=new WebSocketServer({host:'127.0.0.1',port:0});let interrupted=0;
server.on('connection',ws=>{
  let session=false;ws.on('error',()=>{});
  ws.on('message',(data,binary)=>{
    if(binary)return;const message=JSON.parse(data);
    if(message.type==='session.start'){session=message.device==='px-789abc'&&message.sampleRate===16000;return;}
    if(message.type==='interrupt'){++interrupted;return;}
    if(message.type==='tts.request'){
      if(!session){ws.send(JSON.stringify({type:'error',message:'missing session.start'}));return;}
      if(message.text==='fail'){ws.send(JSON.stringify({type:'error',message:'controlled server failure'}));return;}
      if(message.text==='verify-interrupt'&&interrupted!==1){ws.send(JSON.stringify({type:'error',message:'relay did not receive interrupt'}));return;}
      ws.send(JSON.stringify({type:'tts.begin',sampleRate:16000}));
      if(message.text==='interrupt')return;
      for(let offset=0;offset<120000;offset+=8000){const bytes=Buffer.alloc(8000);for(let i=0;i<bytes.length;++i)bytes[i]=(offset+i)%251;ws.send(bytes);}
      ws.send(JSON.stringify({type:'tts.end'}));
    }
  });
});
server.on('listening',()=>process.stdout.write(String(server.address().port)+'\n'));
process.on('SIGTERM',()=>{for(const client of server.clients)client.terminate();server.close(()=>process.exit());});
""")
        # 复用通用 QuickJS runner，但不输出没有在本测试执行的 WS 场景清单。
        harness = build / 'runner.c'
        runner = (project / 'tests/test_ws_binding.c').read_text()
        old = 'WebSocket真实QuickJS回环通过：标准ws服务端互通、文本/二进制/分片/ping/关闭、16条64KiB背压、坏握手与VM退出'
        assert runner.count(old) == 1
        harness.write_text(runner.replace(old, 'voice 真实 QuickJS 回环脚本执行完成（音频 DMA 为替身）').replace('WS测试未完成或失败', 'voice测试未完成或失败'))
        sources = ['src/net.c', 'src/net_binding.c', 'src/tls.c', 'src/ws.c', 'src/ws_binding.c']
        subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), *flags,
                        *[str(project / name) for name in sources], str(harness), str(library), '-lm', '-lpthread', '-o', str(binary)],
                       check=True, timeout=60)
        server = subprocess.Popen(['node', str(server_file)], stdout=subprocess.PIPE, text=True)
        try:
            port = int(server.stdout.readline().strip())
            setup = r"""
globalThis.testComplete=false;globalThis.testError=undefined;
const timers=new Map();let timerId=0;
globalThis.setTimeout=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:0});return id;};
globalThis.setInterval=(fn,delay=0)=>{const id=++timerId;timers.set(id,{fn,at:Date.now()+delay,interval:Math.max(1,delay)});return id;};
globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
globalThis.testTick=()=>{for(const [id,item] of [...timers])if(item.at<=Date.now()&&timers.has(id)){if(item.interval)item.at=Date.now()+item.interval;else timers.delete(id);item.fn();}};
globalThis.console={error(){}};globalThis.performance={now:()=>Date.now()};
const LateEncoder=class{encode(text){const raw=unescape(encodeURIComponent(String(text)));return Uint8Array.from(raw,ch=>ch.charCodeAt(0));}};
const LateDecoder=class{decode(input){const bytes=input instanceof Uint8Array?input:new Uint8Array(input);let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return decodeURIComponent(escape(raw));}};
globalThis.btoa=raw=>{const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let out='';for(let i=0;i<raw.length;i+=3){const n=(raw.charCodeAt(i)<<16)|((raw.charCodeAt(i+1)||0)<<8)|(raw.charCodeAt(i+2)||0);out+=chars[n>>>18]+chars[(n>>>12)&63]+(i+1<raw.length?chars[(n>>>6)&63]:'=')+(i+2<raw.length?chars[n&63]:'=');}return out;};
const g=globalThis,px={audio:{player:{}},wifi:{status:()=>({mac:'12:34:56:78:9a:bc'})}},exitHandlers=new Set();
const unsupported=()=>{throw new Error('ENOTSUP');},rejected=()=>Promise.reject(new Error('ENOTSUP'));
const u8=value=>value instanceof Uint8Array?value:new Uint8Array(value);
const assert=(value,message='assertion failed')=>{if(!value)throw new Error(message);};
let job=null,jobId=0,received=0,drained=0,paused=0;const audioEvents=[];
Object.assign(native,{
  audioAvailable:()=>true,micAvailable:()=>true,micActive:()=>false,micBusy:()=>false,micStart(){},micStop(){},micPoll:()=>null,
  audioStreamOpen(rate,channels){if(job)throw new Error('EBUSY');assert(rate===16000&&channels===1);job={id:++jobId,bytes:0,eos:false};return job.id;},
  audioStreamFeed(id,bytes){assert(job&&job.id===id);if(job.bytes+bytes.length>65536)throw new Error('EAGAIN');for(const byte of bytes){assert(byte===received%251,'PCM order');++received;}job.bytes+=bytes.length;},
  audioStreamEnd(id){assert(job&&job.id===id);job.eos=true;},audioBuffered:id=>job&&job.id===id?job.bytes/32:0,
  audioPlaying:id=>!!job&&(!id||job.id===id),audioStop(id){if(job&&job.id===id){audioEvents.push({jobId:id,error:-125,code:'ECANCELED'});job=null;}},
  audioPoll:()=>audioEvents.shift()||null,audioShutdown(){job=null;}
});
"""
            body = r"""
globalThis.TextEncoder=LateEncoder;globalThis.TextDecoder=LateDecoder;
const driver=setInterval(()=>{
  if(!job)return;const count=Math.min(job.bytes,3200);job.bytes-=count;drained+=count;
  if(job.eos&&!job.bytes){audioEvents.push({jobId:job.id,error:0,code:''});job=null;}
},10);
(async()=>{
  assert(px.speech.available(),'speech fragment initialization');
  px.voice.configure({serverUrl:base});
  let phase='';px.voice.on('stateChange',value=>{phase=value;});
  await px.voice.say('PCM');assert(received===120000&&drained===120000,'promise resolved before drain');assert(phase==='idle');
  let failed=false;try{await px.voice.say('fail');}catch(error){failed=String(error).includes('controlled server failure');}assert(failed,'server error');
  let shouldInterrupt=true;
  const off=px.voice.on('stateChange',state=>{if(state==='speaking'&&shouldInterrupt){shouldInterrupt=false;px.voice.interrupt();}});
  let rejected=false;try{await px.voice.say('interrupt');}catch(error){rejected=String(error).includes('interrupted');}assert(rejected,'interrupt did not reject');off();
  received=drained=0;await px.voice.say('verify-interrupt');assert(received===120000&&drained===120000,'relay interruption or second playback');
  const pending=px.voice.say('cancel').then(()=>false,error=>String(error).includes('stopped'));
  px.voice.stop();assert(await pending,'cancel');
  clearInterval(driver);for(const callback of exitHandlers)callback();assert(timers.size===0,'VM timer leak');
})().then(()=>{globalThis.testComplete=true;},error=>{globalThis.testError=String(error)+'\n'+error.stack;globalThis.testComplete=true;});
"""
            fragments = ('audio', 'mic', 'net', 'http', 'ws', 'speech_transport', 'speech', 'voice')
            script.write_text(setup + '\nconst base=' + json.dumps(f'ws://127.0.0.1:{port}') + ';\n' +
                              '\n'.join((project / 'src' / f'prelude_{name}.js').read_text() for name in fragments) + body)
            subprocess.run([str(binary), str(script)], check=True, timeout=60)
            print('voice 真实 QuickJS + POSIX/WS + Node 中继通过；120000 字节有序背压/排空/取消，中继确认收到 interrupt 后第二次播放完成；音频 DMA 为替身。')
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__':
    main()
