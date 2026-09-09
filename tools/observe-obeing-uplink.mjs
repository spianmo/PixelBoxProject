/** 观测真实手机连接的上行背压，不改连接/账号，不保存 PCM 或识别内容。
 * node tools/observe-obeing-uplink.mjs <设备地址> [秒数，默认180] [--inject-congestion]
 */
import assert from 'node:assert/strict';
import { DevdClient } from '../sdk/dist/devd.js';
const [host, length = '180'] = process.argv.slice(2);
if (!host) throw new Error('需要设备地址');
const seconds = Math.max(15, Math.min(600, Number(length) || 180));
const client = await DevdClient.connect(host);
const read = code => client.evalJs(code, 8000);
try {
    if (process.argv.includes('--inject-congestion')) {
        await read(`(() => {
            if(!view.connected||!micActive||playback)throw new Error('仅可在已连接且空闲采音时注入');
            const previous=socket,sender=uplink,write=sender.write;
            sender.write=()=>{throw new Error('WebSocket 发送队列已满');};
            // 测试 PCM 只填本地队列，发送被拦截，超限时整批清除，不送给手机/云端。
            try{for(let i=0;i<16;i++)sender.audio(new ArrayBuffer(4096));}finally{sender.write=write;}
            globalThis.__uplinkRecoveryCheck=()=>socket===previous&&view.connected&&micActive&&!recoveringMic&&!view.errorText;
            return true;
        })()`);
        const recoveryDeadline = Date.now() + 15000;
        let recovered = false;
        do {
            await new Promise(resolve => setTimeout(resolve, 1000));
            recovered = await read('String(__uplinkRecoveryCheck())') === 'true';
        } while (!recovered && Date.now() < recoveryDeadline);
        assert.ok(recovered, '媒体拥堵后应在原 socket 恢复采音');
        console.log('主动注入媒体拥堵后，在同一手机连接恢复采音');
    }
    console.log(await read(`(() => {
        if (!view.connected || (!px.audio.mic.active && !recoveringMic)) throw new Error('需要已连接手机且正在采音或恢复采音');
        globalThis.__uplinkObserveRestore?.();
        const oldAudio=BufferedUplink.prototype.audio, oldFlush=BufferedUplink.prototype.flush, oldFail=BufferedUplink.prototype.fail, oldClose=closeConnection;
        const initialSocket=socket;
        const p=globalThis.__uplinkObserve={start:px.system.now(),frames:0,bytes:0,maxQueueBytes:0,busyFlushes:0,audioRecoveries:0,failures:[],disconnects:[]};
        closeConnection=function(reason) {
            if(p.disconnects.length<10)p.disconnects.push({afterMs:px.system.now()-p.start,reason});
            return oldClose(reason);
        };
        p.sameSocket=()=>socket===initialSocket;
        BufferedUplink.prototype.audio=function(pcm) {
            p.frames++;p.bytes+=pcm.byteLength;
            if(this.audioBytes+pcm.byteLength>64000)p.audioRecoveries++;
            const result=oldAudio.call(this,pcm);
            p.maxQueueBytes=Math.max(p.maxQueueBytes,this.audioBytes);
            return result;
        };
        BufferedUplink.prototype.flush=function() {
            const result=oldFlush.call(this);
            if(this.busySince!==null)p.busyFlushes++;
            return result;
        };
        BufferedUplink.prototype.fail=function(reason) {
            if(p.failures.length<10)p.failures.push({afterMs:px.system.now()-p.start,reason,bytes:this.audioBytes});
            return oldFail.call(this,reason);
        };
        let cleanupTimer=0;
        const restore=globalThis.__uplinkObserveRestore=()=>{
            clearTimeout(cleanupTimer);
            BufferedUplink.prototype.audio=oldAudio;BufferedUplink.prototype.flush=oldFlush;BufferedUplink.prototype.fail=oldFail;
            closeConnection=oldClose;
        };
        cleanupTimer=setTimeout(restore,${(seconds + 20) * 1000});
        return '开始观测真实手机连接的采音和发送队列';
    })()`));
    const deadline = Date.now() + seconds * 1000;
    let report;
    do {
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, deadline - Date.now())));
        report = JSON.parse(await read('JSON.stringify({...__uplinkObserve,sameSocket:__uplinkObserve.sameSocket(),elapsedMs:px.system.now()-__uplinkObserve.start,connected:view.connected,mic:px.audio.mic.active,queuedBytes:uplink?.audioBytes||0,runtime:__pxRuntimeStats()})'));
        console.log(JSON.stringify(report));
        assert.equal(report.failures.length, 0, '真实连接出现发送拥堵或传输失败');
        assert.equal(report.disconnects.length, 0, '真实手机连接发生断线');
        assert.ok(report.sameSocket, '观测期间不得靠重新连接掩盖中断');
        assert.ok(report.connected, '真实手机连接断开');
    } while (Date.now() < deadline);
    assert.ok(report.bytes > 0, '观测期必须存在真实采音');
} finally {
    try { await read('globalThis.__uplinkObserveRestore?.()'); } finally { client.close(); }
}
