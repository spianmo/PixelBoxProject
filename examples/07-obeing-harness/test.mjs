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
const { EnterpriseAuth, validateOrigin, isSameServiceOrigin } = authModule;
const { LocalAuthStore } = await source('persistence.ts');
const { MexusConversation, hello } = await source('conversation.ts');
const { HarnessController, userMessage } = await source('controller.ts');
const { StreamingSpeech } = await source('speech-stream.ts');
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
function fixtureAuth(overrides = {}, store, now = () => 10000) {
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
    return { auth: new EnterpriseAuth(config, fetcher, now, store), requests };
}
async function loggedIn() { const fixture = fixtureAuth(); await fixture.auth.login('ABC123', 'USR123', 'fixture-password'); return fixture; }
const tick = () => new Promise((resolve) => setImmediate(resolve));

await test('会话与原样密码持久化按服务和账号隔离，损坏记录不建立身份', async () => {
    const data = new Map(), kv = { get: key => data.get(key), set: (key, value) => data.set(key, value) };
    const store = new LocalAuthStore(kv, config);
    const { auth } = fixtureAuth({}, store);
    store.remember(' abc123 ', 'usr123', ' exact password ');
    await auth.login('ABC123', 'USR123', ' exact password ');
    assert.deepEqual(new LocalAuthStore(kv, config).load(), auth.current());
    assert.equal(store.password('ABC123', 'USR123'), ' exact password ');
    assert.equal(store.password('ABC123', 'USR456'), '');
    for (const changed of [{ origin: 'https://other.invalid' }, { oem: 'other' }, { domain: 'other' }, { deviceId: 'other' }]) {
        const isolated = new LocalAuthStore(kv, { ...config, ...changed });
        assert.equal(isolated.load(), null); assert.equal(isolated.password('ABC123', 'USR123'), '');
    }
    const raw = data.get('h.session');
    for (const change of [{ userId: '0' }, { tenantId: '-1' }, { token: '' }, { issuedAt: -1 }, { expiresIn: '3600' }]) {
        const value = JSON.parse(raw); Object.assign(value.session, change); data.set('h.session', JSON.stringify(value));
        assert.equal(store.load(), null);
    }
    data.set('h.session', '{broken'); assert.equal(store.load(), null);
    data.set('h.session', raw); auth.clear();
    assert.equal(store.load(), null); assert.equal(store.password('ABC123', 'USR123'), ' exact password ');
});
await test('恢复有效会话不重复登录，刷新保存新token，退出使迟到刷新无法写回', async () => {
    const data = new Map(), kv = { get: key => data.get(key), set: (key, value) => data.set(key, value) };
    const store = new LocalAuthStore(kv, config);
    const original = fixtureAuth({}, store); await original.auth.login('ABC123', 'USR123', 'fixture');
    const warm = fixtureAuth({}, store);
    assert.equal((await warm.auth.valid()).token, 'fixture-access'); assert.equal(warm.requests.length, 0);
    const refreshed = fixtureAuth({ '/api/meeting/user/refreshToken': () => response(token({ token: 'new-access' })) }, store, () => 3600000);
    assert.equal((await refreshed.auth.valid()).token, 'new-access'); assert.equal(store.load().token, 'new-access');
    assert.equal(refreshed.requests.length, 1);
    let release;
    const late = fixtureAuth({ '/api/meeting/user/refreshToken': () => new Promise(resolve => { release = resolve; }) }, store);
    const waiting = late.auth.valid('new-access'); late.auth.clear(); release(response(token({ token: 'late-access' })));
    await assert.rejects(waiting); assert.equal(store.load(), null);
    store.save(original.auth.current());
    const expired = fixtureAuth({}, store, () => 8000000);
    await assert.rejects(expired.auth.valid(), /过期/); assert.equal(store.load(), null); assert.equal(expired.requests.length, 0);
});

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
await test('同源比较兼容ESP-IDF显式443和域名大小写，拒绝跨站及畸形地址', () => {
    assert.equal(validateOrigin('HTTPS://V4.TEST.INVALID:00443/'), config.origin);
    for (const url of [config.origin, config.origin + ':443/api', 'https://V4.TEST.INVALID:00443/api?q=1'])
        assert.equal(isSameServiceOrigin(url, config.origin), true, url);
    assert.equal(isSameServiceOrigin(config.origin + ':8443/api', config.origin + ':08443'), true);
    for (const url of ['http://v4.test.invalid/api', config.origin + ':444/api', config.origin + '.evil/api',
        config.origin + '@evil/api', 'https://user@v4.test.invalid/api', config.origin + '\\@evil/api',
        config.origin + ':0/api', config.origin + ':65536/api', config.origin + ':443x/api',
        config.origin + '\n/api', '//v4.test.invalid/api', '/api'])
        assert.equal(isSameServiceOrigin(url, config.origin), false, url);
    for (const origin of [config.origin + ':0', config.origin + ':65536', config.origin + '\\evil']) assert.throws(() => validateOrigin(origin));
});
await test('ESP-IDF响应URL包含443时完整登录成功，真正跨站在OAuth前终止', async () => {
    const path = '/basestation/api/workbench/user/ucenter/login';
    for (const url of [config.origin + ':443' + path, 'https://V4.TEST.INVALID:443' + path]) {
        const { auth, requests } = fixtureAuth({ [path]: () => ({ ...response(token()), url }) });
        await auth.login('ABC123', 'USR123', 'fixture-password');
        assert.ok(auth.current());
        assert.equal(requests.length, 5);
    }
    const { auth, requests } = fixtureAuth({ [path]: () => ({ ...response(token()), url: config.origin + '.evil' + path }) });
    await assert.rejects(auth.login('ABC123', 'USR123', 'fixture-password'), /服务返回了其他地址/);
    assert.equal(requests.length, 1);
    assert.equal(auth.current(), null);
});
await test('TLS内存耗尽区别于网络和账号错误，失败不继续OAuth', async () => {
    for (const message of ['TLS_ALLOC_FAILED: ESP_ERR_HTTP_CONNECT', 'mbedtls=-32512', 'mbedtls_ssl_setup returned -0x7F00', 'network offline']) {
        const { auth, requests } = fixtureAuth({ '/basestation/api/workbench/user/ucenter/login': () => { throw new Error(message); } });
        await assert.rejects(auth.login('ABC123', 'USR123', 'fixture-password'), message === 'network offline' ? /服务连接失败/ : /TLS 内存不足/);
        assert.equal(auth.current(), null);
        assert.equal(requests.length, 1);
    }
});
await test('网络worker创建失败立即结束登录并显示内存原因', async () => {
    const { auth, requests } = fixtureAuth({ '/basestation/api/workbench/user/ucenter/login': () => { throw new Error('NETWORK_WORKER_ALLOC_FAILED'); } });
    await assert.rejects(auth.login('ABC123', 'USR123', 'fixture-password'), /网络线程内存不足/);
    assert.equal(requests.length, 1);
    assert.equal(auth.current(), null);
});
await test('语音初始化错误保留原因且不透出密钥', () => {
    assert.equal(userMessage(new Error('ENOTSUP: 需要 speech 固件及 16 kHz 音频硬件'), '工程语音配置不可用'), '语音引擎启动失败，请更新固件后重启');
    assert.equal(userMessage(new Error('语音线程内存不足，请更新固件后重启'), '工程语音配置不可用'), '语音线程内存不足，请更新固件后重启');
    assert.equal(userMessage(new Error('key=fixture-secret'), '配置失败'), '配置失败');
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
await test('待机预连接只做hello，录音期间握手完成后首个问题直接复用', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const warm = conversation.prepare();
    assert.equal(conversation.prepare(), warm);
    await tick();
    const peer = peers[0]; peer.onopen();
    assert.deepEqual(peer.frames.map(frame => frame.type), ['hello']);
    const result = conversation.ask('录音后的问题', { answer() {}, progress() {} });
    await tick();
    assert.equal(peers.length, 1);
    assert.equal(peer.frames.length, 1);
    peer.receive('welcome', { sessionId: 'prewarmed' });
    await warm; await tick();
    assert.deepEqual(peer.frames.map(frame => frame.type), ['hello', 'user.turn']);
    peer.receive('assistant.done', { requestId: peer.frames.at(-1).payload.requestId, finalText: '回复' });
    assert.equal(await result, '回复');
    await conversation.prepare();
    assert.equal(peers.length, 1);
    conversation.cancel(true);
});
await test('退出取消预连接，迟到鉴权和welcome不能保留socket；失败后正式请求重连', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const originalValid = auth.valid.bind(auth);
    let releaseAuth;
    auth.valid = () => new Promise(resolve => { releaseAuth = resolve; });
    const pending = conversation.prepare();
    conversation.cancel(true);
    releaseAuth(auth.current()); await pending;
    assert.equal(peers.length, 0);
    auth.valid = originalValid;
    const warm = conversation.prepare(); await tick();
    const old = peers[0]; old.onopen();
    const late = old.onmessage;
    conversation.cancel(true); await warm;
    late({ data: JSON.stringify({ v: 1, type: 'welcome', payload: { sessionId: 'late' } }) });
    assert.equal(old.readyState, 3);
    const failedWarm = conversation.prepare(); await tick();
    const caught = assert.rejects(failedWarm, /网络连接失败/);
    peers[1].onerror(); await caught;
    const result = conversation.ask('重试', { answer() {}, progress() {} }); await tick();
    assert.equal(peers.length, 3);
    peers[2].onopen(); peers[2].receive('welcome', { sessionId: 'retry' });
    peers[2].receive('assistant.done', { requestId: peers[2].frames.at(-1).payload.requestId, finalText: '成功' });
    assert.equal(await result, '成功');
    conversation.cancel(true);
});
await test('等待预连接期间取消立即结束旧轮，新轮仍复用这次握手', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const warm = conversation.prepare(); await tick();
    const peer = peers[0]; peer.onopen();
    const first = conversation.ask('旧轮', { answer() {}, progress() {} }); await tick();
    let cancelled = false;
    const caught = first.catch(error => { assert.match(error.message, /取消/); cancelled = true; });
    conversation.cancel(); await tick();
    assert.equal(cancelled, true, '取消不等待15秒预连接超时');
    await caught;
    const next = conversation.ask('新轮', { answer() {}, progress() {} }); await tick();
    peer.receive('welcome', { sessionId: 'shared' }); await warm; await tick();
    assert.equal(peers.length, 1);
    assert.equal(peer.frames.at(-1).payload.text, '新轮');
    peer.receive('assistant.done', { requestId: peer.frames.at(-1).payload.requestId, finalText: '答复' });
    assert.equal(await next, '答复');
    conversation.cancel(true);
});
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
    assert.equal(peer.readyState, 1);
    const next = conversation.ask('明天呢', { answer() {}, progress() {} });
    await tick();
    assert.equal(peers.length, 1, '连续问答复用已握手连接');
    assert.equal(peer.frames.filter((f) => f.type === 'hello').length, 1);
    const nextId = peer.frames.at(-1).payload.requestId;
    assert.notEqual(nextId, requestId);
    peer.receive('assistant.delta', { requestId, seq: 10, textChunk: '迟到旧轮' });
    peer.receive('assistant.done', { requestId: nextId, finalText: '明天有雨' });
    assert.equal(await next, '明天有雨');
    conversation.cancel(true);
    assert.equal(peer.readyState, 3);
});
await test('取消发送真实cancel，退出关闭socket，旧回调不能写入下一轮', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const result = conversation.ask('测试问题', { answer() { throw new Error('late'); }, progress() {} });
    await tick();
    const peer = peers[0]; peer.onopen(); peer.receive('welcome', { sessionId: 'sid' });
    conversation.cancel();
    await assert.rejects(result, /取消/);
    assert.equal(peer.frames.at(-1).type, 'cancel');
    assert.equal(peer.readyState, 1);
    peer.receive('assistant.delta', { requestId: peer.frames.at(-1).payload.requestId, seq: 1, textChunk: '迟到' });
    conversation.cancel(true);
    assert.equal(peer.onmessage, null);
});

