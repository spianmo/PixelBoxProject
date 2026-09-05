import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
async function source(name) {
    const result = await build({ entryPoints: [join(root, 'src', name)], bundle: true, write: false, format: 'esm', target: 'es2020' });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const authModule = await source('auth.ts');
const { EnterpriseAuth, validateOrigin } = authModule;
const { MexusConversation, hello } = await source('conversation.ts');
const { HarnessController, speechParts } = await source('controller.ts');
const { projectSpeechConfig } = await source('project-config.ts');
const { drawHarness, keyboardKeyAt } = await source('render.ts');
async function mainWithSpeech(region, key) {
    return build({
        entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife', target: 'es2020',
        plugins: [{
            name: 'fixture-project-speech',
            setup(builder) {
                builder.onResolve({ filter: /^\.\/project-config$/ }, () => ({ path: 'project-config', namespace: 'fixture' }));
                builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
                    contents: `export const projectSpeechConfig = () => (${region && key ? JSON.stringify({ region, key }) : 'null'});`,
                    loader: 'js',
                }));
            },
        }],
    });
}
const mainBundle = await mainWithSpeech('', '');
const configuredMainBundle = await mainWithSpeech('eastasia', 'fixture-project-key-1234567890');
let passed = 0;
async function test(name, fn) { await fn(); console.log('[OK]', name); passed++; }
const config = { origin: 'https://v4.test.invalid', deviceId: 'test-pixelbox', oem: '', domain: '' };
function response(data, status = 200, code = status) {
    return { ok: status >= 200 && status < 300, status, url: config.origin + '/api', text: async () => JSON.stringify({ code, success: status === 200, data }) };
}
const token = (extra = {}) => ({ token: 'fixture-access', refreshToken: 'fixture-refresh', expiresIn: 3600, refreshTokenExpiresIn: 7200,
    userSession: { userId: '9223372036854775001', tenantId: '9223372036854775002' }, ...extra });
function fixtureAuth(overrides = {}) {
    const requests = [];
    const fetcher = async (url, init) => {
        requests.push({ url, init });
        const path = url.slice(config.origin.length);
        if (overrides[path]) return overrides[path](url, init);
        if (path.endsWith('/ucenter/login')) {
            const raw = '{"code":200,"data":{"token":"fixture-base","refreshToken":"fixture-refresh","expiresIn":3600,"refreshTokenExpiresIn":7200,"userSession":{"userId":9223372036854775001,"tenantId":9223372036854775002}}}';
            return { ...response(null), text: async () => raw };
        }
        if (path.endsWith('/oauth/appid')) return response({ appid: 'fixture-app' });
        if (path.endsWith('/authorize')) return response({ code: 'fixture-code' });
        if (path.endsWith('/token')) return response(token());
        if (path.endsWith('/user/info')) return response({ userId: '9223372036854775001', tenantId: '9223372036854775002', nickname: '小川测试' });
        throw new Error('Unexpected fixture request: ' + path);
    };
    return { auth: new EnterpriseAuth(config, fetcher, () => 10000), requests };
}
async function loggedIn() { const fixture = fixtureAuth(); await fixture.auth.login('ABC123', 'USR123', 'fixture-password'); return fixture; }
const tick = () => new Promise((resolve) => setImmediate(resolve));

