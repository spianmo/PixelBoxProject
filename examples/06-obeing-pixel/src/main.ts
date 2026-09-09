import { CatMotion, clamp, imuGlitch, prepareCat } from './model';
import { drawScene, fullscreenAt, pairingKeyAt } from './render';
import { layoutPoint } from './layout';
import { BufferedPcmPlayback } from './playback';
import { BufferedUplink } from './uplink';
import { loadPairing, parsePairing, savePairing } from './pairing';
import { applyMessage, disconnect, initialState, parseMessage, rmsLevel, SAMPLE_RATE, SERVICE_TYPE, WAKE_WORD } from './state';

const view = initialState();
view.theme = px.storage.kv.get('ob.theme') === 'light' ? 'light' : 'dark';
const info = px.system.info();
let socket: WebSocket | null = null;
let phone: PxMdnsService | null = null;
let discovering = false;
let running = true;
let settings = false;
let fullscreen = false;
const motion = new CatMotion();
let micActive = false;
let micGeneration = 0;
let recoveringMic = false;
let accountEpoch = -1;
let clock = 0;
let tiltX = 0;
let tiltY = 0;
let targetX = 0;
let targetY = 0;
let shake = 0;
let battery = px.system.battery().level;
let lastMessageAt = 0;
let lastActivityAt = 0;
let connectTimer = 0;
let uplink: BufferedUplink | null = null;
let savedPairing = loadPairing();
let reconnectPaused = false;
let reconnectAt = 0;
let reconnectDelay = 1000;
let audioDrawAt = 0;
let audioDrawCost = 0;
let playback: BufferedPcmPlayback | null = null;
let playbackEnded = false;
let playbackTurnId: number | null = null;
const AUDIO_RENDER_RESERVE_MS = 384;

function send(message: Record<string, unknown>): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    uplink?.control(message);
}

function stopMic(): void {
    micGeneration++;
    uplink?.clearAudio();
    if (!micActive) return;
    px.audio.mic.stop();
    micActive = false;
    view.level = 0;
}

function stopPlayback(): void {
    const oldPlayback = playback;
    playback = null;
    oldPlayback?.stop();
    playbackEnded = false;
    playbackTurnId = null;
}

function startMic(): void {
    if (micActive || !running || !view.connected || !view.authenticated || view.muted || playback) return;
    if (!info.capabilities.mic) {
        view.state = 'error';
        view.errorText = '此设备没有麦克风';
        return;
    }
    // 只有配对验证通过且手机账号有效时才采音；PCM 由手机执行唤醒词、STT、AI 和 TTS。
    send({ type: 'mic.start', sampleRate: SAMPLE_RATE, channels: 1, format: 'ima_adpcm', wakeWord: WAKE_WORD });
    if (!view.connected || !view.authenticated) return;
    const generation = ++micGeneration;
    const epoch = accountEpoch;
    try {
        px.audio.mic.start({
            sampleRate: SAMPLE_RATE,
            // 128ms 一包，原生 8 帧回调缓存可覆盖 1 秒调度抖动，避免三维重绘引发突发小包。
            frameMs: 128,
            onData(pcm) {
                if (generation !== micGeneration || epoch !== accountEpoch || !micActive || !view.authenticated || view.muted || playback || socket?.readyState !== WebSocket.OPEN) return;
                view.level = rmsLevel(pcm);
                uplink?.audio(px.audio.encodeImaAdpcm(pcm), pcm.byteLength);
            },
        });
        micActive = true;
    } catch {
        view.state = 'error';
        view.errorText = '麦克风启动失败';
        send({ type: 'mic.stop' });
    }
}

function closeConnection(message = ''): void {
    recoveringMic = false;
    stopMic();
    stopPlayback();
    clearTimeout(connectTimer);
    uplink?.close();
    uplink = null;
    if (savedPairing && !reconnectPaused) {
        reconnectAt = px.system.now() + reconnectDelay;
        reconnectDelay = Math.min(15000, reconnectDelay * 2);
    }
    const previous = socket;
    socket = null;
    if (previous) {
        previous.onclose = null;
        previous.onerror = null;
        previous.onmessage = null;
        try { previous.close(); } catch { /* 网络对象已失效时仍完成本地停麦与清理。 */ }
    }
    disconnect(view);
    accountEpoch = -1;
    view.errorText = message;
    view.pairingCode = '';
    phone = null;
    settings = false;
}