await test('握手中取消立即结束，断线后下一轮重新连接', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const first = conversation.ask('测试', { answer() {}, progress() {} });
    await tick();
    conversation.cancel();
    await assert.rejects(first, /取消/);
    assert.equal(peers[0].readyState, 3);
    const next = conversation.ask('重试', { answer() {}, progress() {} });
    await tick();
    peers[1].onopen(); peers[1].receive('welcome', { sessionId: 'new-sid' });
    peers[1].onclose();
    await assert.rejects(next, /连接/);
    conversation.cancel(true);
});

await test('待机处理服务端心跳，凭据轮换关闭旧会话并重新握手', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const first = conversation.ask('第一轮', { answer() {}, progress() {} });
    await tick();
    const peer = peers[0]; peer.onopen(); peer.receive('welcome', { sessionId: 'sid' });
    peer.receive('assistant.done', { requestId: peer.frames.at(-1).payload.requestId, finalText: '答复' });
    await first;
    peer.receive('ping', { nonce: 'fixture-nonce' });
    assert.equal(peer.frames.at(-1).type, 'pong');
    assert.equal(peer.frames.at(-1).payload.nonce, 'fixture-nonce');
    const account = { ...auth.current(), token: 'rotated-fixture-token' };
    auth.valid = async () => account;
    const second = conversation.ask('第二轮', { answer() {}, progress() {} });
    await tick();
    assert.equal(peer.readyState, 3);
    assert.equal(peers.length, 2);
    peers[1].onopen();
    assert.equal(peers[1].frames[0].payload.token, 'rotated-fixture-token');
    conversation.cancel(true);
    await assert.rejects(second, /取消/);
});

