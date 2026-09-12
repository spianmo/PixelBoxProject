#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const examples = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(examples, '06-obeing-pixel', 'src');
async function moduleAt(name) {
    const bundle = await build({ entryPoints: [join(source, name)], bundle: true, format: 'esm', target: 'es2020', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const model = await moduleAt('model.ts');
const state = await moduleAt('state.ts');
const render = await moduleAt('render.ts');
const characters = await moduleAt('characters.ts');
const kitty = await moduleAt('kitty.ts');
const { KITTY_PATTERNS, KITTY_PALETTE } = await moduleAt('kitty-patterns.ts');
const { encodeImaAdpcm } = await moduleAt('../../../simulator/src/renderer/src/device-sim/sandbox/runtime/ima-adpcm.ts');
const harnessBundle = await build({ entryPoints: [join(examples, '07-obeing-harness/src/render.ts')], bundle: true, format: 'esm', target: 'es2020', write: false, logLevel: 'silent' });
const harnessRender = await import(`data:text/javascript;base64,${Buffer.from(harnessBundle.outputFiles[0].text).toString('base64')}`);
const main = await build({ entryPoints: [join(source, 'main.ts')], bundle: true, format: 'iife', target: 'es2020', write: false, logLevel: 'silent' });
let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`[OK] ${name}`);
}

await test('模拟器与固件编码结果一致，128ms 保持2048个样本且仅占1030字节', async () => {
    const pcm = new Int16Array(2048);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(12000 * Math.sin(2 * Math.PI * 500 * i / 16000));
    const encoded = Buffer.from(encodeImaAdpcm(pcm.buffer));
    const fixture = (await readFile(join(examples, '../tools/fixtures/ima-adpcm-sine.hex'), 'utf8')).trim();
    assert.equal(encoded.length, 1030);
    assert.equal(encoded.readUInt16LE(0), 2048);
    assert.equal(encoded.toString('hex'), fixture);
    assert.throws(() => encodeImaAdpcm(new ArrayBuffer(3)), RangeError);
});

await test('猫为有厚度的三维体素，外壳少于实体并保留双耳', () => {
    const volume = model.CAT_VOLUME;
    assert.equal(volume.length, 13);
    const filled = volume.flat(2).filter(Boolean).length;
    assert.ok(filled > 2500);
    assert.ok(model.CAT_SURFACE.length < filled / 2);
    const ears = volume[6].find(row => row.some(Boolean));
    assert.ok(ears[3] && ears[17]);
    assert.equal(ears[10], 0);
});
await test('默认小猫轮廓、全部形变和表情与中午原版0935617一致', () => {
    // 快照独立提取自2026-09-09中午前的0935617，防止重新引入后加的半身和微笑。
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(hash(model.CAT_VOLUME), '1a9be89e7babdd16c16d50781387cb7072e1f4ed2b73a20aa5b7aa7302aeeb1a');
    assert.equal(hash(model.CAT_SHAPES.map(shape => model.CAT_SURFACE.map(p => model.shapePoint(p, shape)))), '705213cb5e95bb0602b6b0274340b8a8ab20af40c1a3dfed5678411f5a5f4c35');
    const states = ['idle', 'sleep', 'wake', 'listening', 'thinking', 'speaking', 'muted', 'error'];
    const faces = states.flatMap(state => [100, 1700, 2650].flatMap(clock => [0, 50, 100].map(level => model.facePoints(state, clock, level))));
    assert.equal(hash(faces), 'b58e0b3dffc9fc4d5bbea9f6c43539a4b87057a02a8351f0d248c6701d5bddb8');
});
await test('IMU投影改变三维视角与深度，倾角钳制后不出主体区', () => {
    const poses = [-1, 0, 1].map((tilt) => model.poseFor('idle', 500, tilt, tilt, 0));
    const projections = poses.map((pose) => model.projectCat(pose, 7.8, 184, 170));
    assert.notDeepEqual(projections[0], projections[2]);
    for (const projection of projections) {
        for (let i = 0; i < projection.length; i++) {
            const point = projection[i];
            assert.ok(point.sx > 50 && point.sx < 320);
            assert.ok(point.sy > 55 && point.sy < 295);
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
await test('长流式字幕按字宽缓存排版，与逐行测量结果一致', () => {
    let measurements = 0;
    const screen = { measureText(text) { measurements++; return { width: Array.from(text).reduce((sum, ch) => sum + (ch.codePointAt(0) > 127 ? 12 : 6), 0), height: 12 }; } };
    const legacy = (text, width, maxLines) => {
        const lines = []; let line = '';
        for (const ch of text) {
            if (ch === '\n') { lines.push(line); line = ''; continue; }
            if (line && screen.measureText(line + ch).width > width) { lines.push(line); line = ch; } else line += ch;
        }
        if (line) lines.push(line);
        return lines.slice(-maxLines);
    };
    for (const text of ['', '\n', '中文字宽ABC😀'.repeat(180), '逐步生成\n第二行\n\n尾部', '超窄字符']) {
        for (const width of [0, 11, 12, 87, 320]) for (const lines of [1, 2, 4]) assert.deepEqual(render.wrapText(screen, text, width, lines), legacy(text, width, lines));
    }
    measurements = 0;
    for (let length = 10; length < 2400; length += 23) render.wrapText(screen, '重复流式字幕ABC'.repeat(240).slice(0, length), 320, 2);
    assert.ok(measurements <= 10, `原生measureText调用${measurements}次`);
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

function pixelScreen(width, height) {
    const pixels = new Uint32Array(width * height);
    const screen = {
        width, height, pixels, clears: 0, textCalls: 0, writes: 0,
        clear(color) { this.clears++; pixels.fill(color); this.writes += pixels.length; },
        fillRect(x, y, w, h, color) {
            const left = Math.max(0, Math.round(x)), top = Math.max(0, Math.round(y));
            const right = Math.min(width, Math.round(x + w)), bottom = Math.min(height, Math.round(y + h));
            for (let row = top; row < bottom; row++) pixels.fill(color, row * width + left, row * width + right);
            this.writes += Math.max(0, right - left) * Math.max(0, bottom - top);
        },
        measureText(text, style) { return { width: Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 12 : 6), 0) * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
        drawText(text, x, y, style) {
            this.textCalls++;
            const scale = style?.scale || 1;
            for (const ch of text) {
                const w = this.measureText(ch, style).width;
                // 用确定性的字形像素验证新旧字幕清理，不依赖桌面字体安装。
                if (ch !== ' ') this.fillRect(x, y + (ch.charCodeAt(0) % 3) * scale, w - scale, 8 * scale, style?.color || 0);
                x += w;
            }
        },
    };
    return screen;
}

await test('彩边跳过白色遮挡仍与五层全量绘制逐像素一致，实际填充面积显著降低', () => {
    let previousWrites = 0, optimizedWrites = 0, cases = 0;
    for (const shape of model.CAT_SHAPES) for (const scale of [4.4, 7.8, 11]) for (const tilt of [-1, 0, 1]) {
        const expected = pixelScreen(480, 480), actual = pixelScreen(480, 480);
        const view = { ...state.initialState(), state: 'speaking', level: 68 };
        const input = { clock: 1800, tiltX: tilt, tiltY: -tilt, battery: 86, settings: false, shake: 0 };
        const pose = { ...model.poseFor(view.state, input.clock, tilt, -tilt, view.level), shape };
        input.pose = pose;
        const cx = 240 + tilt * 18, cy = 240 - tilt * 12, step = Math.max(2, Math.round(scale));
        const occupancy = new Map();
        for (const point of model.projectCat(pose, scale, cx, cy)) {
            const x = Math.round(point.sx / step) * step, y = Math.round(point.sy / step) * step;
            occupancy.set(`${x},${y}`, { x, y });
        }
        const runs = [];
        for (const point of Array.from(occupancy.values()).sort((a, b) => a.y - b.y || a.x - b.x)) {
            const last = runs.at(-1);
            if (last && last.y === point.y && point.x - last.x - last.width <= step) last.width = point.x + step - last.x;
            else runs.push({ ...point, width: step });
        }
        for (const layer of [{ dx: step, dy: -step, color: 0x2050ef }, { dx: -step, dy: step, color: 0xe31c35 }, { dx: Math.ceil(step / 2), dy: 0, color: 0x17f5f5 }, { dx: -Math.ceil(step / 2), dy: 1, color: 0xf9fb54 }, { dx: 0, dy: 0, color: 0xffffff }]) {
            for (const run of runs) expected.fillRect(run.x + layer.dx, run.y + layer.dy, run.width + 1, step + 1, layer.color);
        }
        for (const voxel of model.facePoints(view.state, input.clock, view.level)) {
            const p = model.projectPoint(model.posedShapePoint(voxel, pose), pose, scale, cx, cy);
            expected.fillRect(Math.round(p.sx / step) * step, Math.round(p.sy / step) * step, step + 1, step + 1, 0x0d1210);
        }
        render.drawCat(actual, view, input, 240, scale);
        assert.deepEqual(actual.pixels, expected.pixels, `${shape} ${scale} ${tilt}`);
        previousWrites += expected.writes; optimizedWrites += actual.writes; cases++;
    }
    assert.ok(optimizedWrites < previousWrites * 0.4);
    console.log(`[指标] ${cases} 个姿态彩边填充像素 ${previousWrites} -> ${optimizedWrites}，减少 ${(100 * (1 - optimizedWrites / previousWrites)).toFixed(1)}%`);
});

await test('06/07连续帧局部刷新与整屏重画逐像素一致，静态字幕不重画', () => {
    for (const [width, height] of [[320, 448], [368, 448], [480, 480]]) for (const harness of [false, true]) {
        const actual = pixelScreen(width, height);
        const view = { ...state.initialState(), connected: true, authenticated: true, state: 'idle', assistantText: '回答会实时显示' };
        const form = { page: 'assistant', returnPage: 'assistant', field: 'account', values: {}, upper: false, symbols: false, busy: false, speechReady: true };
        const draw = (screen, input) => harness ? harnessRender.drawHarness(screen, view, input, form) : render.drawScene(screen, view, input);
        for (let index = 0; index < 36; index++) {
            if (index === 8) { view.assistantText += '，随后继续增长。'; view.userText = '这是新问题'; }
            if (index === 12) view.thinkingText = '检索完成';
            if (index === 15) view.theme = 'light';
            if (index === 18) view.state = 'speaking';
            if (index === 26) view.thinkingText = '';
            if (index === 28) { view.assistantText = ''; view.userText = ''; }
            const input = { clock: index * 47 + 800, tiltX: Math.sin(index / 2), tiltY: Math.cos(index / 3), battery: 86, settings: false, fullscreen: index >= 21, shake: index % 4 === 0 ? 1 : 0 };
            const expected = pixelScreen(width, height);
            draw(expected, input);
            const beforeText = actual.textCalls, beforeWrites = actual.writes;
            draw(actual, input);
            let different = 0;
            for (let pixel = 0; pixel < actual.pixels.length; pixel++) if (actual.pixels[pixel] !== expected.pixels[pixel]) different++;
            assert.equal(different, 0, `${harness ? '07' : '06'} ${width} frame ${index}`);
            if (index === 1) {
                assert.equal(actual.clears, 1);
                assert.equal(actual.textCalls, beforeText);
                assert.ok(actual.writes - beforeWrites < expected.writes, '局部帧减少实际像素写入');
            }
        }
    }
});
await test('页面、配对、账号和输入框变化使静态缓存失效，返回助手无旧页面残影', () => {
    for (const harness of [false, true]) {
        const actual = pixelScreen(480, 480);
        const view = { ...state.initialState(), connected: true, authenticated: true, state: 'idle', phoneName: '测试手机' };
        const form = { page: 'assistant', returnPage: 'assistant', field: 'account', values: { tenant: '企业', account: '账号', password: 'secret', region: 'eastasia', key: 'key', origin: 'https://example.test', oem: '', domain: '', question: '' }, upper: false, symbols: false, busy: false, speechReady: true };
        const input = { clock: 1700, tiltX: 0.4, tiltY: -0.3, battery: 86, settings: false };
        const changes = harness ? [
            () => {}, () => { form.page = 'settings'; }, () => { form.page = 'login'; },
            () => { form.busy = true; }, () => { view.errorText = '登录失败'; },
            () => { form.page = 'editor'; }, () => { form.values.account = '新账号ABC'; form.upper = true; },
            () => { form.page = 'assistant'; view.errorText = ''; },
        ] : [
            () => {}, () => { input.settings = true; }, () => { view.displayName = '新账号'; },
            () => { input.settings = false; view.state = 'pairing'; view.authenticated = false; },
            () => { view.pairingCode = '123456'; }, () => { view.pairingPending = true; },
            () => { view.errorText = '重新连接'; }, () => { view.state = 'idle'; view.authenticated = true; },
        ];
        for (const change of changes) {
            change();
            for (let repeat = 0; repeat < 2; repeat++) {
                const expected = pixelScreen(480, 480);
                const draw = (screen) => harness ? harnessRender.drawHarness(screen, view, input, form) : render.drawScene(screen, view, input);
                draw(expected); draw(actual);
                assert.deepEqual(actual.pixels, expected.pixels, `${harness ? '07' : '06'} 页面 ${form.page} 状态 ${view.state}`);
                input.clock += 61; input.tiltX *= -1;
            }
        }
    }
});

const testPair = { phoneId: '00000000-0000-4000-8000-000000000001', pairKey: 'a'.repeat(64), inputFormat: 'ima_adpcm' };
function runtime(width = 368, height = 448, storage = new Map(), phones = null) {
    let touch;
    let button;
    let exit;
    let frame;
    const screenText = [];
    let screenWrites = 0;
    let now = 1000;
    let micCallback;
    const micCallbacks = [];
    let micStarts = 0;
    let micStops = 0;
    let ended;
    let audioFeeds = 0;
    const audioChunks = [];
    let audioEnds = 0;
    let audioBufferedMs = 0;
    let audioUnderrunMs = 0;
    let audioStarted = false;
    let audioStreamEnded = false;
    const sockets = [];
    const timers = new Map();
    let timerId = 0;
    const intervals = [];
    const sent = [];
    let sendBusy = false;
    let micFrameMs = 0;
    class Socket {
        static OPEN = 1;
        readyState = 1;
        constructor(url) { this.url = url; sockets.push(this); }
        send(raw) { if (sendBusy) throw new Error('WebSocket 发送队列已满'); sent.push(typeof raw === 'string' ? JSON.parse(raw) : raw); }
        close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    }
    const px = {
        system: { info: () => ({ deviceId: 'test-device', capabilities: { mic: true } }), battery: () => ({ level: 86 }), now: () => now },
        storage: { kv: { get: (key) => storage.get(key), set: (key, value) => storage.set(key, value), remove: (key) => storage.delete(key) } },
        wifi: { status: () => ({ connected: true }) },
        net: { mdns: { discover: async () => phones || [{ name: 'Obeing Pixel Phone', ip: '192.168.1.20', port: 18888, txt: { phoneId: testPair.phoneId } }] } },
        audio: {
            encodeImaAdpcm,
            mic: { start(options) { micFrameMs = options.frameMs; micStarts++; micCallback = options.onData; micCallbacks.push(options.onData); }, stop() { micStops++; } },
            player: { openPcmStream: ({ sampleRate }) => {
                audioBufferedMs = 0; audioStarted = false; audioStreamEnded = false;
                return {
                    feed(pcm) { audioFeeds++; audioChunks.push(Buffer.from(pcm)); audioBufferedMs += pcm.byteLength * 1000 / (sampleRate * 2); audioStarted = true; },
                    stop() { audioBufferedMs = 0; audioStarted = false; },
                    buffered: () => audioBufferedMs,
                    end() { audioEnds++; audioStreamEnded = true; },
                    onEnded(cb) { ended = cb; },
                };
            } },
        },
        sensors: { imu: { available: () => false } },
        screen: {
            width, height, setFps() {}, onFrame(cb) { frame = cb; },
            clear() { screenWrites++; screenText.length = 0; }, fillRect() { screenWrites++; },
            measureText: (text, style) => ({ width: text.length * 12 * (style?.scale || 1), height: 12 * (style?.scale || 1) }),
            drawText(text) { screenWrites++; screenText.push(text); },
        },
        input: { onTouch(cb) { touch = cb; }, onButton(cb) { button = cb; } },
        app: { onExit(cb) { exit = cb; } },
    };
    runInNewContext(main.outputFiles[0].text, { px, console: { log() {} }, WebSocket: Socket, ArrayBuffer, Int16Array, setTimeout(cb, delay) { const id = ++timerId; timers.set(id, { cb, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval(cb) { intervals.push(cb); return intervals.length; }, clearInterval() {} });
    return {
        sent, sockets, audioChunks, storage,
        get micFrameMs() { return micFrameMs; },
        busy(value) { sendBusy = value; },
        discover() { intervals[0](); },
        get audioEnds() { return audioEnds; },
        get audioUnderrunMs() { return audioUnderrunMs; },
        get screenWrites() { return screenWrites; },
        get micStarts() { return micStarts; }, get micStops() { return micStops; }, get audioFeeds() { return audioFeeds; },
        touch(x, y) { touch({ type: 'down', x, y }); touch({ type: 'up', x, y }); },
        touchEvent(type, x = width / 2, y = height / 2) { touch({ type, x, y }); },
        button(type) { button({ id: 'boot', type }); },
        open() { sockets.at(-1).onopen(); },
        message(message) { sockets.at(-1).onmessage({ data: message instanceof ArrayBuffer ? message : JSON.stringify(message.type === 'hello.ok' ? { ...testPair, ...message } : message) }); },
        pcm(pcm = new Int16Array([100, -100]).buffer) { micCallback(pcm); },
        oldPcm(index) { micCallbacks[index](new Int16Array([100, -100]).buffer); },
        audioEnded() { ended(); },
        heartbeat() { intervals[1](); },
        frameText() { now += 64; frame(64); return screenText.join('\n'); },
        advance(ms) {
            now += ms;
            if (audioStarted) {
                if (!audioStreamEnded) audioUnderrunMs += Math.max(0, ms - audioBufferedMs);
                audioBufferedMs = Math.max(0, audioBufferedMs - ms);
            }
        },
        flushTimers() { for (const [id, timer] of Array.from(timers)) if (timer.at <= now) { timers.delete(id); timer.cb(); } },
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
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    assert.equal(r.micStarts, 1);
    assert.equal(r.sent.find(x => x.type === 'mic.start').format, 'ima_adpcm');
    r.pcm();
    r.advance(16); r.flushTimers();
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
    r.advance(16); r.flushTimers();
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
    const revokedMessage = revoked.sockets[0].onmessage;
    revoked.message({ type: 'auth.revoked' });
    revokedMessage({ data: JSON.stringify({ type: 'account.state', authenticated: true, accountEpoch: 2 }) });
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
        if (revoke) {
            for (let i = 0; i < 6; i++) r.touch(70, 250);
            r.touch(286, 400);
        }
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
    assert.equal(r.audioFeeds, 0);
    r.message({ type: 'audio.end', turnId: 1 });
    assert.equal(r.audioFeeds, 1);
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
    assert.equal(r.audioFeeds, 0);
    r.message({ type: 'audio.end', turnId: 2 });
    assert.equal(r.audioFeeds, 1);
    r.audioEnded();
    assert.deepEqual(r.sent.filter((m) => m.type === 'audio.played'), [{ type: 'audio.played', turnId: 2 }]);
    r.exit();
});
await test('PCM在256ms音频到达时首播，按顺序保留每个采样及短尾包', async () => {
    for (const sampleRate of [16000, 24000, 48000]) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
        r.message({ type: 'audio.start', turnId: 1, sampleRate, channels: 1, format: 'pcm_s16le' });
        const chunks = [];
        for (let i = 0; i < 10; i++) {
            const pcm = new Int16Array(sampleRate * 32 / 1000).fill(i + 1).buffer;
            chunks.push(Buffer.from(pcm));
            r.advance(i % 3 === 0 ? 55 : 24);
            r.message(pcm);
            r.flushTimers();
            if (i < 7) assert.equal(r.audioFeeds, 0, '首播前保留256ms音频抵御网络与绘制抖动');
            if (i === 7) assert.equal(r.audioChunks[0].byteLength, sampleRate * 2 * 256 / 1000);
        }
        const tail = new Int16Array([123, -456]).buffer;
        chunks.push(Buffer.from(tail)); r.message(tail);
        r.message({ type: 'audio.end', turnId: 1 });
        assert.deepEqual(Buffer.concat(r.audioChunks), Buffer.concat(chunks));
        assert.equal(r.audioEnds, 1);
        assert.equal(r.sent.some(m => m.type === 'audio.played'), false);
        r.audioEnded();
        assert.equal(r.sent.filter(m => m.type === 'audio.played').length, 1);
        r.exit();
    }
});
await test('慢速小包在首块后512ms开播，无需等待audio.end且取消会清理启动任务', async () => {
    for (const cancel of [false, true]) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
        r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
        r.message(new Int16Array(160).fill(234).buffer);
        r.advance(511); r.flushTimers();
        assert.equal(r.audioFeeds, 0);
        if (cancel) r.message({ type: 'audio.cancel', turnId: 1 });
        r.advance(1); r.flushTimers();
        assert.equal(r.audioFeeds, cancel ? 0 : 1);
        assert.equal(r.audioEnds, 0);
        r.exit();
    }
});
await test('128ms音频批次叠加96ms网络抖动仍连续播放', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
    for (let batch = 0; batch < 40; batch++) {
        if (batch) r.advance(128 + (batch % 2 ? 96 : -96));
        r.flushTimers();
        for (let chunk = 0; chunk < 4; chunk++) r.message(new Int16Array(512).fill(batch + 1).buffer);
    }
    r.message({ type: 'audio.end', turnId: 1 });
    assert.equal(r.audioUnderrunMs, 0);
    assert.equal(Buffer.concat(r.audioChunks).length, 40 * 4 * 1024);
    r.exit();
});
await test('播放期间环形缓冲短暂为空仍持续写入，取消清理待播数据', async () => {
    for (const cancel of [false, true]) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
        r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
        r.message(new Int16Array(4096).fill(123).buffer);
        assert.equal(r.audioFeeds, 1);
        r.advance(1000);
        r.message(new Int16Array(512).fill(456).buffer);
        assert.equal(r.audioFeeds, 2, '播放期间不能因瞬时空缓冲重新等待256ms');
        if (cancel) r.message({ type: 'audio.cancel', turnId: 1 });
        else r.message({ type: 'audio.end', turnId: 1 });
        r.advance(512); r.flushTimers();
        assert.equal(r.audioFeeds, 2);
        r.exit();
    }
});
await test('播报低缓冲让出三维绘制，余量充足及网络结束后恢复画面', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.frameText();
    const before = r.screenWrites;
    r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
    r.frameText();
    assert.equal(r.screenWrites, before, '首音频未到时不占用收包线程');
    for (let i = 0; i < 16; i++) r.message(new Int16Array(512).buffer);
    r.frameText();
    assert.ok(r.screenWrites > before, '512ms余量时继续播报动画');
    const animated = r.screenWrites;
    r.advance(192);
    r.frameText();
    assert.equal(r.screenWrites, animated, '余量降到320ms时优先接收后续音频');
    r.message({ type: 'audio.end', turnId: 1 });
    r.frameText();
    assert.ok(r.screenWrites > animated, '已无后续音频时不冻结画面');
    r.exit();
});
await test('short and empty replies finish without waiting for the startup threshold', async () => {
    for (const samples of [0, 160]) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
        r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
        const pcm = new Int16Array(samples).fill(456).buffer;
        r.message(pcm);
        assert.equal(r.audioFeeds, 0);
        r.message({ type: 'audio.end', turnId: 1 });
        assert.deepEqual(Buffer.concat(r.audioChunks), Buffer.from(pcm));
        assert.equal(r.audioEnds, 1);
        r.message(new Int16Array([789]).buffer);
        assert.deepEqual(Buffer.concat(r.audioChunks), Buffer.from(pcm));
        r.audioEnded();
        assert.ok(r.sent.some(m => m.type === 'audio.played' && m.turnId === 1));
        r.exit();
    }
});
await test('cancel, mute, disconnect and account changes discard pending startup PCM', async () => {
    for (const action of ['cancel', 'mute', 'disconnect', 'account', 'exit']) {
        const r = await pairedRuntime();
        r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
        r.message({ type: 'audio.start', turnId: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' });
        r.message(new Int16Array(512).fill(123).buffer);
        if (action === 'cancel') r.message({ type: 'audio.cancel', turnId: 1 });
        if (action === 'mute') r.button('doubleClick');
        if (action === 'disconnect') r.sockets[0].close();
        if (action === 'account') r.message({ type: 'account.state', authenticated: true, accountEpoch: 2 });
        if (action === 'exit') r.exit();
        if (action !== 'disconnect' && action !== 'exit') r.message({ type: 'audio.end', turnId: 1 });
        else assert.equal(r.sockets[0].onmessage, null);
        r.audioEnded();
        assert.equal(r.audioFeeds, 0, action);
        assert.equal(r.audioEnds, 0, action);
        assert.equal(r.sent.some(m => m.type === 'audio.played'), false, action);
        if (action !== 'exit') r.exit();
    }
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
    assert.ok(Math.abs(tilted.yaw - neutral.yaw - 1.2) < 1e-8, 'IMU bypasses in-progress morph');
    assert.ok(Math.abs(tilted.pitch - neutral.pitch + 0.6) < 1e-8);
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
        if (fullscreen) assert.ok(texts.every(t => t.y >= height - 145), '全屏底部保留状态行及对话字幕');
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
await test('采音 128ms 分包，暂时发送队列满重试且 PCM 顺序和内容不丢失', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    assert.equal(r.micFrameMs, 128);
    r.busy(true);
    const chunks = Array.from({ length: 8 }, (_, i) => new Uint8Array(4096).fill(i).buffer);
    for (const chunk of chunks) r.pcm(chunk);
    r.advance(16); r.flushTimers();
    assert.equal(r.sockets[0].readyState, 1);
    const writes = r.screenWrites;
    r.frameText();
    assert.equal(r.screenWrites, writes, '上行积压时先发送音频，再绘制');
    r.busy(false);
    for (let i = 0; i < 3; i++) { r.advance(16); r.flushTimers(); }
    assert.deepEqual(r.sent.filter(x => x instanceof ArrayBuffer).map(x => Buffer.from(x)), chunks.map(x => Buffer.from(encodeImaAdpcm(x))));
    assert.equal(r.sockets[0].readyState, 1);
    r.exit();
});
await test('切账号丢弃待重试旧 PCM，新账号 ACK 先于新音频', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.busy(true); r.pcm(new Uint8Array(4096).fill(1).buffer);
    r.advance(16); r.flushTimers();
    r.message({ type: 'account.state', authenticated: true, accountEpoch: 2 });
    r.pcm(new Uint8Array(4096).fill(2).buffer);
    r.busy(false); r.advance(16); r.flushTimers();
    const audio = r.sent.filter(x => x instanceof ArrayBuffer);
    assert.equal(audio.length, 1); assert.deepEqual(Buffer.from(audio[0]), Buffer.from(encodeImaAdpcm(new Uint8Array(4096).fill(2))));
    assert.ok(r.sent.findIndex(x => x.type === 'account.ready' && x.accountEpoch === 2) < r.sent.indexOf(audio[0]));
    r.exit();
});
await test('TCP 背压超过旧的五秒门限仍保留连接，永久堵塞最终有界断开', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.busy(true);
    r.pcm(new ArrayBuffer(4096));
    r.advance(16); r.flushTimers();
    r.advance(6000); r.flushTimers();
    assert.equal(r.sockets[0].readyState, 1, '应允许原生 TCP 等待恢复');
    r.busy(false); r.advance(16); r.flushTimers();
    assert.equal(r.sent.filter(x => x instanceof ArrayBuffer).length, 1);
    r.busy(true); r.pcm(new ArrayBuffer(4096));
    r.advance(16); r.flushTimers();
    r.advance(15000); r.flushTimers();
    assert.equal(r.sockets[0].readyState, 3, '永久不可写必须最终释放连接');
    r.exit();
});
await test('首次配对保存凭据，掉线和应用重启均自动恢复且不需要配对码', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: false, accountEpoch: 5 });
    r.sockets[0].close();
    r.advance(1000); r.discover(); await new Promise(setImmediate);
    assert.equal(r.sockets.length, 2); r.open();
    const hello = r.sent.at(-1);
    assert.equal(hello.pairCode, undefined); assert.equal(hello.pairKey, testPair.pairKey);
    r.message({ type: 'hello.ok', authenticated: false, accountEpoch: 0 });
    r.exit();
    const reboot = runtime(368, 448, r.storage);
    await new Promise(setImmediate); assert.equal(reboot.sockets.length, 1); reboot.open();
    assert.equal(reboot.sent[0].pairKey, testPair.pairKey);
    reboot.exit();
});
await test('只重连同一手机，手动断开暂停自动重连，点击后恢复', async () => {
    const storage = new Map([['ob.pairing', JSON.stringify(testPair)]]);
    const other = runtime(368, 448, storage, [{ name: 'Other', ip: '192.168.1.21', port: 12, txt: { phoneId: 'other' } }]);
    await new Promise(setImmediate); assert.equal(other.sockets.length, 0); other.exit();
    const r = runtime(368, 448, storage); await new Promise(setImmediate); r.open();
    r.message({ type: 'hello.ok', authenticated: false, accountEpoch: 0 });
    r.touch(340, 48); r.touch(180, 360);
    r.advance(20000); r.discover(); await new Promise(setImmediate);
    assert.equal(r.sockets.length, 1);
    r.touch(180, 160); await new Promise(setImmediate);
    assert.equal(r.sockets.length, 2); r.exit();
});
await test('手机撤销或离线忘记设备后清除恢复凭据，回到配对码界面', async () => {
    for (const message of [{ type: 'auth.revoked' }, { type: 'error', code: 'pair_expired' }]) {
        const r = runtime(368, 448, new Map([['ob.pairing', JSON.stringify(testPair)]]));
        await new Promise(setImmediate); r.open();
        if (message.type === 'auth.revoked') r.message({ type: 'hello.ok', authenticated: false, accountEpoch: 1 });
        r.message(message); r.advance(2000); r.discover(); await new Promise(setImmediate);
        assert.equal(r.storage.has('ob.pairing'), false);
        assert.equal(r.sockets.length, 1);
        assert.ok(r.frameText().includes('手机配对码'));
        r.exit();
    }
});
await test('媒体积压暂停采音并重建识别，保持设备连接和配对', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.busy(true);
    for (let i = 0; i < 16; i++) r.pcm(new ArrayBuffer(4096));
    assert.equal(r.sockets[0].readyState, 1);
    assert.ok(r.storage.has('ob.pairing'));
    assert.equal(r.micStops, 1);
    assert.ok(r.frameText().includes('网络拥堵'));
    r.busy(false); r.advance(16); r.flushTimers();
    assert.deepEqual(r.sent.slice(-2).map(x => x.type), ['mic.stop', 'mic.start']);
    assert.equal(r.sent.filter(x => x instanceof ArrayBuffer).length, 0, '不把残缺旧音频继续送入识别');
    r.message({ type: 'state', state: 'muted' });
    assert.equal(r.micStarts, 1, '重置中间回执不能提前重开麦克风');
    r.message({ type: 'state', state: 'idle' });
    assert.equal(r.micStarts, 2);
    r.pcm(); r.advance(16); r.flushTimers();
    assert.ok(r.sent.at(-1) instanceof ArrayBuffer);
    assert.equal(r.sockets.length, 1);
    r.exit();
});
await test('语音恢复时用户手动静音仍优先，迟到 idle 不能重开麦克风', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.busy(true);
    for (let i = 0; i < 16; i++) r.pcm(new ArrayBuffer(4096));
    r.button('doubleClick');
    r.busy(false); r.advance(16); r.flushTimers();
    r.message({ type: 'state', state: 'muted' });
    r.message({ type: 'state', state: 'idle' });
    assert.equal(r.micStarts, 1);
    assert.equal(r.sockets[0].readyState, 1);
    r.exit();
});