function onMessage(raw: string | ArrayBuffer): void {
    lastMessageAt = px.system.now();
    if (raw instanceof ArrayBuffer) {
        if (playback && view.authenticated && !view.muted && !playbackEnded) {
            if (raw.byteLength > 65536 || raw.byteLength % 2 !== 0) return;
            // 下行缓冲超限直接中止本轮，避免 ESP32 堆被网络突发耗尽。
            if (playback.buffered() > 6000) { stopPlayback(); send({ type: 'cancel' }); return; }
            playback.feed(raw);
            view.level = rmsLevel(raw);
        }
        return;
    }
    const message = parseMessage(raw);
    if (!message) return;
    if (message.type === 'hello.ok') {
        if (message.inputFormat !== 'ima_adpcm' || typeof px.audio.encodeImaAdpcm !== 'function') {
            reconnectPaused = true;
            closeConnection('请更新手机应用和 PixelBox 固件后重新连接');
            return;
        }
        const pair = parsePairing(message);
        if (!pair || (savedPairing && pair.phoneId !== savedPairing.phoneId)) {
            closeConnection('手机配对版本不受支持');
            return;
        }
        try { savePairing(pair); savedPairing = pair; }
        catch { closeConnection('无法保存配对，请重试'); return; }
        reconnectDelay = 1000;
    }
    if (message.type === 'hello.ok' || message.type === 'account.state') {
        if (message.type === 'account.state' && !view.connected) return;
        const epoch = message.accountEpoch;
        if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
            closeConnection('手机账号同步版本不受支持');
            return;
        }
        if (epoch <= accountEpoch) return;
        // 先废弃旧采音回调和播放，随后确认账号代数；手机按有序 ACK 隔离排队中的旧输入。
        stopMic();
        stopPlayback();
        recoveringMic = false;
        accountEpoch = epoch;
    }
    applyMessage(view, message);
    if (message.type === 'hello.ok' || message.type === 'account.state') {
        clearTimeout(connectTimer);
        lastActivityAt = px.system.now();
        if (view.authenticated) {
            send({ type: 'account.ready', accountEpoch });
            startMic();
        }
    } else if (message.type === 'auth.revoked') {
        savePairing(null);
        savedPairing = null;
        closeConnection('手机已取消配对，请输入新配对码');
    } else if (message.type === 'auth.required') {
        stopMic();
        stopPlayback();
    } else if (message.type === 'wake') {
        lastActivityAt = px.system.now();
    } else if (message.type === 'state') {
        // 拥堵恢复复用有序 mic.stop/mic.start；手机的中间 muted 回执不是用户静音。
        if (recoveringMic && message.state === 'muted') {
            view.state = 'error';
            view.errorText = '网络拥堵，正在恢复语音';
            return;
        }
        if (message.state === 'idle' || message.state === 'error') recoveringMic = false;
        if (message.state !== 'idle') lastActivityAt = px.system.now();
        if (message.state === 'idle') startMic();
        if (message.state === 'muted') { view.muted = true; stopMic(); stopPlayback(); }
        if (message.state === 'error') stopMic();
    } else if (message.type === 'audio.start' && view.authenticated) {
        stopMic();
        stopPlayback();
        if (view.muted) { send({ type: 'cancel' }); return; }
        const rate = Number(message.sampleRate);
        const turnId = Number(message.turnId);
        if (!Number.isSafeInteger(turnId) || turnId < 0 || message.format !== 'pcm_s16le' || message.channels !== 1 || ![16000, 22050, 24000, 44100, 48000].includes(rate)) {
            view.errorText = '手机音频格式不受支持';
            send({ type: 'cancel' });
            return;
        }
        try {
            const stream = new BufferedPcmPlayback(rate);
            playback = stream;
            playbackTurnId = turnId;
            view.state = 'speaking';
            stream.onEnded(() => {
                if (playback !== stream || playbackTurnId !== turnId) return;
                playback = null;
                playbackTurnId = null;
                playbackEnded = false;
                view.level = 0;
                send({ type: 'audio.played', turnId });
                // 轮次由手机收口；等待 state idle 后再恢复麦克风。
            });
        } catch {
            view.errorText = '扬声器启动失败';
            send({ type: 'cancel' });
        }
    } else if (message.type === 'audio.end') {
        if (playback && message.turnId === playbackTurnId) { playbackEnded = true; playback.end(); }
    } else if (message.type === 'audio.cancel') {
        if (message.turnId === playbackTurnId) { stopPlayback(); stopMic(); }
    } else if (message.type === 'error') {
        recoveringMic = false;
        if (!view.connected && message.code === 'pair_expired') {
            savePairing(null);
            savedPairing = null;
            closeConnection('配对已失效，请输入手机上的配对码');
            void discover();
            return;
        }
        if (!view.authenticated) {
            stopMic();
            clearTimeout(connectTimer);
            view.pairingCode = '';
        } else {
            stopPlayback();
            stopMic();
        }
    }
}