await test('复用会话收到鉴权过期时刷新并重连，cancel发送失败不保留连接', async () => {
    const { auth } = await loggedIn();
    const { factory, peers } = sockets();
    const conversation = new MexusConversation(auth, factory);
    const events = { answer() {}, progress() {} };
    const first = conversation.ask('第一轮', events);
    await tick();
    const peer = peers[0]; peer.onopen(); peer.receive('welcome', { sessionId: 'sid' });
    peer.receive('assistant.done', { requestId: peer.frames.at(-1).payload.requestId, finalText: '答复' });
    await first;
    let refreshes = 0;
    const account = auth.current();
    auth.valid = async (rejectedToken) => {
        if (rejectedToken) { assert.equal(rejectedToken, account.token); refreshes++; }
        return rejectedToken ? { ...account, token: 'refreshed-fixture' } : account;
    };
    const second = conversation.ask('第二轮', events);
    await tick();
    peer.receive('assistant.error', { requestId: peer.frames.at(-1).payload.requestId, code: 401 });
    await tick();
    assert.equal(refreshes, 1); assert.equal(peers.length, 2); assert.equal(peer.readyState, 3);
    peers[1].onopen(); peers[1].receive('welcome', { sessionId: 'renewed' });
    peers[1].send = () => { throw new Error('fixture queue full'); };
    conversation.cancel();
    await assert.rejects(second, /取消/);
    assert.equal(peers[1].readyState, 3);
});

