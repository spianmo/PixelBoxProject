#!/usr/bin/env node
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const examples = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(examples, '06-obeing-pixel', 'src');
async function moduleAt(name) {
    const bundle = await build({ entryPoints: [join(source, name)], bundle: true, format: 'esm', target: 'es2020', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const model = await moduleAt('model.ts');
const state = await moduleAt('state.ts');
const render = await moduleAt('render.ts');
const main = await build({ entryPoints: [join(source, 'main.ts')], bundle: true, format: 'iife', target: 'es2020', write: false, logLevel: 'silent' });
let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`[OK] ${name}`);
}

await test('猫为有厚度的三维体素，外壳少于实体并保留双耳', () => {
    const volume = model.CAT_VOLUME;
    assert.equal(volume.length, 13);
    const filled = volume.flat(2).filter(Boolean).length;
    assert.ok(filled > 2500);
    assert.ok(model.CAT_SURFACE.length < filled / 2);
    assert.ok(volume[6][1][3] && volume[6][1][17]);
    assert.equal(volume[6][1][10], 0);
});
await test('IMU投影改变三维视角与深度，倾角钳制后不出主体区', () => {
    const poses = [-1, 0, 1].map((tilt) => model.poseFor('idle', 500, tilt, tilt, 0));
    const projections = poses.map((pose) => model.projectCat(pose, 7.8, 184, 170));
    assert.notDeepEqual(projections[0], projections[2]);
    for (const projection of projections) {
        for (let i = 0; i < projection.length; i++) {
            const point = projection[i];
            assert.ok(point.sx > 50 && point.sx < 320);
            assert.ok(point.sy > 55 && point.sy < 275);
            if (i) assert.ok(point.depth >= projection[i - 1].depth);
        }
    }
    assert.deepEqual(model.poseFor('idle', 500, Infinity, NaN, NaN), model.poseFor('idle', 500, 0, 0, 0));
});
await test('睡眠、异常、说话具有不同的三维面部表情', () => {
    const faces = ['idle', 'sleep', 'wake', 'speaking', 'error'].map((value) => model.facePoints(value, 1700, 85));
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) assert.notDeepEqual(faces[i], faces[j]);
    assert.ok(faces.every((face) => face.every((p) => p.z > 6)));
});
await test('唤醒词严格为你好小川，未登录和静音时不会唤醒', () => {
    const view = state.initialState();
    state.applyMessage(view, { type: 'wake', word: state.WAKE_WORD });
    assert.equal(view.state, 'offline');
    state.applyMessage(view, { type: 'hello.ok', authenticated: true, userDisplayName: '测试账号', enterpriseId: 'company' });
    state.applyMessage(view, { type: 'wake', word: '你好其他' });
    assert.equal(view.state, 'idle');
    state.applyMessage(view, { type: 'wake', word: '你好小川' });
    assert.equal(view.state, 'wake');
    view.muted = true;
    view.state = 'muted';
    state.applyMessage(view, { type: 'wake', word: '你好小川' });
    assert.equal(view.state, 'muted');
});
await test('新轮清除上轮字幕，累计全文去重，思考仅来自公开事件', () => {
    const view = state.initialState();
    state.applyMessage(view, { type: 'hello.ok', authenticated: true });
    state.applyMessage(view, { type: 'assistant.delta', text: '你好' });
    state.applyMessage(view, { type: 'assistant.delta', text: '你好，小川' });
    assert.equal(view.assistantText, '你好，小川');
    state.applyMessage(view, { type: 'thinking.status', text: '正在查询天气', phase: 'tool' });
    assert.equal(view.thinkingText, '正在查询天气');
    state.applyMessage(view, { type: 'state', state: 'listening' });
    assert.equal(view.assistantText, '');
    assert.equal(view.thinkingText, '');
    state.applyMessage(view, { type: 'user.text', text: '今天的天气' });
    state.applyMessage(view, { type: 'state', state: 'listening' });
    assert.equal(view.userText, '今天的天气');
});
await test('授权撤销清除绑定与对话，畸形和过长消息被拒绝', () => {
    const view = state.initialState();
    state.applyMessage(view, { type: 'hello.ok', authenticated: true, userDisplayName: 'name', enterpriseId: 'id' });
    state.applyMessage(view, { type: 'user.text', text: 'secret' });
    state.applyMessage(view, { type: 'auth.revoked' });
    assert.equal(view.authenticated, false);
    assert.equal(view.userText, '');
    assert.equal(view.displayName, '');
    assert.equal(view.enterpriseId, '');
    for (const value of ['null', '[]', '{}', 'oops', ' '.repeat(17000)]) assert.equal(state.parseMessage(value), null);
});
await test('账号推送仅作用于已确认配对，手机注销保留连接并清除所有身份字幕', () => {
    const view = state.initialState();
    const account = { type: 'account.state', authenticated: true, account: 'PHONE01', enterpriseId: 'company' };
    state.applyMessage(view, account);
    assert.equal(view.authenticated, false);
    assert.equal(view.state, 'offline');
    state.applyMessage(view, { type: 'hello.ok', authenticated: false });
    assert.equal(view.connected, true);
    assert.equal(view.state, 'login');
    state.applyMessage(view, account);
    assert.equal(view.displayName, 'PHONE01');
    state.applyMessage(view, { type: 'user.text', text: '旧问题' });
    state.applyMessage(view, { type: 'assistant.text', text: '旧回答' });
    state.applyMessage(view, { type: 'thinking.status', text: '旧任务' });
    state.applyMessage(view, { type: 'account.state', authenticated: false, userDisplayName: '不得显示', enterpriseId: '不得显示' });
    assert.equal(view.connected, true);
    assert.equal(view.authenticated, false);
    assert.equal(view.state, 'login');
    for (const key of ['displayName', 'enterpriseId', 'userText', 'assistantText', 'thinkingText']) assert.equal(view[key], '', key);
    state.applyMessage(view, account);
    assert.equal(view.authenticated, true);
    state.applyMessage(view, { type: 'auth.revoked' });
    state.applyMessage(view, account);
    assert.equal(view.connected, false);
    assert.equal(view.authenticated, false);
});
await test('网络断线清除账号与当前轮内容，保留主题和静音偏好', () => {
    const view = state.initialState();
    state.applyMessage(view, { type: 'hello.ok', authenticated: true, userDisplayName: '旧账号', enterpriseId: '旧企业' });
    state.applyMessage(view, { type: 'user.text', text: '旧问题' });
    state.applyMessage(view, { type: 'assistant.text', text: '旧回答' });
    state.applyMessage(view, { type: 'thinking.status', text: '旧任务状态' });
    view.theme = 'light';
    view.muted = true;
    state.disconnect(view);
    for (const key of ['displayName', 'enterpriseId', 'userText', 'assistantText', 'thinkingText']) assert.equal(view[key], '', key);
    assert.equal(view.theme, 'light');
    assert.equal(view.muted, true);
});
await test('PCM音量拒绝空帧和奇数字节，幅度钳制为0到100', () => {
    assert.equal(state.rmsLevel(new ArrayBuffer(0)), 0);
    assert.equal(state.rmsLevel(new ArrayBuffer(3)), 0);
    assert.equal(state.rmsLevel(new Int16Array([0, 0]).buffer), 0);
    assert.equal(state.rmsLevel(new Int16Array([32767, -32768]).buffer), 100);
});
await test('全状态浅暗主题文字和绘制坐标不超屏，绘制开销受控', () => {
    for (const width of [368, 320]) for (const theme of ['light', 'dark']) {
        for (const value of ['offline', 'pairing', 'login', 'idle', 'sleep', 'wake', 'listening', 'thinking', 'speaking', 'muted', 'error']) {
            const view = { ...state.initialState(), state: value, theme, authenticated: !['offline', 'pairing', 'login'].includes(value), connected: true, userText: '今天适合去公园散步吗？', assistantText: '今天天气晴朗，很适合散步，记得带水。', thinkingText: '天气查询已完成', displayName: 'name'.repeat(16), enterpriseId: 'company' };
            let rects = 0;
            const screen = {
                width, height: 448, clear() {},
                fillRect(x, y, w, h) { rects++; assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= 448, `${value} ${x},${y},${w},${h}`); },
                measureText(text) { return { width: Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 12 : 6), 0), height: 12 }; },
                drawText(text, x, y) { assert.ok(x >= 0 && y >= 0 && x + this.measureText(text).width <= width && y + 12 <= 448, `${value} ${text} ${x},${y}`); },
            };
            render.drawScene(screen, view, { clock: 1700, tiltX: 0.8, tiltY: -0.8, battery: 86, settings: false });
            assert.ok(rects < 850, `绘制次数 ${rects}`);
            render.drawScene(screen, view, { clock: 1700, tiltX: -0.8, tiltY: 0.8, battery: 86, settings: true });
        }
    }
});