await test('Kitty保留选定版本的头像、完整身体和配件，各图纸眼位有效', () => {
    // 尺寸和豆数来自改半身前的原始网格提取，女巫包含整把扫帚及侧坐身体。
    const originals = { 'kitty-classic': [42, 34], 'kitty-witch': [46, 47, 1092], 'kitty-fish': [30, 23, 450], 'kitty-scarf': [21, 22, 284] };
    for (const [character, pattern] of Object.entries(KITTY_PATTERNS)) {
        assert.ok(pattern.rows.every(row => row.length === pattern.rows[0].length));
        assert.ok(Array.from(pattern.rows.join('')).every(pixel => pixel === '.' || pixel in KITTY_PALETTE));
        const original = originals[character];
        if (original) {
            assert.deepEqual([pattern.rows[0].length, pattern.rows.length], original.slice(0, 2), `${character}: 恢复原图范围，不截身体或追加胸部`);
            if (original[2]) assert.equal(pattern.rows.join('').replaceAll('.', '').length, original[2], `${character}: 完整保留原图豆数`);
        }
        for (const eye of pattern.eyes) for (let y = eye.y; y < eye.y + eye.height; y++) for (let x = eye.x; x < eye.x + eye.width; x++) {
            assert.equal(pattern.rows[y][x], '#', `${character}眼睛坐标必须落在原图黑豆上`);
        }
    }
});

