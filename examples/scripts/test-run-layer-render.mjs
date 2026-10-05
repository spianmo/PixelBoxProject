import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = new URL('./fixtures/run-layer-render.json', import.meta.url);
const source = `
export { drawHarness } from './examples/07-obeing-harness/src/render';
export { CatMotion } from './examples/06-obeing-pixel/src/model';
export { initialState } from './examples/06-obeing-pixel/src/state';
`;
const bundle = await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', target: 'es2020' });
const { drawHarness, CatMotion, initialState } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function surface(width, height) {
    const pixels = new Uint32Array(width * height);
    const screen = { width, height, pixels,
        clear(color = 0) { pixels.fill(color); },
        fillRect(x, y, w, h, color) {
            const left = Math.max(0, x), top = Math.max(0, y);
            const right = Math.min(width, x + w), bottom = Math.min(height, y + h);
            if (right <= left || bottom <= top) return;
            for (let row = top; row < bottom; row++) pixels.fill(color, row * width + left, row * width + right);
        },
        fillRects(rects, count = rects.length / 5) {
            for (let i = 0; i < count; i++) screen.fillRect(...rects.subarray(i * 5, i * 5 + 5));
        },
        drawText(text, x, y, style) {
            const scale = style?.scale || 1;
            for (const [index, character] of Array.from(text).entries()) {
                const code = character.codePointAt(0);
                for (let bit = 0; bit < 12; bit++) if (code & (1 << bit))
                    screen.fillRect(x + (index * 6 + bit % 3) * scale, y + Math.floor(bit / 3) * scale, scale, scale, style?.color ?? 0xffffff);
            }
        },
        measureText(text, style) { return { width: Array.from(text).length * 6 * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
    };
    return screen;
}

function renderFrames(makeSurface, onFrame, dimensions = [[320, 448], [368, 448], [480, 480]]) {
    const form = { page: 'assistant', returnPage: 'assistant', field: 'question', values: {},
        upper: false, symbols: false, busy: false, speechReady: false };
    const states = ['idle', 'speaking', 'thinking', 'sleep', 'listening', 'wake', 'error', 'muted'];
    // 连续帧同时覆盖主体拟合、彩边、扫描条、背景恢复和 Kitty 阴影。
    for (const [width, height] of dimensions)
    for (const fullscreen of [false, true]) for (const character of ['cat', 'kitty-classic', 'kitty-witch']) {
        const screen = makeSurface(width, height), view = initialState(), motion = new CatMotion(() => .37);
        Object.assign(view, { connected: true, authenticated: true });
        for (let i = 0; i < 48; i++) {
            const clock = i * 257, tiltX = Math.sin(i / 6), tiltY = Math.cos(i / 9);
            view.state = states[Math.floor(i / 3) % states.length]; view.level = i * 7 % 100;
            view.theme = i < 24 ? 'dark' : 'light';
            const pose = motion.sample(view.state, clock, tiltX, tiltY, view.level);
            const input = { clock, tiltX, tiltY, battery: 80, settings: false, fullscreen,
                character, shake: [0, .2, .6, 1][i % 4], pose };
            drawHarness(screen, view, input, form);
            onFrame(screen, view, input, form, { width, height, fullscreen, character, frame: i });
        }
    }
}

const nativeOutput = process.argv.find(value => value.startsWith('--native-out='))?.slice('--native-out='.length);
if (nativeOutput) {
    const requestedSize = process.argv.find(value => value.startsWith('--native-size='))?.slice('--native-size='.length);
    const dimensions = [[320, 448], [368, 448], [480, 480]].filter(size => !requestedSize || size.join('x') === requestedSize);
    assert.ok(dimensions.length, 'native-size 只支持 320x448、368x448、480x480');
    const expectedFrames = dimensions.length * 288;
    const program = `${source.replaceAll('export {', 'import {')}
${surface.toString()}
${renderFrames.toString()}
let frames = 0, runCalls = 0, restoredCalls = 0, rectCalls = 0, fillCalls = 0, faceProjectCalls = 0;
const util = { ...native, projectPoints(...args) { faceProjectCalls++; return native.projectPoints(...args); } };
delete globalThis.px;
renderFrames((width, height) => {
    const reference = surface(width, height), optimized = surface(width, height);
    optimized.fillRects = (rects, count = rects.length / 5) => {
        fillCalls++;
        return native.fillRects(optimized.pixels, width, height, rects, count);
    };
    optimized.fillRunLayers = (runs, options) => {
        runCalls++;
        return native.fillRunLayers(optimized.pixels, width, height, runs, options).bounds;
    };
    if (typeof native.fillRunLayersRestored === 'function') optimized.fillRunLayersRestored = (runs, options, restore) => {
        restoredCalls++;
        return native.fillRunLayersRestored(optimized.pixels, width, height, runs, options, restore).bounds;
    };
    optimized.fillRectLayers = (rects, options) => {
        rectCalls++;
        native.fillRectLayers(optimized.pixels, width, height, rects, options);
    };
    reference.optimized = optimized;
    return reference;
}, (reference, view, input, form, metadata) => {
    const optimized = reference.optimized;
    // 原图完全走 JS，优化图同时启用真实原生投影和 Canvas 批处理。
    globalThis.px = { util };
    try { drawHarness(optimized, view, input, form); }
    finally { delete globalThis.px; }
    for (let i = 0; i < reference.pixels.length; i++)
        if (reference.pixels[i] !== optimized.pixels[i])
            throw new Error('native/helper pixels differ: ' + JSON.stringify(metadata) + ' pixel=' + i);
    frames++;
}, ${JSON.stringify(dimensions)});
if (frames !== ${expectedFrames} || !runCalls || !rectCalls || !fillCalls || !faceProjectCalls) throw new Error('incomplete native render coverage');
if (typeof native.fillRunLayersRestored === 'function' && !restoredCalls) throw new Error('missing fused background coverage');
print(JSON.stringify({frames,runCalls,restoredCalls,rectCalls,fillCalls,faceProjectCalls}));
`;
    await build({ stdin: { contents: program, resolveDir: root, loader: 'ts' }, bundle: true,
        format: 'iife', target: 'es2020', outfile: nativeOutput });
    console.log(`生成 ${nativeOutput}，覆盖 ${expectedFrames} 帧原生投影与 Canvas/模拟器逐像素对照`);
} else {
const snapshots = [];
renderFrames(surface, (screen, _view, _input, _form, metadata) => {
    snapshots.push({ ...metadata, sha256: createHash('sha256').update(new Uint8Array(screen.pixels.buffer)).digest('hex') });
});
if (process.argv.includes('--record-baseline')) {
    writeFileSync(fixture, JSON.stringify(snapshots, null, 2) + '\n');
    console.log(`记录重构前 ${snapshots.length} 帧逐像素 SHA256 基线`);
} else {
    const expected = JSON.parse(readFileSync(fixture, 'utf8'));
    assert.deepEqual(snapshots, expected, '原生批处理接入改变了角色画面或背景恢复');
    console.log(`${snapshots.length} 帧小猫/Kitty 与重构前画面逐像素 SHA256 完全一致`);
}
}