function runtime(width = 368, height = 448) {
    let touch;
    let button;
    let exit;
    let frame;
    const screenText = [];
    let now = 1000;
    let micCallback;
    const micCallbacks = [];
    let micStarts = 0;
    let micStops = 0;
    let ended;
    let audioFeeds = 0;
    const sockets = [];
    const timers = new Map();
    const intervals = [];
    const sent = [];
    class Socket {
        static OPEN = 1;
        readyState = 1;
        constructor(url) { this.url = url; sockets.push(this); }
        send(raw) { sent.push(typeof raw === 'string' ? JSON.parse(raw) : raw); }
        close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    }
    const px = {
        system: { info: () => ({ deviceId: 'test-device', capabilities: { mic: true } }), battery: () => ({ level: 86 }), now: () => now },
        storage: { kv: { get: () => null, set() {} } },
        wifi: { status: () => ({ connected: true }) },
        net: { mdns: { discover: async () => [{ name: 'Obeing Pixel Phone', ip: '192.168.1.20', port: 18888 }] } },
        audio: {
            mic: { start(options) { micStarts++; micCallback = options.onData; micCallbacks.push(options.onData); }, stop() { micStops++; } },
            player: { openPcmStream: () => ({ feed() { audioFeeds++; }, stop() {}, buffered: () => 0, end() {}, onEnded(cb) { ended = cb; } }) },
        },
        sensors: { imu: { available: () => false } },
        screen: {
            width, height, setFps() {}, onFrame(cb) { frame = cb; },
            clear() { screenText.length = 0; }, fillRect() {},
            measureText: (text, style) => ({ width: text.length * 12 * (style?.scale || 1), height: 12 * (style?.scale || 1) }),
            drawText(text) { screenText.push(text); },
        },
        input: { onTouch(cb) { touch = cb; }, onButton(cb) { button = cb; } },
        app: { onExit(cb) { exit = cb; } },
    };
    runInNewContext(main.outputFiles[0].text, { px, console: { log() {} }, WebSocket: Socket, ArrayBuffer, Int16Array, setTimeout(cb) { const id = timers.size + 1; timers.set(id, cb); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval(cb) { intervals.push(cb); return intervals.length; }, clearInterval() {} });
    return {
        sent, sockets,
        get micStarts() { return micStarts; }, get micStops() { return micStops; }, get audioFeeds() { return audioFeeds; },
        touch(x, y) { touch({ type: 'down', x, y }); },
        button(type) { button({ id: 'boot', type }); },
        open() { sockets.at(-1).onopen(); },
        message(message) { sockets.at(-1).onmessage({ data: message instanceof ArrayBuffer ? message : JSON.stringify(message) }); },
        pcm() { micCallback(new Int16Array([100, -100]).buffer); },
        oldPcm(index) { micCallbacks[index](new Int16Array([100, -100]).buffer); },
        audioEnded() { ended(); },
        heartbeat() { intervals[1](); },
        frameText() { frame(16); return screenText.join('\n'); },
        advance(ms) { now += ms; },
        exit() { exit(); },
    };
}

async function pairedRuntime() {
    const r = runtime();
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 6; i++) r.touch(70, 250);
    r.touch(286, 400);
    r.open();
    return r;
}
await test('480真机坐标完成配对、打开连接页并断开', async () => {
    const r = runtime(480, 480);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 6; i++) r.touch(96, 265);
    r.touch(384, 413);
    r.open();
    assert.equal(r.sent[0].pairCode, '111111');
    r.message({ type: 'hello.ok', authenticated: false, accountEpoch: 1 });
    r.touch(447, 53);
    assert.ok(r.frameText().includes('断开手机连接'));
    r.touch(180, 381);
    assert.equal(r.sockets[0].readyState, 3);
    r.exit();
});
await test('真实入口仅在配对且手机同步有效账号后开启麦克风，hello不含账户密码', async () => {
    const r = await pairedRuntime();
    assert.equal(r.micStarts, 0);
    assert.deepEqual(r.sent[0], { type: 'hello', protocol: 1, deviceId: 'test-device', name: 'Obeing PixelBox', wakeWord: '你好小川', pairCode: '111111' });
    r.message({ type: 'hello.pending' });
    assert.equal(r.micStarts, 0);
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    assert.equal(r.micStarts, 1);
    r.pcm();
    assert.ok(r.sent.at(-1) instanceof ArrayBuffer);
    r.exit();
    assert.equal(r.micStops, 1);
});
await test('真实入口配对后等待手机登录，注销停音清字幕，重登不用重新配对', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'account.state', authenticated: true, accountEpoch: 1, userDisplayName: '未授权' });
    assert.equal(r.micStarts, 0);
    r.message({ type: 'hello.ok', authenticated: false, accountEpoch: 1 });
    assert.ok(r.frameText().includes('等待手机同步'));
    r.touch(184, 170); r.button('click');
    assert.equal(r.sockets[0].readyState, 1);
    assert.equal(r.micStarts, 0);
    r.message({ type: 'account.state', authenticated: true, accountEpoch: 2, userDisplayName: '手机账号一', enterpriseId: '企业一' });
    assert.equal(r.micStarts, 1);
    r.message({ type: 'user.text', text: '旧问题' });
    r.message({ type: 'assistant.text', text: '旧回答' });
    r.message({ type: 'thinking.status', text: '旧任务' });
    r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
    r.message({ type: 'account.state', authenticated: false, accountEpoch: 3 });
    r.audioEnded();
    const sent = r.sent.length;
    r.pcm();
    r.message(new Int16Array([100, 200]).buffer);
    assert.equal(r.sent.length, sent);
    assert.equal(r.audioFeeds, 0);
    assert.equal(r.micStops, 1);
    assert.equal(r.sockets[0].readyState, 1);
    assert.ok(r.frameText().includes('请在手机登录'));
    r.message({ type: 'account.state', authenticated: true, accountEpoch: 4, userDisplayName: '手机账号二', enterpriseId: '企业二' });
    assert.equal(r.micStarts, 2);
    assert.equal(r.sockets.length, 1);
    assert.equal(r.frameText().includes('手机账号二'), false);
    r.touch(340, 48);
    assert.ok(r.frameText().includes('手机账号二'));
    r.touch(184, 409);
    for (const secret of ['手机账号一', '企业一', '旧问题', '旧回答', '旧任务']) assert.equal(r.frameText().includes(secret), false, secret);
    assert.equal(r.sent.filter((message) => message.type === 'hello').length, 1);
    assert.deepEqual(r.sent.filter((message) => message.type === 'account.ready'), [
        { type: 'account.ready', accountEpoch: 2 }, { type: 'account.ready', accountEpoch: 4 },
    ]);
    r.exit();
});
await test('账号ACK先于采音，切账号后旧麦克风回调和重复旧快照不能发送输入', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'account.state', authenticated: true, accountEpoch: 7 });
    assert.equal(r.sent.some((message) => message.type === 'account.ready'), false);
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 7, userDisplayName: '旧账号' });
    assert.deepEqual(r.sent.slice(1, 3).map((message) => message.type), ['account.ready', 'mic.start']);
    assert.equal(r.sent[1].accountEpoch, 7);
    r.message({ type: 'account.state', authenticated: true, accountEpoch: 8, userDisplayName: '新账号' });
    assert.deepEqual(r.sent.slice(3, 5).map((message) => message.type), ['account.ready', 'mic.start']);
    assert.equal(r.sent[3].accountEpoch, 8);
    assert.equal(r.micStops, 1);
    assert.equal(r.micStarts, 2);
    const before = r.sent.length;
    r.oldPcm(0);
    assert.equal(r.sent.length, before, '新账号开始采音后，旧账号采音回调仍被丢弃');
    for (const epoch of [7, 8]) r.message({ type: 'account.state', authenticated: true, accountEpoch: epoch, userDisplayName: '过期账号' });
    assert.equal(r.sent.length, before);
    assert.equal(r.micStarts, 2);
    assert.equal(r.frameText().includes('新账号'), false);
    r.touch(340, 48);
    assert.ok(r.frameText().includes('新账号'));
    r.touch(184, 409);
    r.pcm();
    assert.ok(r.sent.at(-1) instanceof ArrayBuffer);
    r.exit();

    const muted = await pairedRuntime();
    muted.touch(252, 48);
    muted.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    assert.deepEqual(muted.sent.slice(1), [{ type: 'account.ready', accountEpoch: 1 }]);
    assert.equal(muted.micStarts, 0);
    muted.exit();
});
await test('缺失或非法账号代数关闭连接，不能绕过账号确认启动采音', async () => {
    for (const epoch of [undefined, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: epoch });
        assert.equal(r.micStarts, 0);
        assert.equal(r.sockets[0].readyState, 3);
        assert.equal(r.sent.some((message) => message.type === 'account.ready'), false);
        r.exit();
    }
});
await test('连接页仅断开手机，旧连接账号推送及撤权后推送无法重开麦', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1, userDisplayName: '旧账号' });
    const oldMessage = r.sockets[0].onmessage;
    r.touch(340, 48);
    const text = r.frameText();
    assert.ok(text.includes('断开手机连接'));
    assert.equal(text.includes('退出设备登录'), false);
    r.touch(184, 355);
    assert.equal(r.micStops, 1);
    assert.equal(r.sockets[0].readyState, 3);
    assert.equal(r.sent.some((message) => ['login', 'logout'].includes(message.type)), false);
    oldMessage({ data: JSON.stringify({ type: 'account.state', authenticated: true, accountEpoch: 2, userDisplayName: '旧账号' }) });
    assert.equal(r.micStarts, 1);
    r.exit();

    const revoked = await pairedRuntime();
    revoked.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    revoked.message({ type: 'auth.revoked' });
    revoked.message({ type: 'account.state', authenticated: true, accountEpoch: 2 });
    assert.equal(revoked.micStarts, 1);
    assert.equal(revoked.micStops, 1);
    revoked.exit();
});
await test('配对前切换静音仍能完成配对且保持禁止采音', async () => {
    const r = runtime();
    await new Promise((resolve) => setImmediate(resolve));
    r.touch(252, 48);
    assert.equal(r.sent.length, 0);
    for (let i = 0; i < 6; i++) r.touch(70, 250);
    r.touch(286, 400);
    r.open();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    assert.equal(r.micStarts, 0);
    r.touch(252, 48);
    assert.equal(r.micStarts, 1);
    r.exit();
});
await test('真实入口断线或撤权后换账号重配，首轮前屏幕不泄露旧对话', async () => {
    for (const revoke of [false, true]) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1, userDisplayName: '旧账号', enterpriseId: '旧企业' });
        r.message({ type: 'user.text', text: '旧问题' });
        r.message({ type: 'assistant.text', text: '旧回答' });
        r.message({ type: 'thinking.status', text: '旧任务状态' });
        assert.ok(r.frameText().includes('旧回答'));
        if (revoke) r.message({ type: 'auth.revoked' });
        r.sockets.at(-1).close();
        assert.equal(r.micStops, 1);
        r.touch(184, 170);
        await new Promise((resolve) => setImmediate(resolve));
        for (let i = 0; i < 6; i++) r.touch(70, 250);
        r.touch(286, 400);
        r.open();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1, userDisplayName: '新账号', enterpriseId: '新企业' });
        const text = r.frameText();
        assert.equal(text.includes('新账号'), false);
        r.touch(340, 48);
        assert.ok(r.frameText().includes('新账号'));
        for (const secret of ['旧账号', '旧企业', '旧问题', '旧回答', '旧任务状态']) assert.equal(text.includes(secret), false, secret);
        r.exit();
    }
});
await test('播报停止采音，audio.end不抢先恢复，实际播完回执后恢复', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
    assert.equal(r.micStops, 1);
    r.message(new Int16Array([100, 200]).buffer);
    assert.equal(r.audioFeeds, 1);
    r.message({ type: 'audio.end', turnId: 1 });
    assert.equal(r.micStarts, 1);
    r.audioEnded();
    assert.equal(r.micStarts, 1);
    assert.ok(r.sent.some((m) => m.type === 'audio.played' && m.turnId === 1));
    const count = r.sent.length;
    r.pcm();
    assert.equal(r.sent.length, count, '停麦后的迟到回调不得发送音频');
    r.message({ type: 'state', state: 'idle' });
    assert.equal(r.micStarts, 2);
    r.exit();
});
await test('audio.cancel丢弃旧播放，过期audio.end不确认新轮，等待idle才重开麦', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
    r.message({ type: 'audio.cancel', turnId: 1 });
    r.audioEnded();
    assert.equal(r.sent.filter((m) => m.type === 'audio.played').length, 0);
    assert.equal(r.micStarts, 1);
    r.message({ type: 'state', state: 'idle' });
    assert.equal(r.micStarts, 2);
    r.message({ type: 'audio.start', turnId: 2, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
    r.message({ type: 'audio.cancel', turnId: 1 });
    r.message({ type: 'audio.end', turnId: 1 });
    r.message(new Int16Array([100, 200]).buffer);
    assert.equal(r.audioFeeds, 1);
    r.message({ type: 'audio.end', turnId: 2 });
    r.audioEnded();
    assert.deepEqual(r.sent.filter((m) => m.type === 'audio.played'), [{ type: 'audio.played', turnId: 2 }]);
    r.exit();
});
await test('撤销授权、本地/远程静音与心跳超时立即停麦，断连PCM不再发送', async () => {
    for (const scenario of ['revoke', 'mute', 'remote-mute', 'timeout']) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
        if (scenario === 'revoke') r.message({ type: 'auth.revoked' });
        if (scenario === 'mute') r.touch(252, 48);
        if (scenario === 'remote-mute') r.message({ type: 'state', state: 'muted' });
        if (scenario === 'timeout') { r.advance(46000); r.heartbeat(); }
        assert.equal(r.micStops, 1, scenario);
        const previous = r.sent.length;
        r.pcm();
        assert.equal(r.sent.length, previous, scenario);
        if (scenario === 'remote-mute') { r.touch(252, 48); assert.equal(r.micStarts, 2); }
        r.exit();
    }
});
await test('待机随机轮换五种形态，语音打断过渡保持连续并在420ms内到位', () => {
    const motion = new model.CatMotion(() => 0);
    const shapes = new Set();
    let previous;
    for (let clock = 0; clock <= 25000; clock += 100) {
        const pose = motion.sample('idle', clock, 0, 0, 0);
        shapes.add(pose.shape);
        if (pose.weights) assert.ok(Math.abs(pose.weights.reduce((sum, n) => sum + n, 0) - 1) < 1e-6);
        previous = pose;
    }
    assert.equal(shapes.size, 5);
    const point = { x: -5, y: -7, z: 6, material: 1 };
    const before = model.posedShapePoint(point, previous);
    let pose = motion.sample('listening', 25000, 0, 0, 0);
    assert.deepEqual(model.posedShapePoint(point, pose), before);
    pose = motion.sample('listening', 25180, 0, 0, 0);
    const middle = model.posedShapePoint(point, pose);
    pose = motion.sample('thinking', 25180, 0, 0, 0);
    assert.deepEqual(model.posedShapePoint(point, pose), middle);
    pose = motion.sample('thinking', 25600, 0, 0, 0);
    assert.equal(pose.weights, undefined); assert.equal(pose.shape, 'think');
    motion.sample('speaking', 26000, 0, 0, 60);
    const neutral = motion.sample('speaking', 26100, 0, 0, 60);
    const tilted = motion.sample('speaking', 26100, 1, -1, 60);
    assert.ok(Math.abs(tilted.yaw - neutral.yaw - 0.9) < 1e-8, 'IMU bypasses in-progress morph');
    assert.ok(Math.abs(tilted.pitch - neutral.pitch + 0.4) < 1e-8);
    const signatures = ['idle', 'listening', 'thinking', 'speaking', 'sleep'].map(state =>
        JSON.stringify(model.projectCat(model.poseFor(state, 1700, 0, 0, 55), 9, 184, 190).map(p => [p.sx, p.sy])));
    assert.equal(new Set(signatures).size, signatures.length);
});
await test('全屏放大主体、只保留字幕，全部形态与极限倾角不侵入文字和按钮区', () => {
    for (const width of [320, 368, 480]) for (const fullscreen of [false, true]) for (const shape of model.CAT_SHAPES) for (const tilt of [-1, 0, 1]) {
        const height = width === 480 ? 480 : 448;
        const boxes = [], texts = [];
        const screen = { width, height, clear() {},
            fillRect(x, y, w, h, color) { assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height); if (color === 0xffffff) boxes.push({ x, y, w, h }); },
            measureText(value, style) { return { width: Array.from(value).length * 8 * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
            drawText(value, x, y, style) { texts.push({ value, x, y, ...this.measureText(value, style) }); } };
        const view = { ...state.initialState(), state: 'idle', connected: true, authenticated: true, displayName: 'HIDDEN_ACCOUNT', userText: '问题', assistantText: '回答'.repeat(40) };
        const pose = { ...model.poseFor('idle', 1700, tilt, -tilt, 50, shape), shape };
        render.drawScene(screen, view, { clock: 1700, tiltX: tilt, tiltY: -tilt, battery: 86, settings: false, fullscreen, pose });
        const captionY = Math.min(...texts.filter(t => t.value !== 'OBEING PIXEL' && t.value !== '86%' && t.value !== '你好小川').map(t => t.y));
        for (const box of boxes) assert.ok(box.y >= (fullscreen ? 41 : 80) && box.y + box.h < captionY - 15, `${width} ${shape} ${tilt}: ${JSON.stringify(box)}`);
        assert.equal(texts.some(t => t.value.includes('HIDDEN_ACCOUNT')), false);
        if (fullscreen) assert.ok(texts.every(t => t.y >= height - 110));
        if (shape === 'idle' && tilt === 0) {
            let pixels = 0;
            render.drawCat({ ...screen, fillRect(x, y, w, h, color) { if (color === 0xffffff) pixels += w * h; } }, view,
                { clock: 1700, tiltX: 0, tiltY: 0, battery: 86, settings: false }, 170, Math.min(7.8, (width - 116) / 29));
            assert.ok(boxes.reduce((n, b) => n + b.w * b.h, 0) > pixels * 1.2);
        }
    }
});
await test('example6全屏按钮进出不触发隐藏设置，主体仍可请求聆听', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.touch(337, 24); assert.equal(r.frameText().includes('OBEING PIXEL'), false);
    r.touch(337, 50); assert.equal(r.frameText().includes('断开手机连接'), false);
    assert.ok(r.sent.some(m => m.type === 'listen'));
    r.touch(337, 24); assert.ok(r.frameText().includes('OBEING PIXEL'));
    r.touch(337, 24); r.button('longPress'); assert.ok(r.frameText().includes('断开手机连接'));
    r.exit();
});
await test('批量绘制与回退逐条输出一致，中间过程在正常和全屏均可见', () => {
    for (const fullscreen of [false, true]) {
        const direct = [], batch = [];
        const screenFor = log => ({ width: 480, height: 480,
            clear(color) { log.push(['clear', color]); }, fillRect(...args) { log.push(['rect', ...args]); },
            measureText(value, style) { return { width: value.length * 8 * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
            drawText(value, x, y) { log.push(['text', value, x, y]); } });
        const fast = screenFor(batch);
        fast.fillRects = (buffer, count) => { for (let i = 0; i < count; i++) fast.fillRect(...buffer.subarray(i * 5, i * 5 + 5)); };
        const view = { ...state.initialState(), state: 'thinking', authenticated: true, thinkingText: '正在查询天气', userText: '实际问题', assistantText: '实际回答' };
        const input = { clock: 1000, tiltX: 0, tiltY: 0, battery: 86, settings: false, fullscreen };
        render.drawScene(screenFor(direct), view, input); render.drawScene(fast, view, input);
        assert.deepEqual(batch, direct);
        assert.ok(batch.some(call => call[0] === 'text' && call[1] === '正在查询天气'));
    }
});
console.log(`\nObeing Pixel 验证通过：${passed} 项`);
