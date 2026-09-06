import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { DevdClient } from '../sdk/dist/devd.js';

const require = createRequire(new URL('../examples/package.json', import.meta.url));
const { build } = require('esbuild');
const mode = process.argv[2] || 'status';
const host = process.argv[3] || '192.168.31.100';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../examples/07-obeing-harness/src/project-config.ts', import.meta.url))], bundle: true, write: false, format: 'esm' });
const configModule = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const config = configModule.projectSpeechConfig();
const safe = value => String(value).split(config?.key || '\0').join('[redacted]');
const say = value => console.log(safe(typeof value === 'string' ? value : JSON.stringify(value)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function recognizeHost(audio) {
    const start = performance.now();
    const stt = await fetch(`https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&format=simple`, {
        method:'POST', headers:{'Ocp-Apim-Subscription-Key':config.key,'Content-Type':'audio/wav; codecs=audio/pcm; samplerate=16000'},body:audio,signal:AbortSignal.timeout(30000),
    });
    let result; const text=await stt.text();try{result=JSON.parse(text)}catch{result={bytes:text.length}}
    say({stage:'host-stt',status:stt.status,elapsedMs:performance.now()-start,result});
}

if (mode === 'azure-host') {
    if (!config) throw new Error('Speech configuration missing');
    say({ region: config.region, keyPresent: !!config.key });
    const started = performance.now();
    const response = await fetch(`https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': config.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm' },
        body: "<speak version='1.0' xml:lang='zh-CN'><voice name='zh-CN-XiaoxiaoNeural'>今天天气很好，我们一起去公园散步。</voice></speak>", signal: AbortSignal.timeout(30000),
    });
    const audio = Buffer.from(await response.arrayBuffer());
    say({ stage: 'host-tts', status: response.status, elapsedMs: performance.now() - started, bytes: audio.length });
    if (!response.ok) process.exitCode = 1;
    else {
        writeFileSync(fileURLToPath(new URL('../firmware/build/azure-test-speech.wav', import.meta.url)), audio);
        const start = performance.now();
        const stt = await fetch(`https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&format=simple`, {
            method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': config.key, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000' }, body: audio, signal: AbortSignal.timeout(30000),
        });
        const text = await stt.text();
        let result; try { result = JSON.parse(text); } catch { result = { bytes: text.length }; }
        say({ stage: 'host-stt', status: stt.status, elapsedMs: performance.now() - start, result });
    }
} else {
    const client = await DevdClient.connect(host);
    try {
        if (mode === 'restart') {
            await client.restartApp();
            await pause(3000);
            say(await client.evalJs('({memory:px.system.memory(),runtime:__pxRuntimeStats()})'));
        } else if (mode === 'cache-check') {
            const boot = await client.subscribeLogs(Number.MAX_SAFE_INTEGER);
            const before = JSON.parse(await client.evalJs('JSON.stringify(px.system.memory())'));
            await client.evalJs("globalThis.__cacheReady=false;px.speech.wakeword.start({phrase:'你好小川',onWake:()=>{}}).then(()=>__cacheReady=true,e=>__cacheReady=String(e));true");
            for (let i=0;i<15;i++) { await pause(1000); const state=await client.evalJs('__cacheReady'); if(state==='true')break; if(state!=='false'||i===14)throw Error('Wake failed: '+state); }
            await client.evalJs('px.speech.wakeword.stop();true');
            await pause(1000);
            const cached=JSON.parse(await client.evalJs('JSON.stringify(px.system.memory())'));
            say({stage:'model-cached',before,cached});
            let resumed = false;
            client.onEvent((event,data) => {
                if(event==='log' && data?.tag==='px.speech' && /wake prepare|recording captured|Azure upload/.test(data.msg || '')) resumed = true;
            });
            await pause(31000);
            say({stage:'waiting-for-cache-expiry',seconds:31});
            await pause(31000);
            const released=JSON.parse(await client.evalJs('JSON.stringify(px.system.memory())'));
            if(!resumed && released.psramFree < cached.psramFree + 2000000) throw Error('Idle model memory was not released');
            const after=await client.subscribeLogs(Number.MAX_SAFE_INTEGER);
            if(after.boot!==boot.boot)throw Error('Device restarted during cache check');
            say({stage:resumed?'cache-check-inconclusive-app-resumed-speech':'model-released',released,sameBoot:true});
        } else if (mode === 'status') {
            say(await client.evalJs('({memory:px.system.memory(),wifi:px.wifi.status(),now:px.system.now(),speech:px.speech.available(),runtime:__pxRuntimeStats()})'));
        } else if (mode === 'mic') {
            await client.evalJs(`px.speech.cancel();globalThis.__micProbe={samples:[],total:0};px.audio.mic.start({sampleRate:16000,frameMs:32,onData:b=>{if(__micProbe.total<128000){__micProbe.samples.push(b);__micProbe.total+=b.byteLength/2}}});true`);
            say('Microphone recording for 8 seconds');
            await pause(8000);
            await client.evalJs(`px.audio.mic.stop();globalThis.__micBytes=new Uint8Array(__micProbe.total*2);let at=0;for(const b of __micProbe.samples){__micBytes.set(new Uint8Array(b),at);at+=b.byteLength};true`);
            const size=Number(await client.evalJs('__micBytes.length'));
            const chunks=[];
            for(let at=0;at<size;at+=4096)chunks.push(Buffer.from(await client.evalJs(`px.util.b64encode(__micBytes.subarray(${at},${Math.min(size,at+4096)}))`),'base64'));
            const pcm=Buffer.concat(chunks), header=Buffer.alloc(44);
            header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
            const audio=Buffer.concat([header,pcm]);writeFileSync(fileURLToPath(new URL('../firmware/build/device-microphone.wav',import.meta.url)),audio);
            let sum=0,squares=0,peak=0,zeros=0;for(let i=0;i<pcm.length;i+=2){const n=pcm.readInt16LE(i);sum+=n;squares+=n*n;peak=Math.max(peak,Math.abs(n));if(!n)zeros++}
            say({samples:pcm.length/2,mean:sum/(pcm.length/2),rms:Math.sqrt(squares/(pcm.length/2)),peak,zeros});
            await recognizeHost(audio);
            await client.evalJs('delete globalThis.__micProbe;delete globalThis.__micBytes;true');
        } else if (mode === 'azure-device') {
            const audio=readFileSync(fileURLToPath(new URL('../firmware/build/azure-test-speech.wav',import.meta.url)));
            const address=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal&&i.address.startsWith(host.split('.').slice(0,3).join('.')+'.'))?.address;
            if(!address)throw Error('No matching LAN adapter');
            const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':audio.length});res.end(audio)});
            await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
            try {
                await client.evalJs(`globalThis.__speechProbe={pending:true,started:performance.now()};fetch('http://${address}:${server.address().port}/').then(r=>r.arrayBuffer()).then(b=>fetch('https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&format=simple',{method:'POST',headers:{'Ocp-Apim-Subscription-Key':${JSON.stringify(config.key)},'Content-Type':'audio/wav; codecs=audio/pcm; samplerate=16000'},body:b,timeoutMs:30000})).then(async r=>({status:r.status,body:await r.json()})).then(result=>Object.assign(__speechProbe,{pending:false,ms:performance.now()-__speechProbe.started,result}),e=>Object.assign(__speechProbe,{pending:false,error:String(e)}));true`);
                for(let i=0;i<45;i++){await pause(1000);const result=JSON.parse(await client.evalJs('JSON.stringify(__speechProbe)',30000));if(!result.pending){say(result);break}if(i===44)throw Error('Azure device probe timed out')}
            } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
        } else if (mode === 'logs') {
            client.onEvent((event, data) => {
                const serialized = JSON.stringify({event, data});
                if (/speech|TLS|HTTP|NTP|录音|语音|唤醒|model|esp-tls|mbedtls/i.test(serialized)) say(serialized);
            });
            await client.subscribeLogs();
            await pause(2000);
        } else {
            if (config) await client.evalJs(`px.speech.configure(${JSON.stringify(config)}); 'configured'`);
            const expression = mode === 'wake'
                ? `px.speech.wakeword.start({phrase:'你好小川',onWake:()=>{},onError:e=>{__speechProbe.runtimeError=String(e)}})`
                : mode === 'recognize' ? `px.speech.recognize({maxMs:8000,silenceMs:800,timeoutMs:30000,onLevel:n=>{__speechProbe.peak=Math.max(__speechProbe.peak,n)}})`
                : mode === 'tts' ? `px.speech.speak('今天天气很好，我们一起去公园散步。')`
                : `fetch('https://${config.region}.stt.speech.microsoft.com/',{timeoutMs:20000}).then(r=>({status:r.status}))`;
            const rounds = mode === 'wake' ? 2 : 1;
            for (let i=0;i<rounds;i++) {
                await client.evalJs(`globalThis.__speechProbe={started:performance.now(),pending:true,peak:0}; ${expression}.then(result=>Object.assign(__speechProbe,{pending:false,ms:performance.now()-__speechProbe.started,result}),error=>Object.assign(__speechProbe,{pending:false,ms:performance.now()-__speechProbe.started,error:String(error)})); 'started'`, 30000);
                say({ mode, round: i+1, started: true });
                for (let j=0;j<80;j++) {
                    await pause(1000);
                    const result = JSON.parse(await client.evalJs('JSON.stringify(__speechProbe)', 30000));
                    if (!result.pending) { say({ mode, round:i+1, ...result }); break; }
                    if (j%10===9) say({ mode, elapsedSeconds:j+1, pending:true, peak:result.peak });
                    if (j===79) throw new Error('Probe did not settle');
                }
                if (mode === 'wake') { await client.evalJs('px.speech.wakeword.stop(); true'); await pause(1000); }
            }
        }
    } catch (error) {
        say({ error: safe(error.message).slice(0,500) }); process.exitCode=1;
    } finally { client.close(); }
}
