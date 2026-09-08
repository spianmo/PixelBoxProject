import { CatMotion, clamp, prepareCat } from './model';
import { drawScene, fullscreenAt, pairingKeyAt } from './render';
import { layoutPoint } from './layout';
import { BufferedPcmPlayback } from './playback';
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
let accountEpoch = -1;
let clock = 0;
let tiltX = 0;
let tiltY = 0;
let targetX = 0;
let targetY = 0;
let shakeUntil = 0;
let battery = px.system.battery().level;
let lastMessageAt = 0;
let lastActivityAt = 0;
let connectTimer = 0;
let pendingTimer = 0;
let playback: BufferedPcmPlayback | null = null;
let playbackEnded = false;
let playbackTurnId: number | null = null;

function send(message: Record<string, unknown>): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(message)); }
    catch { closeConnection('手机连接已中断'); }
}

function stopMic(): void {
    micGeneration++;
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
    // 只有手机确认配对且账号有效时才采音；PCM 由手机执行唤醒词、STT、AI 和 TTS。
    send({ type: 'mic.start', sampleRate: SAMPLE_RATE, channels: 1, format: 'pcm_s16le', wakeWord: WAKE_WORD });
    if (!view.connected || !view.authenticated) return;
    const generation = ++micGeneration;
    const epoch = accountEpoch;
    try {
        px.audio.mic.start({
            sampleRate: SAMPLE_RATE,
            frameMs: 32,
            onData(pcm) {
                if (generation !== micGeneration || epoch !== accountEpoch || !micActive || !view.authenticated || view.muted || playback || socket?.readyState !== WebSocket.OPEN) return;
                view.level = rmsLevel(pcm);
                try { socket.send(pcm); }
                catch { closeConnection('语音传输中断'); }
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
    stopMic();
    stopPlayback();
    clearTimeout(connectTimer);
    clearTimeout(pendingTimer);
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
        accountEpoch = epoch;
    }
    applyMessage(view, message);
    if (message.type === 'hello.pending') {
        clearTimeout(connectTimer);
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => closeConnection('手机确认已超时，请重新配对'), 120000);
    } else if (message.type === 'hello.ok' || message.type === 'account.state') {
        clearTimeout(connectTimer);
        clearTimeout(pendingTimer);
        lastActivityAt = px.system.now();
        if (view.authenticated) {
            send({ type: 'account.ready', accountEpoch });
            startMic();
        }
    } else if (message.type === 'auth.required' || message.type === 'auth.revoked') {
        stopMic();
        stopPlayback();
    } else if (message.type === 'wake') {
        lastActivityAt = px.system.now();
    } else if (message.type === 'state') {
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
        if (!view.authenticated) {
            stopMic();
            clearTimeout(connectTimer);
            clearTimeout(pendingTimer);
            view.pairingCode = '';
        } else {
            stopPlayback();
            stopMic();
        }
    }
}

function pair(): void {
    if (!phone || view.pairingCode.length !== 6 || view.pairingPending) return;
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
        connection.binaryType = 'arraybuffer';
        connection.onopen = () => {
            if (socket !== connection) return;
            send({ type: 'hello', protocol: 1, deviceId: info.deviceId, name: 'Obeing PixelBox', wakeWord: WAKE_WORD, pairCode: view.pairingCode });
        };
        connection.onmessage = (event) => { if (socket === connection) onMessage(event.data); };
        connection.onclose = () => {
            if (socket !== connection) return;
            const loginRequired = view.state === 'login';
            const message = loginRequired ? '请在手机登录，等待同步账号' : view.errorText || '手机已断开，请重新配对';
            closeConnection(message);
            if (loginRequired) view.state = 'login';
        };
        connection.onerror = () => { if (socket === connection) closeConnection('无法连接手机'); };
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => closeConnection('连接超时，请检查手机'), 15000);
    } catch { closeConnection('无法创建手机连接'); }
}

async function discover(): Promise<void> {
    if (discovering || socket || phone || !running) return;
    if (!px.wifi.status().connected) { view.errorText = 'PixelBox 尚未连接 Wi-Fi'; return; }
    discovering = true;
    try {
        const found = await px.net.mdns.discover(SERVICE_TYPE, { timeoutMs: 3000 });
        if (!running || socket || phone) return;
        const candidate = found.find((item) => item.port > 0 && item.port < 65536 && Boolean(item.ip || item.host));
        if (!candidate) { view.errorText = ''; return; }
        phone = candidate;
        view.phoneName = candidate.name;
        view.state = 'pairing';
        view.errorText = '';
    } catch { view.errorText = '未发现手机，请检查同一 Wi-Fi'; }
    finally { discovering = false; }
}

function toggleMute(): void {
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
            closeConnection();
        } else if (event.y > 395) settings = false;
        return;
    }
    if (event.y >= 35 && event.y < 80) {
        if (event.x >= event.width - 52) { settings = true; return; }
        if (event.x >= event.width - 90) { view.theme = view.theme === 'dark' ? 'light' : 'dark'; px.storage.kv.set('ob.theme', view.theme); return; }
        if (event.x >= event.width - 132) { toggleMute(); return; }
    }
    if (view.state === 'pairing' || (view.state === 'error' && !view.authenticated && phone)) {
        if (view.pairingPending) { if (event.y > 370) closeConnection(); return; }
        const key = pairingKeyAt(event.x, event.y, event.width);
        if (key === 'back') view.pairingCode = view.pairingCode.slice(0, -1);
        else if (key === 'ok') pair();
        else if (key && view.pairingCode.length < 6) view.pairingCode += key;
        return;
    }
    if (view.authenticated) listen();
    else if (!view.connected) void discover();
});

px.input.onButton((event) => {
    if (event.id !== 'boot') return;
    if (event.type === 'click') listen();
    else if (event.type === 'doubleClick') toggleMute();
    else if (event.type === 'longPress') { fullscreen = false; settings = !settings; }
});

if (px.sensors.imu.available()) {
    px.sensors.imu.start({ rateHz: 50, onData(data) {
        if (Math.abs(data.ax + targetX) + Math.abs(data.ay - targetY) > 0.35) shakeUntil = px.system.now() + 180;
        targetX = clamp(-data.ax, -1, 1);
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
    drawScene(px.screen, view, { clock, tiltX, tiltY, battery, settings, fullscreen, shake: px.system.now() < shakeUntil ? 1 : 0,
        pose: motion.sample(view.state, clock, tiltX, tiltY, view.level) });
});

const discoverTimer = setInterval(() => { void discover(); }, 5000);
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