function pair(): void {
    if (!phone || (!savedPairing && view.pairingCode.length !== 6) || view.pairingPending) return;
    const address = phone.ip || phone.host;
    const url = `ws://${address.includes(':') ? `[${address}]` : address}:${phone.port}/pixelbox`;
    const oldSocket = socket;
    socket = null;
    if (oldSocket) { oldSocket.onclose = null; oldSocket.onerror = null; oldSocket.onmessage = null; oldSocket.close(); }
    view.errorText = '';
    view.pairingPending = true;
    try {
        const connection = new WebSocket(url);
        socket = connection;
        uplink?.close();
        uplink = new BufferedUplink((data) => {
            if (socket !== connection || connection.readyState !== WebSocket.OPEN) throw new Error('连接已关闭');
            connection.send(data);
        }, closeConnection, () => {
            stopMic();
            recoveringMic = true;
            view.state = 'error';
            view.errorText = '网络拥堵，正在恢复语音';
            // 本轮识别已不完整，通知手机清旧识别。等手机重新进入 idle 再恢复采音。
            send({ type: 'mic.stop' });
            send({ type: 'mic.start', sampleRate: SAMPLE_RATE, channels: 1, format: 'ima_adpcm', wakeWord: WAKE_WORD });
        });
        connection.binaryType = 'arraybuffer';
        connection.onopen = () => {
            if (socket !== connection) return;
            send({ type: 'hello', protocol: 1, deviceId: info.deviceId, name: 'Obeing PixelBox', wakeWord: WAKE_WORD,
                ...(savedPairing ? savedPairing : { pairCode: view.pairingCode }) });
        };
        connection.onmessage = (event) => { if (socket === connection) onMessage(event.data); };
        connection.onclose = () => {
            if (socket !== connection) return;
            const loginRequired = view.state === 'login';
            const message = loginRequired ? '请在手机登录，等待同步账号' : view.errorText || (savedPairing ? '手机已断开，正在自动重连' : '手机已断开，请重新配对');
            closeConnection(message);
            if (loginRequired) view.state = 'login';
        };
        connection.onerror = () => { if (socket === connection) closeConnection('无法连接手机'); };
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => closeConnection('连接超时，请检查手机'), 15000);
    } catch { closeConnection('无法创建手机连接'); }
}

async function discover(): Promise<void> {
    if (discovering || socket || phone || !running || reconnectPaused || px.system.now() < reconnectAt) return;
    if (!px.wifi.status().connected) { view.errorText = 'PixelBox 尚未连接 Wi-Fi'; return; }
    discovering = true;
    try {
        const found = await px.net.mdns.discover(SERVICE_TYPE, { timeoutMs: 3000 });
        if (!running || socket || phone || reconnectPaused) return;
        const candidate = found.find((item) => item.port > 0 && item.port < 65536 && Boolean(item.ip || item.host)
            && (!savedPairing || item.txt?.phoneId === savedPairing.phoneId));
        if (!candidate) { view.errorText = savedPairing ? '等待已配对手机上线' : ''; return; }
        phone = candidate;
        view.phoneName = candidate.name;
        view.state = 'pairing';
        view.errorText = '';
        if (savedPairing) pair();
    } catch { view.errorText = '未发现手机，请检查同一 Wi-Fi'; }
    finally { discovering = false; }
}

function toggleMute(): void {
    recoveringMic = false;
    view.muted = !view.muted;
    // 配对前切换静音偏好不能覆盖配对/等待页面，也不能向未授权连接发命令。
    if (!view.authenticated) return;
    if (view.muted) {
        send({ type: 'mic.stop' });
        send({ type: 'cancel' });
        stopMic();
        stopPlayback();
        view.state = 'muted';
    } else {
        view.state = view.authenticated ? 'idle' : 'offline';
        startMic();
    }
}