await test('HTTPS源校验拒绝明文、账号URL、路径和查询', () => {
    assert.equal(validateOrigin('https://v4.test.invalid/'), config.origin);
    for (const value of ['http://v4.test.invalid', 'https://user:pass@v4.test.invalid', 'https://v4.test.invalid/path', 'https://v4.test.invalid?x']) assert.throws(() => validateOrigin(value));
});
await test('工程语音配置必须同时包含区域和密钥', () => {
    assert.equal(projectSpeechConfig({ region: 'eastasia', key: '' }), null);
    assert.equal(projectSpeechConfig({ region: '', key: 'fixture-project-key-1234567890' }), null);
    assert.deepEqual(projectSpeechConfig({ region: ' eastasia ', key: ' fixture-project-key-1234567890 ' }), {
        region: 'eastasia', key: 'fixture-project-key-1234567890', language: undefined, voice: undefined,
    });
});
await test('真实V4登录顺序、禁止重定向、64位数字ID无精度损失', async () => {
    const { auth, requests } = await loggedIn();
    assert.equal(requests.length, 5);
    assert.ok(requests.every(({ init }) => init.redirect === 'error' && init.timeoutMs === 15000));
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(JSON.parse(requests[0].init.body).tenantCode, 'ABC123');
    assert.equal(requests[1].init.headers['X-Tenant-Id'], '9223372036854775002');
    assert.equal(auth.current().userId, '9223372036854775001');
    const frame = hello(auth.current(), 'device', 100);
    assert.equal(frame.payload.companyId, '9223372036854775002');
    assert.equal(frame.payload.userId, '9223372036854775001');
    assert.equal(frame.payload.deviceMeta.model, 'PixelBox');
});
await test('登录中退出后旧响应不能恢复账号，且不继续OAuth请求', async () => {
    let release;
    const { auth, requests } = fixtureAuth({ '/basestation/api/workbench/user/ucenter/login': () => new Promise((resolve) => { release = resolve; }) });
    const login = auth.login('ABC123', 'USR123', 'fixture-password');
    auth.clear();
    release(response(token()));
    await assert.rejects(login, /取消/);
    assert.equal(auth.current(), null);
    assert.equal(requests.length, 1);
});
await test('刷新合并并发，退出后拒绝迟到刷新凭据', async () => {
    let release;
    const { auth, requests } = fixtureAuth({ '/api/meeting/user/refreshToken': () => new Promise((resolve) => { release = resolve; }) });
    await auth.login('ABC123', 'USR123', 'fixture-password');
    const current = auth.current();
    const a = auth.valid(current.token);
    const b = auth.valid(current.token);
    assert.equal(requests.filter(({ url }) => url.endsWith('/refreshToken')).length, 1);
    auth.clear();
    release(response(token({ token: 'rotated' })));
    await assert.rejects(a);
    await assert.rejects(b);
    assert.equal(auth.current(), null);
});
await test('错误登录和HTTP重定向绝不建立工作账号', async () => {
    const { auth } = fixtureAuth({ '/basestation/api/workbench/user/ucenter/login': () => response({}, 302, 302) });
    await assert.rejects(auth.login('ABC123', 'USR123', 'fixture-password'));
    assert.equal(auth.current(), null);
});
await test('非JSON HTTP401/403保留鉴权状态并清除过期账号', async () => {
    for (const status of [401, 403]) {
        const { auth } = fixtureAuth({ '/api/meeting/user/refreshToken': () => ({ ...response(null, status), text: async () => '<html>access denied</html>' }) });
        await auth.login('ABC123', 'USR123', 'fixture-password');
        await assert.rejects(auth.valid(auth.current().token), (error) => error.code === status);
        assert.equal(auth.current(), null);
    }
});