function runtime(wakeConfig) {
    const speechCalls = [];
    let wake;
    let wakeError;
    let transcriptResolve;
    let playbackResolve;
    const speech = {
        available: () => true, configure(value) { speechCalls.push(['configure', value]); },
        wakeword: { start(opts) { wake = opts.onWake; wakeError = opts.onError; speechCalls.push(['wake.start', opts.phrase, opts.pinyin, opts.threshold]); return Promise.resolve(); }, stop() { speechCalls.push(['wake.stop']); } },
        recognize() { speechCalls.push(['recognize']); return new Promise((resolve) => { transcriptResolve = resolve; }); },
        speak(text) { speechCalls.push(['speak', text]); return new Promise((resolve) => { playbackResolve = resolve; }); },
        cancel() { speechCalls.push(['cancel']); },
    };
    const account = { nickname: '测试', userCode: 'USR123', tenantCode: 'ABC123' };
    let current = null;
    const auth = { current: () => current, clear() { current = null; }, async login() { current = account; return account; } };
    const conversation = { cancel() {}, async prepare() {}, async ask(text, events) { events.answer('真实协议测试回复'); events.progress('查询完成'); return '真实协议测试回复'; } };
    const controller = new HarnessController(auth, conversation, speech, () => true, wakeConfig);
    controller.setPaused(false);
    return { controller, speech, speechCalls, wake: () => wake(), wakeError: (message) => wakeError(message), recognized: (text) => transcriptResolve(text), played: () => playbackResolve() };
}
await test('首句在AI完成前开播，增量字幕持续更新，尾句按顺序播完才待机', async () => {
    const r = runtime();
    let events, finishAnswer;
    r.controller.conversation.ask = (_text, callbacks) => {
        events = callbacks;
        return new Promise(resolve => { finishAnswer = resolve; });
    };
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    const turn = r.controller.sendText('天气怎么样');
    events.answer('今天晴天。');
    await tick();
    assert.deepEqual(r.speechCalls.filter(([name]) => name === 'speak'), [['speak', '今天晴天。']]);
    assert.equal(r.controller.view.state, 'speaking');
    events.answer('今天晴天。适合散步');
    assert.equal(r.controller.view.assistantText, '今天晴天。适合散步');
    events.answer('今天晴天。适合散步，记得带水。');
    finishAnswer('今天晴天。适合散步，记得带水。');
    await tick();
    assert.equal(r.speechCalls.filter(([name]) => name === 'speak').length, 1);
    r.played(); await tick();
    assert.deepEqual(r.speechCalls.filter(([name]) => name === 'speak'), [['speak', '今天晴天。'], ['speak', '适合散步，记得带水。']]);
    assert.equal(r.controller.isBusy(), true);
    r.played(); await turn;
    assert.equal(r.controller.view.state, 'idle');
    r.controller.dispose();
});
await test('无标点首片有界启动，代理对补齐后播出，final只替换未提交尾部', async () => {
    const parts = [];
    let release;
    const stream = new StreamingSpeech(text => {
        parts.push(text);
        return new Promise(resolve => { release = resolve; });
    });
    stream.update('第一段没有标点');
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.deepEqual(parts, ['第一段没有标点']);
    stream.update('第一段没有标点原始尾部');
    const done = stream.finish('第一段没有标点修订尾部');
    release(); await tick();
    assert.deepEqual(parts, ['第一段没有标点', '修订尾部']);
    release(); await done;
    const unicodeParts = [];
    const unicode = new StreamingSpeech(async text => { unicodeParts.push(text); });
    const prefix = '川'.repeat(39);
    unicode.update(prefix + '\uD83D');
    await tick();
    assert.deepEqual(unicodeParts, []);
    unicode.update(prefix + '\uD83D\uDE00');
    await tick();
    await unicode.finish(prefix + '\uD83D\uDE00结束');
    assert.deepEqual(unicodeParts, [prefix + '\uD83D\uDE00', '结束']);
});
await test('已提交前缀被修订不重播，停止清除定时尾句，播放失败可由finish捕获', async () => {
    const parts = [];
    const stream = new StreamingSpeech(async text => { parts.push(text); });
    stream.update('原来答案。'); await tick();
    await stream.finish('完全改写的最终答案。');
    assert.deepEqual(parts, ['原来答案。']);
    const stopped = new StreamingSpeech(async text => { parts.push(text); });
    stopped.update('取消前没标点'); stopped.stop();
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.deepEqual(parts, ['原来答案。']);
    const failed = new StreamingSpeech(async () => { throw new Error('播放失败'); });
    failed.update('错误测试。'); await tick();
    await assert.rejects(failed.finish('错误测试。尾部不播'), /播放失败/);
});
await test('流式播放中静音清除后续段，迟到AI和播放回调不恢复旧轮', async () => {
    const r = runtime();
    let events, finishAnswer;
    r.controller.conversation.ask = (_text, callbacks) => {
        events = callbacks;
        return new Promise(resolve => { finishAnswer = resolve; });
    };
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    const turn = r.controller.sendText('测试');
    events.answer('开始回答。'); await tick();
    events.answer('开始回答。积累的后续内容');
    r.controller.toggleMute();
    events.answer('开始回答。迟到内容。');
    finishAnswer('开始回答。迟到内容。');
    r.played(); await turn;
    assert.deepEqual(r.speechCalls.filter(([name]) => name === 'speak'), [['speak', '开始回答。']]);
    assert.equal(r.controller.view.state, 'muted');
    r.controller.dispose();
});
await test('AI流中途失败立即取消正在播放的首段，队列不继续播报', async () => {
    const r = runtime();
    let events, failAnswer;
    r.controller.conversation.ask = (_text, callbacks) => {
        events = callbacks;
        return new Promise((_resolve, reject) => { failAnswer = reject; });
    };
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    const turn = r.controller.sendText('测试');
    events.answer('开始回答。'); await tick();
    const cancels = r.speechCalls.filter(([name]) => name === 'cancel').length;
    failAnswer(new Error('AI 服务暂时不可用')); await turn;
    assert.equal(r.speechCalls.filter(([name]) => name === 'cancel').length, cancels + 1);
    assert.equal(r.controller.view.errorText, 'AI 服务暂时不可用');
    r.played(); await tick();
    assert.equal(r.controller.view.state, 'idle');
    r.controller.dispose();
});
await test('业务自定义唤醒词和阈值在首次注册及重启监听时完整下发', async () => {
    const wakeConfig = { phrase: '小爱同学', pinyin: 'xiao ai tong xue', threshold: 0.15 };
    const r = runtime(wakeConfig);
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    r.controller.cancel();
    await r.controller.standby();
    assert.deepEqual(r.speechCalls.filter(([name]) => name === 'wake.start'), [
        ['wake.start', '小爱同学', 'xiao ai tong xue', 0.15],
        ['wake.start', '小爱同学', 'xiao ai tong xue', 0.15],
    ]);
    r.controller.dispose();
});
await test('唤醒初始化失败显示内存原因，仍可手动录音', async () => {
    const r = runtime();
    r.speech.wakeword.start = async () => { throw new Error('本地语音缓冲分配失败'); };
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    assert.equal(r.controller.view.errorText, '本地语音缓冲分配失败');
    assert.equal(r.controller.view.state, 'idle');
    const listening = r.controller.listen();
    assert.equal(r.controller.view.state, 'listening');
    r.controller.dispose();
    r.recognized('取消后返回');
    await listening;
});
await test('唤醒运行错误保留原因，取消后旧错误无效', async () => {
    const r = runtime();
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    r.wakeError('离线唤醒麦克风无数据');
    assert.equal(r.controller.view.errorText, '离线唤醒麦克风无数据');
    await r.controller.standby();
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 2);
    r.controller.logout();
    const previous = r.controller.view.errorText;
    r.wakeError('本地语音缓冲分配失败');
    assert.equal(r.controller.view.errorText, previous);
    r.controller.dispose();
});
await test('唤醒错误中的服务URL和密钥仍使用通用提示', async () => {
    const r = runtime();
    r.speech.wakeword.start = async () => { throw new Error('https://test.invalid?key=fixture-secret'); };
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    assert.equal(r.controller.view.errorText, '本地唤醒不可用，点击小川开始');
    r.controller.dispose();
});
await test('本地你好小川唤醒后在播报期间保持监听，可打断旧轮开始新一轮', async () => {
    const r = runtime();
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    assert.deepEqual(r.speechCalls.filter(([name]) => name === 'wake.start'), [['wake.start', '你好小川', 'ni hao xiao chuan', 0.30]]);
    r.wake();
    assert.equal(r.controller.view.state, 'listening');
    r.recognized('今天天气'); await tick();
    assert.equal(r.controller.view.userText, '今天天气');
    assert.equal(r.controller.view.state, 'speaking');
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 2);
    r.wake();
    assert.equal(r.controller.view.state, 'listening');
    assert.equal(r.speechCalls.filter(([name]) => name === 'recognize').length, 2);
    r.played(); await tick();
    assert.equal(r.controller.view.state, 'listening', '旧播报结束不能覆盖新一轮状态');
    r.recognized('明天呢'); await tick();
    assert.equal(r.controller.view.userText, '明天呢');
    assert.equal(r.controller.view.state, 'speaking');
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 3);
    r.played(); await tick();
    assert.equal(r.controller.view.state, 'idle');
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 3);
    r.controller.dispose();
});
await test('云端思考期间唤醒会取消旧请求，迟到回答不能进入播报', async () => {
    const r = runtime();
    let finishAnswer;
    r.controller.conversation.ask = () => new Promise((resolve) => { finishAnswer = resolve; });
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    r.wake();
    r.recognized('讲一个很长的故事'); await tick();
    assert.equal(r.controller.view.state, 'thinking');
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 2);
    r.wake();
    assert.equal(r.controller.view.state, 'listening');
    finishAnswer('已经过期的回答'); await tick();
    assert.equal(r.controller.view.state, 'listening');
    assert.equal(r.speechCalls.some(([name, text]) => name === 'speak' && text === '已经过期的回答'), false);
    r.controller.dispose();
});
await test('录音和等待识别期间可重复唤醒，旧识别结果不能发起回答', async () => {
    const r = runtime();
    const recordings = [];
    const asks = [];
    let cancelCount = 0;
    r.speech.recognize = (options) => new Promise((resolve, reject) => recordings.push({ options, resolve, reject }));
    r.controller.conversation.cancel = () => { cancelCount++; };
    r.controller.conversation.ask = async (text) => { asks.push(text); return ''; };
    r.controller.configureSpeech({ region: 'eastasia', key: 'fixture-key-1234567890' });
    await r.controller.login('ABC123', 'USR123', 'fixture');
    r.wake();
    assert.equal(r.speechCalls.filter(([name]) => name === 'wake.start').length, 2, '录音开始即恢复唤醒');
    const beforeInterrupt = cancelCount;
    r.wake();
    r.wake();
    assert.equal(recordings.length, 3);
    recordings[2].options.onPartial('新轮即时字幕');
    assert.equal(r.controller.view.userText, '新轮即时字幕');
    assert.deepEqual(asks, [], '中间转写只更新字幕，最终结果才提交 AI');
    assert.equal(cancelCount, beforeInterrupt + 2);
    recordings[0].resolve('旧问题');
    recordings[1].reject(new Error('旧识别失败'));
    recordings[0].options.onLevel(99);
    recordings[0].options.onPartial('迟到旧字幕');
    await tick();
    assert.deepEqual(asks, []);
    assert.equal(r.controller.view.level, 0);
    assert.equal(r.controller.view.userText, '新轮即时字幕');
    assert.equal(r.controller.view.state, 'listening');
    assert.equal(r.controller.view.errorText, '');
    recordings[2].resolve('新问题');
    await tick();
    assert.deepEqual(asks, ['新问题']);
    assert.equal(r.controller.view.state, 'idle');
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
async function spokenParts(text) {
    const parts = [];
    const stream = new StreamingSpeech(async part => { parts.push(part); });
    await stream.finish(text);
    return parts;
}
await test('长中文回复按UTF8分段，不拆字符且每段符合原生TTS限制', async () => {
    const answer = '小川正在回答。'.repeat(1500) + String.fromCodePoint(0x1f600);
    const parts = await spokenParts(answer);
    assert.equal(parts.join(''), answer);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((value) => new TextEncoder().encode(value).byteLength <= 5400));
    assert.ok(parts.every((value) => Array.from(value).length <= 240));
});
await test('3000汉字首段40字符后按240上限切分，表情与句末边界完整', async () => {
    const answer = '川'.repeat(3000);
    const parts = await spokenParts(answer);
    assert.equal(parts.join(''), answer);
    assert.equal(parts.length, 14);
    assert.equal(parts[0].length, 40);
    assert.ok(parts.every((value) => Array.from(value).length <= 240));
    const emoji = String.fromCodePoint(0x1f600);
    const boundary = '川'.repeat(279) + emoji + '你好。';
    assert.deepEqual(await spokenParts(boundary), ['川'.repeat(40), '川'.repeat(239) + emoji, '你好。']);
    const sentence = '川'.repeat(119) + '。';
    assert.deepEqual(await spokenParts('首句。' + sentence + '回答'), ['首句。', sentence, '回答']);
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
await test('真实main登录前等待NTP，取消不发送密码，再次提交复用已保存密码', async () => {
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
    tap(180, 335); await tick();
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].password, 'a'.repeat(16));
    const credentials = JSON.parse(stored.find(([key]) => key === 'h.credentials')[1]);
    assert.equal(credentials.password, 'a'.repeat(16));
    assert.equal(stored.some(([key]) => key === 'h.key'), false);
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
    assert.equal(wakeStarts, 4, '显式录音期间也恢复离线唤醒以便打断');
    assert.equal(recordings, 1);
    exit();
});
for (const [width, height] of [[368, 448], [480, 480]]) await test(`真实main ${width}屏工程Azure配置、键盘输入、登录和设置触摸`, async () => {
    let touch;
    let renderFrame;
    let drawn = [];
    let exit;
    let requests = 0;
    let recordings = 0;
    const data = new Map(Object.entries({ 'h.tenant': 'ABC123', 'h.account': 'USR123', 'h.origin': config.origin }));
    const speechConfigs = [];
    const fetcher = async (url) => {
        requests++;
        if (url.endsWith('/ucenter/login') || url.endsWith('/token')) return response(token());
        if (url.endsWith('/oauth/appid')) return response({ appid: 'fixture-app' });
        if (url.endsWith('/authorize')) return response({ code: 'fixture-code' });
        if (url.endsWith('/user/info')) return response({ nickname: '小川' });
        throw new Error('unexpected fixture path');
    };
    const px = {
        system: { info: () => ({ deviceId: 'test-box' }), now: () => 100, battery: () => ({ level: 86 }), ntpSync: async () => {} },
        storage: { kv: { get: name => data.get(name), set: (key, value) => data.set(key, value) } },
        speech: { available: () => true, configure: (value) => speechConfigs.push(value), cancel() {},
            wakeword: { stop() {}, start: async () => {} }, recognize: () => { recordings++; return new Promise(() => {}); }, speak: async () => {} },
        wifi: { status: () => ({ connected: true }), on: () => () => {} },
        input: { onTouch(cb) { touch = cb; return () => {}; }, onButton: () => () => {} },
        sensors: { imu: { available: () => false } },
        screen: { width, height, setFps() {}, onFrame(cb) { renderFrame = cb; }, clear() {}, fillRect() {},
            measureText(value, style) { return { width: Array.from(value).length * 8 * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
            drawText(value) { drawn.push(value); } },
        app: { onExit(cb) { exit = cb; } },
    };
    const start = () => runInNewContext(configuredMainBundle.outputFiles[0].text, { px, TextEncoder, Date, fetch: fetcher, WebSocket: class {},
        setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, console: { log() {} } });
    start();
    assert.equal(speechConfigs.length, 1);
    assert.equal(speechConfigs[0].region, 'eastasia');
    assert.equal(speechConfigs[0].key, 'fixture-project-key-1234567890');
    assert.equal(speechConfigs[0].language, 'zh-CN');
    assert.equal(speechConfigs[0].voice, 'zh-CN-XiaoxiaoNeural');
    const tap = (x, y) => touch({ type: 'down', x, y });
    if (width === 480) {
        tap(86, 269); for (let i = 0; i < 16; i++) tap(46, 307); tap(420, 436); tap(240, 359);
    } else {
        tap(80, 251); for (let i = 0; i < 16; i++) tap(43, 287); tap(320, 407); tap(180, 335);
    }
    await tick(); await tick();
    // 登录后处于 assistant，点击顶部设置区才会打开 settings；若落到 speech，此坐标不会进入 settings。
    const frame = () => { drawn = []; renderFrame(200); return drawn.join('|'); };
    assert.ok(!drawn.includes('小川'), 'account name removed from assistant header');
    tap(width - 33, 24); assert.equal(frame().includes('ObeingHarness'), false);
    tap(20, 24); assert.equal(recordings, 0);
    tap(width - 33, height === 480 ? 51 : 48);
    assert.equal(recordings, 1); assert.equal(frame().includes('企业服务器'), false);
    tap(width - 33, 24); assert.ok(frame().includes('ObeingHarness'));
    exit();
    const loginRequests = requests;
    start(); await tick(); await tick();
    assert.equal(requests, loginRequests, 'hot reload restores saved access token without login requests');
    assert.ok(!frame().includes('企业登录'));
    tap(width - 33, height === 480 ? 51 : 48);
    drawn = [];
    renderFrame(16);
    assert.ok(drawn.includes('语音服务 · 已配置'), `实际页面文本: ${drawn.join('|')}`);
    assert.ok(drawn.includes('企业服务器'), `实际页面文本: ${drawn.join('|')}`);
    assert.ok(!drawn.includes('设备语音'), `不应进入设备语音页: ${drawn.join('|')}`);
    tap(width / 2, height === 480 ? 383 : 357);
    assert.ok(frame().includes('企业登录'));
    assert.equal(JSON.parse(data.get('h.session')).session, null);
    assert.equal(JSON.parse(data.get('h.credentials')).password, 'a'.repeat(16));
    exit(); start(); await tick();
    assert.ok(frame().includes('企业登录'), 'explicit logout remains logged out after restart');
    assert.equal(requests, loginRequests);
    exit();
});
await test('登录/语音/服务器/键盘/助手浅暗在368、320和480像素屏内', () => {
    for (const width of [368, 320, 480]) for (const theme of ['light', 'dark']) for (const page of ['login', 'speech', 'server', 'settings', 'editor', 'assistant']) {
        const r = runtime();
        const view = { ...r.controller.view, theme, state: 'speaking', authenticated: true, displayName: '测试小川', enterpriseId: 'ABC123',
            userText: '今天适合去公园吗？', assistantText: '今天晴朗，很适合散步。', thinkingText: '天气查询完成' };
        const form = { page, returnPage: 'login', field: 'password', upper: true, symbols: false, busy: false, speechReady: true,
            values: { tenant: 'ABC123', account: 'USR123', password: 'fixture-password', region: 'eastasia', key: 'a'.repeat(32), origin: config.origin, oem: '', domain: '', question: '' } };
        const height = width === 480 ? 480 : 448;
        const screen = { width, height, clear() {},
            measureText(value, style) { const scale = style?.scale || 1; return { width: Array.from(value).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 12 : 6), 0) * scale, height: 12 * scale }; },
            fillRect(x, y, w, h) { assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height, `${page} rect ${x},${y},${w},${h}`); },
            drawText(value, x, y, style) { const size = this.measureText(value, style); assert.ok(x >= 0 && y >= 0 && x + size.width <= width && y + size.height <= height, `${page} text ${value} ${x},${y}`); assert.equal(style.scale, width === 480 ? 2 : 1); } };
        drawHarness(screen, view, { clock: 1234, tiltX: 0.8, tiltY: -0.8, battery: 86, settings: false }, form);
        r.controller.dispose();
    }
    assert.equal(keyboardKeyAt({ symbols: false, upper: true }, 25, 192, 368), '1');
});
console.log(`\nObeingHarness: ${passed} tests passed`);