function listen(): void {
    if (!view.authenticated || view.muted) return;
    view.errorText = '';
    lastActivityAt = px.system.now();
    if (view.state === 'speaking' || view.state === 'thinking') send({ type: 'cancel' });
    stopPlayback();
    startMic();
    send({ type: 'listen' });
}

px.input.onTouch((touch) => {
    if (touch.type !== 'down') return;
    const event = layoutPoint(px.screen, touch.x, touch.y);
    lastActivityAt = px.system.now();
    if (fullscreenAt(event.x, event.y, event.width)) { fullscreen = !fullscreen; return; }
    if (fullscreen) { if (event.y >= 42) listen(); return; }
    if (settings) {
        if (event.y >= 338 && event.y <= 388) {
            reconnectPaused = true;
            closeConnection('已断开，点按屏幕重新连接');
        } else if (event.y > 395) settings = false;
        return;
    }
    if (event.y >= 35 && event.y < 80) {
        if (event.x >= event.width - 52) { settings = true; return; }
        if (event.x >= event.width - 90) { view.theme = view.theme === 'dark' ? 'light' : 'dark'; px.storage.kv.set('ob.theme', view.theme); return; }
        if (event.x >= event.width - 132) { toggleMute(); return; }
    }
    if (view.state === 'pairing' || (view.state === 'error' && !view.authenticated && phone)) {
        if (view.pairingPending) { if (event.y > 370) { reconnectPaused = true; closeConnection(); } return; }
        const key = pairingKeyAt(event.x, event.y, event.width);
        if (key === 'back') view.pairingCode = view.pairingCode.slice(0, -1);
        else if (key === 'ok') pair();
        else if (key && view.pairingCode.length < 6) view.pairingCode += key;
        return;
    }
    if (view.authenticated) listen();
    else if (!view.connected) { reconnectPaused = false; reconnectAt = 0; void discover(); }
});

px.input.onButton((event) => {
    if (event.id !== 'boot') return;
    if (event.type === 'click') listen();
    else if (event.type === 'doubleClick') toggleMute();
    else if (event.type === 'longPress') { fullscreen = false; settings = !settings; }
});

if (px.sensors.imu.available()) {
    px.sensors.imu.start({ rateHz: 50, onData(data) {
        // 保持已对调的左右方向；故障强度使用未钳制的 X/Y 原始加速度。
        shake = imuGlitch(data.ax, data.ay);
        targetX = clamp(data.ax, -1, 1);
        targetY = clamp(data.ay, -1, 1);
    } });
}

prepareCat();
px.screen.setFps(30);
px.screen.onFrame((dt) => {
    const step = Math.max(0, dt);
    clock += step;
    tiltX = targetX;
    tiltY = targetY;
    if (view.state === 'idle' && px.system.now() - lastActivityAt > 45000) view.state = 'sleep';
    // 三维绘制与 WebSocket 回调共用 JS 线程，真机单帧可超过 300ms。
    // 音频余量不足时让出整帧给收包，避免绘制持续拖慢 PCM 供给；网络收尾后正常绘制。
    if (playback && !playbackEnded && playback.buffered() < AUDIO_RENDER_RESERVE_MS) return;
    // 音频期间至少留出与上次绘制相等的空闲时间，给网络回调及原生屏幕提交让路。
    // 只看播放余量会连续绘制，屏幕提交的耗时也会推迟下一次收包。
    if ((micActive || (playback && !playbackEnded))
        && (uplink?.pendingAudio() || px.system.now() - audioDrawAt < Math.max(64, audioDrawCost))) return;
    const drawStarted = px.system.now();
    drawScene(px.screen, view, { clock, tiltX, tiltY, battery, settings, fullscreen, shake,
        pose: motion.sample(view.state, clock, tiltX, tiltY, view.level) });
    audioDrawAt = px.system.now();
    audioDrawCost = audioDrawAt - drawStarted;
});

const discoverTimer = setInterval(() => { void discover(); }, 1000);
const heartbeatTimer = setInterval(() => {
    battery = px.system.battery().level;
    if (view.connected && px.system.now() - lastMessageAt > 45000) { closeConnection('手机连接超时'); return; }
    if (view.connected) send({ type: 'ping' });
}, 10000);
px.app.onExit(() => {
    running = false;
    clearInterval(discoverTimer);
    clearInterval(heartbeatTimer);
    closeConnection();
    if (px.sensors.imu.available()) px.sensors.imu.stop();
});
void discover();
console.log('Obeing Pixel 语音助手已启动，唤醒词:', WAKE_WORD);