await test('Kitty正面严格等比还原图纸，语音挤压不拉伸脸型且闭眼只改变眼睛', () => {
    const background = 0xabcdef;
    for (const character of Object.keys(KITTY_PATTERNS)) for (const scale of [4.4, 11, 14]) {
        const pattern = KITTY_PATTERNS[character];
        let left = 100, top = 100, right = 0, bottom = 0;
        pattern.rows.forEach((row, y) => Array.from(row).forEach((pixel, x) => {
            if (pixel === '.') return;
            left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
        }));
        const screen = pixelScreen(368, 448);
        screen.clear(background);
        const pose = { yaw: 0, pitch: 0, lift: 0, squash: 1 };
        kitty.drawKitty(screen, character, 'idle', 1700, pose, 184, 210, scale, { top: 83, bottom: 342 });
        const occupied = [];
        screen.pixels.forEach((pixel, i) => { if (pixel !== background) occupied.push(i); });
        const x0 = Math.min(...occupied.map(i => i % 368)), y0 = Math.floor(occupied[0] / 368);
        const x1 = Math.max(...occupied.map(i => i % 368)) + 1, y1 = Math.floor(occupied.at(-1) / 368) + 1;
        const step = (x1 - x0) / (right - left);
        assert.ok(Number.isInteger(step) && step > 0, '宽度必须按整格放大');
        assert.equal(y1 - y0, (bottom - top) * step, `${character}宽高缩放必须相同`);
        const expected = pixelScreen(368, 448); expected.clear(background);
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
            const pixel = pattern.rows[y][x];
            if (pixel !== '.') expected.fillRect(x0 + (x - left) * step, y0 + (y - top) * step, step, step, KITTY_PALETTE[pixel]);
        }
        assert.deepEqual(screen.pixels, expected.pixels, `${character}实际渲染逐格还原源图`);
        for (const squash of [0.92, 1.08]) {
            const speaking = pixelScreen(368, 448); speaking.clear(background);
            kitty.drawKitty(speaking, character, 'speaking', 1700, { ...pose, squash }, 184, 210, scale, { top: 83, bottom: 342 });
            assert.deepEqual(speaking.pixels, expected.pixels, '只改变小猫挤压参数不能拉伸Kitty');
        }
        const sleeping = pixelScreen(368, 448); sleeping.clear(background);
        kitty.drawKitty(sleeping, character, 'sleep', 1700, pose, 184, 210, scale, { top: 83, bottom: 342 });
        const changed = sleeping.pixels.reduce((n, pixel, i) => n + (pixel !== expected.pixels[i] ? 1 : 0), 0);
        assert.equal(changed, pattern.eyes.reduce((n, eye) => n + eye.width * (eye.height - 1), 0) * step * step);
    }
});

