import { CAT_SHAPES, CatMotion, prepareCat } from '../06-obeing-pixel/src/model';
import { initialState } from '../06-obeing-pixel/src/state';
import { drawHarness, type FormState } from './src/render';

// 复用 example07 的真实绘制路径，使用本地状态避免性能测试触发云端登录。
const screen = px.screen;
const view = initialState();
Object.assign(view, { connected: true, authenticated: true, state: 'idle' });
const form: FormState = { page: 'assistant', returnPage: 'assistant', field: 'question',
    values: { tenant: '', account: '', password: '', region: '', key: '', origin: '', oem: '', domain: '', question: '' },
    upper: false, symbols: false, busy: false, speechReady: false };
const motion = new CatMotion();
let clock = 0, sample = false, lastPresented = 0, ready = false, measuring = false, warmShape = 0;
let config = { fullscreen: false, tilt: 0, character: 'cat', state: 'idle', profile: true };
const timings: Record<string, number[]> = { interval: [], draw: [], flush: [], project: [], faceProject: [], bounds: [], blend: [], rect: [] };
let started = 0, frames = 0, warming = 0;
const readFramebuffer = () => typeof (screen as any).frameStats === 'function' ? (screen as any).frameStats() : null;
let framebufferStart: ReturnType<typeof readFramebuffer> = null;
const record = (name: string, value: number) => { if (sample && measuring && timings[name].length < 4096) timings[name].push(value); };
const profilers: { object: any; key: string; fn: any; wrapped: any }[] = [];
const wrap = (object: any, key: string, name: string) => {
    const fn = object[key];
    if (typeof fn !== 'function') return;
    const wrapped = function(this: any, ...args: any[]) {
        const at = performance.now();
        const result = fn.apply(this, args);
        record(name, performance.now() - at);
        return result;
    };
    profilers.push({ object, key, fn, wrapped });
    object[key] = wrapped;
};
wrap(px.util, 'projectPointRuns', 'project');
wrap(px.util, 'projectPoints', 'faceProject');
wrap(px.util, 'projectPointBounds', 'bounds');
wrap(px.util, 'blendPoints', 'blend');
wrap(screen, 'fillRects', 'rect');
wrap(screen, 'fillRunLayers', 'rect');
wrap(screen, 'fillRunLayersRestored', 'rect');
wrap(screen, 'fillRectLayers', 'rect');
const flush = screen.flush;
screen.flush = (knownClean = false) => {
    const at = config.profile ? performance.now() : 0; (flush as any).call(screen, knownClean);
    if (!sample) return;
    ready = true;
    if (!measuring) return;
    // 正式帧率测量关闭分项插桩，只保留成功绘制数和原生提交计数。
    if (!config.profile) { frames++; return; }
    const end = performance.now();
    record('flush', end - at);
    if (lastPresented) record('interval', end - lastPresented);
    lastPresented = end; frames++;
};
const summary = (values: number[]) => {
    if (!values.length) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
    const sorted = values.slice().sort((a, b) => a - b);
    return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
        p50: sorted[Math.floor((sorted.length - 1) * 0.5)], p95: sorted[Math.floor((sorted.length - 1) * 0.95)], max: sorted[sorted.length - 1] };
};
(globalThis as any).__fps = {
    configure(next: Partial<typeof config>) {
        config = { ...config, ...next }; view.state = config.state as any;
        for (const item of profilers) item.object[item.key] = config.profile ? item.wrapped : item.fn;
        sample = false; ready = false; measuring = false; warming = 0;
    },
    reset() {
        if (!ready) throw new Error('benchmark is still warming');
        for (const name in timings) timings[name].length = 0;
        frames = 0; lastPresented = 0; warming = 0;
        framebufferStart = readFramebuffer(); started = performance.now(); measuring = true;
    },
    snapshot() {
        const framebuffer = readFramebuffer();
        const elapsedMs = measuring ? performance.now() - started : 0;
        const framebufferDelta = framebufferStart && framebuffer && measuring
            ? Object.fromEntries(['frames', 'updates', 'changedPixels', 'convertedPixels', 'conversionMs', 'updateMs', 'errors']
                .map(name => [name, framebuffer[name] - framebufferStart[name]])) : null;
        // 可选传输计数仅诊断分块收益；有效提交FPS始终按整帧updates计算。
        if (framebufferDelta) for (const name of ['transactions', 'transmittedPixels'])
            if (Number.isFinite(framebuffer[name]) && Number.isFinite(framebufferStart[name]))
                framebufferDelta[name] = framebuffer[name] - framebufferStart[name];
        const submittedFps = framebufferDelta && elapsedMs > 0 ? framebufferDelta.updates * 1000 / elapsedMs : null;
        return { config, ready, measuring, elapsedMs, frames, fps: submittedFps, submittedFps,
            callbackFps: elapsedMs > 0 ? frames * 1000 / elapsedMs : 0, warming,
            warmedShapes: warmShape, stats: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, summary(v)])),
            framebuffer, framebufferDelta };
    }
};
prepareCat();
screen.setFps(30);
screen.onFrame(dt => {
    clock += Math.max(0, dt);
    const tiltX = config.tilt * Math.sin(clock / 1300), tiltY = config.tilt * Math.cos(clock / 1700);
    view.level = config.state === 'speaking' ? 50 + 40 * Math.sin(clock / 200) : 0;
    const pose = motion.sample(view.state, clock, tiltX, tiltY, view.level);
    // 分帧预热全部形态，避免随机待机动作在计时阶段再次生成缓存。
    if (config.character === 'cat' && warmShape < CAT_SHAPES.length) {
        if (prepareCat({ ...pose, shape: CAT_SHAPES[warmShape], weights: undefined }, 32)) warmShape++;
        if (warmShape < CAT_SHAPES.length) { sample = false; warming++; return; }
    }
    sample = config.character !== 'cat' || prepareCat(pose, 32);
    if (!sample) { warming++; return; }
    const at = config.profile ? performance.now() : 0;
    drawHarness(screen, view, { clock, tiltX, tiltY, battery: 80, settings: false,
        fullscreen: config.fullscreen, shake: 0, character: config.character as any, pose }, form);
    if (config.profile) record('draw', performance.now() - at);
});