function sockets() {
    const peers = [];
    const factory = (url) => {
        const peer = { url, readyState: 1, frames: [], send(raw) { this.frames.push(JSON.parse(raw)); }, close() { this.readyState = 3; },
            receive(type, payload) { this.onmessage?.({ data: JSON.stringify({ v: 1, type, payload }) }); } };
        peers.push(peer); return peer;
    };
    return { factory, peers };
}
await test('WSS hello/user.turn增量按seq去重，旧request不污染，done无增量也返回', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory, () => 12345);
    const answers = [];
    const progress = [];
    const result = conversation.ask('天气如何', { answer: (v) => answers.push(v), progress: (v) => progress.push(v) });
    await tick();
    const peer = peers[0];
    assert.equal(peer.url, 'wss://v4.test.invalid/mexusclaw-socket');
    peer.onopen();
    assert.equal(peer.frames[0].type, 'hello');
    peer.receive('welcome', { sessionId: 'fixture-session' });
    const requestId = peer.frames.find((f) => f.type === 'user.turn').payload.requestId;
    peer.receive('assistant.delta', { requestId: 'old', seq: 1, textChunk: '旧内容' });
    peer.receive('assistant.delta', { requestId, seq: 1, textChunk: '今天' });
    peer.receive('assistant.delta', { requestId, seq: 1, textChunk: '重复' });
    peer.receive('assistant.delta', { requestId, seq: 0, visualEffect: { params: { displayName: '查询天气完成' } } });
    peer.receive('assistant.done', { requestId, finalText: '今天晴天' });
    assert.equal(await result, '今天晴天');
    assert.deepEqual(answers, ['今天', '今天晴天']);
    assert.deepEqual(progress, ['查询天气完成']);
    assert.equal(peer.readyState, 3);
});
await test('取消发送真实cancel并关闭socket，旧回调不能写入下一轮', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const result = conversation.ask('测试问题', { answer() { throw new Error('late'); }, progress() {} });
    await tick();
    const peer = peers[0]; peer.onopen(); peer.receive('welcome', { sessionId: 'sid' });
    conversation.cancel();
    await assert.rejects(result, /取消/);
    assert.equal(peer.frames.at(-1).type, 'cancel');
    assert.equal(peer.onmessage, null);
});