await test('角色长按边界、拖动取消、延迟调度、换页和退出均不误触发短按', async () => {
    const bundle = await build({ entryPoints: [join(source, 'characters.ts')], bundle: true, format: 'iife', globalName: 'Characters', write: false });
    let now = 0, timerId = 0, taps = 0, holds = 0, active = true;
    const timers = new Map();
    const { CharacterTouch } = runInNewContext(bundle.outputFiles[0].text + '; Characters', {
        setTimeout(cb, ms) { const id = ++timerId; timers.set(id, { cb, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
    });
    const gesture = new CharacterTouch(() => now, () => active, () => taps++, () => holds++);
    const event = (type, x = 100, y = 100, hit = true) => gesture.handle({ type, x, y }, hit);
    const advance = ms => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.cb(); } };
    assert.equal(event('down', 0, 0, false), false);
    event('down'); advance(699); assert.equal(taps + holds, 0); event('up'); assert.equal(taps, 1);
    event('down'); advance(700); assert.equal(holds, 1); advance(3000); event('up'); event('up');
    assert.equal(holds, 1); assert.equal(taps, 1, '持续长按和松手都不能重复触发');
    event('down'); event('move', 120); event('move'); advance(700); event('up');
    assert.equal(holds + taps, 2, '滑出再滑回也不换装或开麦');
    event('down'); now += 800; event('up'); assert.equal(holds, 2, '繁忙时松手补判长按');
    event('down'); active = false; advance(700); event('up'); active = true;
    event('down'); gesture.cancel(); advance(700); event('up');
    assert.equal(timers.size, 0); assert.equal(taps, 1); assert.equal(holds, 2);
    assert.equal(characters.readCharacter('invalid'), 'cat');
    assert.equal(characters.readCharacter(null), 'cat');
    assert.deepEqual(characters.CHARACTERS, ['cat', 'kitty-classic', 'kitty-witch', 'kitty-fish', 'kitty-scarf']);
    for (const removed of ['kitty-strawberry', 'kitty-pajamas']) {
        assert.equal(characters.readCharacter(removed), 'cat', '旧存储的已删除角色回退默认小猫');
        assert.ok(!(removed in KITTY_PATTERNS));
    }
    assert.equal(characters.nextCharacter('kitty-scarf'), 'cat');
});

await test('06真实入口长按循环全部形象、保存恢复、普通/全屏短按与BOOT退出清理', async () => {
    const r = await pairedRuntime();
    r.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    r.frameText();
    const before = r.sent.filter(m => m.type === 'listen').length;
    const starts = r.micStarts;
    for (const character of characters.CHARACTERS.slice(1)) {
        r.touchEvent('down', 184, 215); r.advance(699); r.flushTimers();
        assert.notEqual(r.storage.get('ob.character'), character);
        r.advance(1); r.flushTimers();
        assert.equal(r.storage.get('ob.character'), character);
        r.advance(800); r.flushTimers(); r.touchEvent('up', 184, 215);
        assert.equal(r.sent.filter(m => m.type === 'listen').length, before);
        assert.equal(r.micStarts, starts, '换装不改变采音生命周期');
        assert.ok(!r.frameText().includes('长按换装'));
    }
    const saved = r.storage;
    r.exit();
    const restored = runtime(368, 448, saved);
    await new Promise(setImmediate); restored.open();
    restored.message({ type: 'hello.ok', authenticated: true, accountEpoch: 1 });
    assert.ok(!restored.frameText().includes('长按换装'));
    assert.equal(saved.get('ob.character'), 'kitty-scarf');
    restored.touch(337, 24); restored.frameText();
    restored.touchEvent('down', 184, 215); restored.advance(700); restored.flushTimers(); restored.touchEvent('up', 184, 215);
    assert.equal(saved.get('ob.character'), 'cat');
    restored.frameText();
    restored.touchEvent('down', 184, 215);
    assert.equal(restored.sent.filter(m => m.type === 'listen').length, 0);
    restored.advance(100); restored.touchEvent('up', 184, 215);
    assert.equal(restored.sent.filter(m => m.type === 'listen').length, 1, '短按仅在松手时开始语音');
    restored.touchEvent('down', 184, 215); restored.button('longPress'); restored.advance(700); restored.flushTimers(); restored.touchEvent('up', 184, 215);
    assert.equal(saved.get('ob.character'), 'cat', 'BOOT切页取消角色长按');
    restored.button('longPress'); restored.frameText(); restored.touchEvent('down', 184, 215);
    restored.exit(); restored.advance(700); restored.flushTimers();
    assert.equal(saved.get('ob.character'), 'cat', '应用退出清除长按定时器');
});

await test('06/07全部形象切换、眨眼和倾斜的增量绘制与整屏重绘逐像素一致', () => {
    const form = { page: 'assistant' };
    for (const harness of [false, true]) for (const width of [320, 368, 480]) for (const theme of ['dark', 'light']) for (const fullscreen of [false, true]) {
        const height = width === 480 ? 480 : 448;
        const view = { ...state.initialState(), state: 'idle', authenticated: true, connected: true, theme };
        const incremental = pixelScreen(width, height);
        const draw = (screen, input) => harness ? harnessRender.drawHarness(screen, view, input, form) : render.drawScene(screen, view, input);
        const fingerprints = new Set();
        for (const character of [...characters.CHARACTERS, 'cat']) for (const tilt of [0, -1, 1]) {
            for (const clock of [100, 1700]) {
                const fresh = pixelScreen(width, height);
                const input = { character, clock, tiltX: tilt, tiltY: -tilt, battery: 86, settings: false, fullscreen };
                draw(incremental, input); draw(fresh, input);
                assert.deepEqual(incremental.pixels, fresh.pixels, `${harness ? '07' : '06'} ${character} ${width} ${theme} ${fullscreen} ${tilt} ${clock}`);
                if (!tilt && clock === 1700) fingerprints.add(Buffer.from(fresh.pixels.buffer).toString('base64'));
                if (character !== 'cat') {
                    assert.ok(fresh.pixels.filter(p => p === 0xffffff).length > 1000, 'Kitty白色脸部可见');
                    assert.ok(fresh.pixels.includes(KITTY_PALETTE.N) || fresh.pixels.includes(KITTY_PALETTE.y), `${character} ${width} ${tilt}: Kitty黄色鼻子可见`);
                }
            }
        }
        assert.equal(fingerprints.size, characters.CHARACTERS.length, '全部形象确实绘制不同像素');
    }
});

await test('06/07放大Kitty无越界，字幕伸缩无残影，仅保留唤醒词、状态与对话进度', () => {
    for (const harness of [false, true]) for (const width of [320, 368, 480]) for (const fullscreen of [false, true]) for (const character of characters.CHARACTERS) {
        const height = width === 480 ? 480 : 448;
        const incremental = pixelScreen(width, height);
        const input = { character, fullscreen, clock: 1700, tiltX: 0, tiltY: 0, battery: 86, settings: false,
            pose: { yaw: 0, pitch: 0, lift: 0, squash: 1 } };
        const stages = [
            { state: 'idle' },
            { state: 'sleep' },
            { state: 'listening' },
            { state: 'thinking', thinkingText: '查询天气' },
            { state: 'thinking', thinkingText: '查询天气', userText: '今天出门需要带伞吗？' },
            { state: 'speaking', thinkingText: '天气查询完成', userText: '今天出门需要带伞吗？', assistantText: '今天下午有雨，出门记得带伞。明天恢复晴天，可以安排户外活动。' },
            { state: 'speaking', assistantText: '带伞。' },
            { state: 'idle' },
        ];
        for (const stage of stages) {
            const view = { ...state.initialState(), authenticated: true, connected: true, ...stage };
            const fresh = pixelScreen(width, height), texts = [], white = [];
            const fill = fresh.fillRect, write = fresh.drawText;
            fresh.fillRect = function(x, y, w, h, color) {
                assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height, `${character}绘制越界`);
                if (character === 'cat' ? color === 0xffffff : Object.values(KITTY_PALETTE).includes(color)) white.push({ x, y, w, h });
                fill.call(this, x, y, w, h, color);
            };
            fresh.drawText = function(value, x, y, style) {
                if (value) texts.push({ value, x, y, ...this.measureText(value, style) });
                write.call(this, value, x, y, style);
            };
            const draw = screen => harness ? harnessRender.drawHarness(screen, view, input, { page: 'assistant' }, '小爱同学') : render.drawScene(screen, view, input);
            draw(fresh); draw(incremental);
            assert.deepEqual(incremental.pixels, fresh.pixels, `${harness ? '07' : '06'} ${character} ${width} ${fullscreen} ${JSON.stringify(stage)} 字幕伸缩残影`);
            assert.ok(texts.every(t => !/长按换装|在这里陪你|像素小猫|Kitty/.test(t.value)));
            const status = stage.thinkingText || ({ idle: harness ? '小爱同学' : '你好小川', sleep: harness ? '小爱同学' : '你好小川', listening: '正在聆听', speaking: '小川正在回答' })[stage.state];
            assert.ok(texts.some(t => t.value === status), `${character} ${stage.state} 缺少状态提示 ${status}`);
            for (const box of white) for (const t of texts) {
                assert.ok(box.x + box.w <= t.x || box.x >= t.x + t.width || box.y + box.h <= t.y || box.y >= t.y + t.height, `${character}身体覆盖字幕`);
            }
            if (character !== 'cat' && stage.state === 'idle') {
                // 按实际可用区域验证至少一个方向填满八成，扣除顶部控件及底部状态/波形。
                const bodyWidth = Math.max(...white.map(b => b.x + b.w)) - Math.min(...white.map(b => b.x));
                const bodyHeight = Math.max(...white.map(b => b.y + b.h)) - Math.min(...white.map(b => b.y));
                const layoutScale = Math.min(height / 448, width / 320);
                const bodyTop = (fullscreen ? 42 : 83) * layoutScale;
                const bodyBottom = texts.find(t => t.value === status).y - (fullscreen ? 38 : 8) * layoutScale;
                assert.ok(bodyWidth >= (width - 16 * layoutScale) * 0.8 || bodyHeight >= (bodyBottom - bodyTop) * 0.8, `${character}主体过小 ${bodyWidth}×${bodyHeight}`);
            }
        }
    }
});

console.log(`\nObeing Pixel 验证通过：${passed} 项`);
