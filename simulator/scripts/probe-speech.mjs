import WebSocket from 'ws';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const host = process.argv[2] || '192.168.31.100';
let code = 'JSON.stringify({speech:px.speech.available(),memory:px.system.memory()})';
if (process.argv.includes('--configure') || process.argv.includes('--wake')) {
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../examples/07-obeing-harness/src/project-config.ts', import.meta.url))],
        bundle: true, write: false, format: 'esm' });
    const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    const config = module.projectSpeechConfig();
    if (!config) throw new Error('Project speech configuration missing');
    code = `JSON.stringify((()=>{try{px.speech.configure(${JSON.stringify(config)});return {configured:true,memory:px.system.memory()}}catch(e){return {configured:false,name:e.name,message:e.message,memory:px.system.memory()}}})())`;
    if (process.argv.includes('--wake')) code = `(()=>{px.speech.configure(${JSON.stringify(config)});px.speech.wakeword.start({phrase:'你好小川',onWake:()=>console.log('SPEECH_PROBE_WAKE'),onError:()=>console.log('SPEECH_PROBE_ERROR')}).then(()=>{console.log('SPEECH_PROBE_READY');px.speech.wakeword.stop()},e=>console.log('SPEECH_PROBE_FAILED',e.message));return 'wake probe started'})()`;
}
const socket = new WebSocket(`ws://${host}:8765/devd`, { handshakeTimeout: 5000 });
const timer = setTimeout(() => { socket.terminate(); process.exitCode = 1; }, 8000);
socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'js.eval', params: {
    code,
} })));
socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id !== 1) return;
    // Never dump transport errors containing the evaluated source or subscription key.
    console.log(message.error ? 'Device evaluation failed' : JSON.stringify(message.result));
    clearTimeout(timer);
    socket.close();
});
socket.on('error', (error) => { console.error(error.message); clearTimeout(timer); process.exitCode = 1; });