function runtime() {
    const speechCalls = [];
    let wake;
    let transcriptResolve;
    let playbackResolve;
    const speech = {
        available: () => true, configure(value) { speechCalls.push(['configure', value]); },
        wakeword: { start(opts) { wake = opts.onWake; speechCalls.push(['wake.start', opts.phrase]); return Promise.resolve(); }, stop() { speechCalls.push(['wake.stop']); } },
        recognize() { speechCalls.push(['recognize']); return new Promise((resolve) => { transcriptResolve = resolve; }); },
        speak(text) { speechCalls.push(['speak', text]); return new Promise((resolve) => { playbackResolve = resolve; }); },
        cancel() { speechCalls.push(['cancel']); },
    };
    const account = { nickname: '测试', userCode: 'USR123', tenantCode: 'ABC123' };
    let current = null;
    const auth = { current: () => current, clear() { current = null; }, async login() { current = account; return account; } };
    const conversation = { cancel() {}, async ask(text, events) { events.answer('真实协议测试回复'); events.progress('查询完成'); return '真实协议测试回复'; } };
    const controller = new HarnessController(auth, conversation, speech, () => true);
    controller.setPaused(false);
    return { controller, speechCalls, wake: () => wake(), recognized: (text) => transcriptResolve(text), played: () => playbackResolve() };
}
await test('本地你好小川唤醒->单轮ASR->AI->实际播完才重新唤醒', async () => {
    const r = runtime();
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    assert.deepEqual(r.speechCalls.filter(([name]) => name === 'wake.start'), [['wake.start', '你好小川']]);
    r.wake();
    assert.equal(r.controller.view.state, 'listening');
    r.recognized('今天天气'); await tick();
    assert.equal(r.controller.view.userText, '今天天气');
    assert.equal(r.controller.view.state, 'speaking');
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 1);
    r.played(); await tick();
    assert.equal(r.controller.view.state, 'idle');
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 2);
    r.controller.dispose();
});
await test('退出/取消识别后迟到结果不恢复账号或发送问题，内容与身份清零', async () => {
    const r = runtime();
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    const listening = r.controller.listen();
    r.controller.logout(); r.recognized('已退出后的秘密'); await listening;
    assert.equal(r.controller.view.authenticated, false);
    assert.equal(r.controller.view.userText, '');
    assert.equal(r.controller.view.displayName, '');
    assert.equal(r.speechCalls.some(([name]) => name === 'speak'), false);
    r.controller.dispose();
});
await test('长中文回复按UTF8分段，不拆字符且每段符合原生TTS限制', () => {
    const answer = '小川正在回答。'.repeat(1500) + String.fromCodePoint(0x1f600);
    const parts = speechParts(answer);
    assert.equal(parts.join(''), answer);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((value) => new TextEncoder().encode(value).byteLength <= 5400));
    assert.ok(parts.every((value) => Array.from(value).length <= 240));
});
await test('3000汉字无句末仍按240字符上限切分，表情与句末边界完整', () => {
    const answer = '川'.repeat(3000);
    const parts = speechParts(answer);
    assert.equal(parts.join(''), answer);
    assert.equal(parts.length, 13);
    assert.ok(parts.every((value) => Array.from(value).length <= 240));
    const emoji = String.fromCodePoint(0x1f600);
    const boundary = '川'.repeat(239) + emoji + '你好。';
    assert.deepEqual(speechParts(boundary), ['川'.repeat(239) + emoji, '你好。']);
    const sentence = '川'.repeat(119) + '。';
    assert.deepEqual(speechParts(sentence + '回答'), [sentence, '回答']);
});
await test('暂停页面阻止网络恢复和静音切换启动唤醒，返回助手只启动一次', async () => {
    const r = runtime();
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 1);
    r.controller.setPaused(true);
    r.controller.networkChanged(true);
    r.controller.toggleMute(); r.controller.toggleMute();
    await r.controller.listen();
    r.wake();
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 1);
    assert.equal(r.speechCalls.filter(([name]) => name === 'recognize').length, 0);
    r.controller.setPaused(false);
    await r.controller.standby(); await r.controller.standby();
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 2);
    r.controller.dispose();
});
await test('真实main登录前等待NTP，返回取消后旧同步不能发密码，且不持久化秘密', async () => {
    let touch;
    let exit;
    let releaseTime;
    const requestBodies = [];
    const stored = [];
    const timers = new Map();
    const pixelbox = {
        system: { info: () => ({ deviceId: 'test-box' }), now: () => 100, battery: () => ({ level: 86 }),
            ntpSync: () => new Promise((resolve) => { releaseTime = resolve; }) },
        storage: { kv: { get: (key) => ({ 'h.tenant': 'ABC123', 'h.account': 'USR123', 'h.origin': config.origin })[key], set: (...args) => stored.push(args) } },
        speech: { available: () => true, configure() {}, cancel() {}, wakeword: { stop() {}, start: async () => {} } },
        wifi: { status: () => ({ connected: true }), on: () => () => {} },
        input: { onTouch(callback) { touch = callback; return () => {}; }, onButton: () => () => {} },
        sensors: { imu: { available: () => false } },
        screen: { width: 368, height: 448, setFps() {}, onFrame() {} },
        app: { onExit(callback) { exit = callback; } },
    };
    runInNewContext(mainBundle.outputFiles[0].text, { px: pixelbox, TextEncoder, Date, console: { log() {} }, WebSocket: class {},
        fetch: async (_url, init) => { requestBodies.push(JSON.parse(init.body)); return response({}, 401); },
        setTimeout(handler) { const id = timers.size + 1; timers.set(id, handler); return id; }, clearTimeout(id) { timers.delete(id); },
        setInterval() { return 1; }, clearInterval() {} });
    const tap = (x, y) => touch({ type: 'down', x, y });
    const password = () => { tap(80, 251); for (let i = 0; i < 16; i++) tap(43, 287); tap(320, 407); };
    password(); tap(180, 335);
    assert.equal(requestBodies.length, 0, 'NTP结束前不能发送凭据');
    tap(25, 52);
    releaseTime(); await tick();
    assert.equal(requestBodies.length, 0, '取消后旧登录不能继续');
    password(); tap(180, 335); await tick();
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].password, 'a'.repeat(16));
    assert.equal(stored.some(([key]) => /password|token|key/.test(key)), false);
    exit();
});
await test('真实main设置与键盘页gotIp和BOOT双击不开麦，返回和显式录音有独立入口', async () => {
    let touch;
    let button;
    let exit;
    let wakeStarts = 0;
    let recordings = 0;
    const wifiEvents = {};
    const fetcher = async (url) => {
        if (url.endsWith('/ucenter/login') || url.endsWith('/token')) return response(token());
        if (url.endsWith('/oauth/appid')) return response({ appid: 'fixture-app' });
        if (url.endsWith('/authorize')) return response({ code: 'fixture-code' });
        if (url.endsWith('/user/info')) return response({ nickname: '小川' });
        throw new Error('unexpected fixture path');
    };
    const px = {
        system: { info: () => ({ deviceId: 'test-box' }), now: () => 100, battery: () => ({ level: 86 }), ntpSync: async () => {} },
        storage: { kv: { get: (key) => ({ 'h.tenant': 'ABC123', 'h.account': 'USR123', 'h.origin': config.origin, 'h.region': 'eastasia' })[key], set() {} } },
        speech: { available: () => true, configure() {}, cancel() {},
            wakeword: { stop() {}, start: async () => { wakeStarts++; } },
            recognize: () => { recordings++; return new Promise(() => {}); }, speak: async () => {} },
        wifi: { status: () => ({ connected: true }), on: (name, cb) => { wifiEvents[name] = cb; return () => {}; } },
        input: { onTouch(cb) { touch = cb; return () => {}; }, onButton(cb) { button = cb; return () => {}; } },
        sensors: { imu: { available: () => false } }, screen: { width: 368, height: 448, setFps() {}, onFrame() {} },
        app: { onExit(cb) { exit = cb; } },
    };
    runInNewContext(mainBundle.outputFiles[0].text, { px, TextEncoder, Date, fetch: fetcher, WebSocket: class {},
        setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, console: { log() {} } });
    const tap = (x, y) => touch({ type: 'down', x, y });
    const boot = (type) => button({ id: 'boot', type });
    const enterSecret = (y) => { tap(80, y); for (let i = 0; i < 16; i++) tap(43, 287); tap(320, 407); };
    enterSecret(251); tap(180, 335); await tick(); await tick();
    assert.equal(wakeStarts, 0, '登录后语音配置页不能自动监听');
    enterSecret(185); tap(180, 270); await tick();
    assert.equal(wakeStarts, 1, '保存语音并进入助手后开始监听');
    tap(335, 48);
    wifiEvents.gotIp(); boot('doubleClick'); boot('doubleClick'); await tick();
    assert.equal(wakeStarts, 1, '设置页不得自动恢复唤醒');
    tap(25, 52); wifiEvents.gotIp(); await tick();
    assert.equal(wakeStarts, 2, '返回助手只启动一次');
    tap(335, 48); tap(180, 300);
    wifiEvents.gotIp(); boot('doubleClick'); boot('doubleClick'); await tick();
    assert.equal(wakeStarts, 2, '文字键盘页不得自动恢复唤醒');
    tap(25, 52); await tick();
    assert.equal(wakeStarts, 3);
    tap(335, 48); boot('click'); await tick();
    assert.equal(wakeStarts, 3, '显式录音不先开启离线唤醒');
    assert.equal(recordings, 1);
    exit();
});
await test('真实main有工程Azure配置时启动即配置且登录后不要求PixelBox填写', async () => {
    let touch;
    let renderFrame;
    let drawn = [];
    const speechConfigs = [];
    const fetcher = async (url) => {
        if (url.endsWith('/ucenter/login') || url.endsWith('/token')) return response(token());
        if (url.endsWith('/oauth/appid')) return response({ appid: 'fixture-app' });
        if (url.endsWith('/authorize')) return response({ code: 'fixture-code' });
        if (url.endsWith('/user/info')) return response({ nickname: '小川' });
        throw new Error('unexpected fixture path');
    };
    const px = {
        system: { info: () => ({ deviceId: 'test-box' }), now: () => 100, battery: () => ({ level: 86 }), ntpSync: async () => {} },
        storage: { kv: { get: (name) => ({ 'h.tenant': 'ABC123', 'h.account': 'USR123', 'h.origin': config.origin })[name], set() {} } },
        speech: { available: () => true, configure: (value) => speechConfigs.push(value), cancel() {},
            wakeword: { stop() {}, start: async () => {} }, recognize: () => new Promise(() => {}), speak: async () => {} },
        wifi: { status: () => ({ connected: true }), on: () => () => {} },
        input: { onTouch(cb) { touch = cb; return () => {}; }, onButton: () => () => {} },
        sensors: { imu: { available: () => false } },
        screen: { width: 368, height: 448, setFps() {}, onFrame(cb) { renderFrame = cb; }, clear() {}, fillRect() {},
            measureText(value) { return { width: Array.from(value).length * 8, height: 12 }; },
            drawText(value) { drawn.push(value); } },
        app: { onExit() {} },
    };
    runInNewContext(configuredMainBundle.outputFiles[0].text, { px, TextEncoder, Date, fetch: fetcher, WebSocket: class {},
        setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, console: { log() {} } });
    assert.equal(speechConfigs.length, 1);
    assert.equal(speechConfigs[0].region, 'eastasia');
    assert.equal(speechConfigs[0].key, 'fixture-project-key-1234567890');
    assert.equal(speechConfigs[0].language, 'zh-CN');
    assert.equal(speechConfigs[0].voice, 'zh-CN-XiaoxiaoNeural');
    const tap = (x, y) => touch({ type: 'down', x, y });
    tap(80, 251); for (let i = 0; i < 16; i++) tap(43, 287); tap(320, 407); tap(180, 335);
    await tick(); await tick();
    // 登录后处于 assistant，点击顶部设置区才会打开 settings；若落到 speech，此坐标不会进入 settings。
    tap(335, 48);
    drawn = [];
    renderFrame(16);
    assert.ok(drawn.includes('语音服务 · 已配置'), `实际页面文本: ${drawn.join('|')}`);
    assert.ok(drawn.includes('企业服务器'), `实际页面文本: ${drawn.join('|')}`);
    assert.ok(!drawn.includes('设备语音'), `不应进入设备语音页: ${drawn.join('|')}`);
});
await test('登录/语音/服务器/键盘/助手浅暗在368和320像素屏内', () => {
    for (const width of [368, 320]) for (const theme of ['light', 'dark']) for (const page of ['login', 'speech', 'server', 'settings', 'editor', 'assistant']) {
        const r = runtime();
        const view = { ...r.controller.view, theme, state: 'speaking', authenticated: true, displayName: '测试小川', enterpriseId: 'ABC123',
            userText: '今天适合去公园吗？', assistantText: '今天晴朗，很适合散步。', thinkingText: '天气查询完成' };
        const form = { page, returnPage: 'login', field: 'password', upper: true, symbols: false, busy: false, speechReady: true,
            values: { tenant: 'ABC123', account: 'USR123', password: 'fixture-password', region: 'eastasia', key: 'a'.repeat(32), origin: config.origin, oem: '', domain: '', question: '' } };
        const screen = { width, height: 448, clear() {},
            measureText(value) { return { width: Array.from(value).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 12 : 6), 0), height: 12 }; },
            fillRect(x, y, w, h) { assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= 448, `${page} rect ${x},${y},${w},${h}`); },
            drawText(value, x, y) { assert.ok(x >= 0 && y >= 0 && x + this.measureText(value).width <= width && y + 12 <= 448, `${page} text ${value} ${x},${y}`); } };
        drawHarness(screen, view, { clock: 1234, tiltX: 0.8, tiltY: -0.8, battery: 86, settings: false }, form);
        r.controller.dispose();
    }
    assert.equal(keyboardKeyAt({ symbols: false, upper: true }, 25, 192, 368), '1');
});
console.log(`\nObeingHarness: ${passed} tests passed`);
