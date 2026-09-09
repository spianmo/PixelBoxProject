#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 使用真实 render.ts + SDK 中文像素字体，Playwright 依赖通过环境变量指定，不改项目依赖。
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.OBEING_PLAYWRIGHT || 'playwright');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(process.argv[2] || join(root, '06-obeing-pixel', '.artifacts', 'screenshots'));
mkdirSync(output, { recursive: true });
const bundle = await build({
    stdin: { contents: "export { drawScene } from './render'; export { initialState } from './state'; export { CatMotion, poseFor } from './model';", resolveDir: join(root, '06-obeing-pixel', 'src'), loader: 'ts' },
    bundle: true, format: 'iife', globalName: 'Obeing', write: false, target: 'es2020',
});
const font = readFileSync(join(root, '..', 'simulator', 'src', 'renderer', 'src', 'device-sim', 'sandbox', 'fonts', 'fusion-pixel-12px-proportional-zh_hans.otf.woff2')).toString('base64');
const browser = await chromium.launch({ executablePath: process.env.OBEING_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1104, height: 896 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>@font-face{font-family:Pixel;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#ddd;display:grid;grid-template-columns:repeat(3,480px)}canvas{image-rendering:pixelated}</style>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(async () => { await document.fonts.load('12px Pixel'); });
    const results = await page.evaluate(() => {
        const variants = [
            ...['dark', 'light'].flatMap(theme => ['idle', 'listening', 'thinking', 'speaking', 'sleep'].map(state =>
                ({ character: 'cat', state, theme, tiltX: 0, tiltY: 0, clock: 1700 }))),
            ...['kitty-classic', 'kitty-witch', 'kitty-strawberry', 'kitty-pajamas', 'kitty-fish', 'kitty-scarf'].flatMap(character =>
                ['dark', 'light'].flatMap(theme => [false, true].map(fullscreen => ({ character, state: 'idle', theme, fullscreen, tiltX: 0, tiltY: 0, clock: 1700 })))),
            { state: 'idle', shake: 1, theme: 'dark', tiltX: 0.4, tiltY: 0, clock: 1700 },
            ...['idle', 'peek', 'stretch', 'curl', 'sit'].map(shape => ({ state: 'idle', shape, theme: 'dark', tiltX: 0, tiltY: 0, clock: 1700 })),
            ...['idle', 'listening', 'thinking', 'speaking', 'sleep'].map(state => ({ state, fullscreen: true, theme: 'dark', tiltX: 0, tiltY: 0, clock: 1700 })),
            { state: 'idle', theme: 'dark', tiltX: -0.75, tiltY: 0.05, clock: 1700 },
            { state: 'listening', theme: 'light', tiltX: 0.0, tiltY: -0.4, clock: 1700 },
            { state: 'thinking', theme: 'dark', tiltX: 0.85, tiltY: -0.2, clock: 2200 },
            { state: 'speaking', theme: 'light', tiltX: 0.65, tiltY: 0.6, clock: 2600 },
            { state: 'sleep', theme: 'dark', tiltX: -0.2, tiltY: 0.05, clock: 3600 },
            { state: 'pairing', theme: 'light', tiltX: 0.0, tiltY: 0.0, clock: 1700 },
            { state: 'login', theme: 'dark', tiltX: -0.3, tiltY: 0.0, clock: 1700 },
            { state: 'login', theme: 'light', tiltX: 0.3, tiltY: 0.0, clock: 1700 },
            { state: 'idle', settings: true, theme: 'dark', tiltX: -0.3, tiltY: 0.0, clock: 1700 },
            { state: 'login', settings: true, theme: 'light', tiltX: 0.3, tiltY: 0.0, clock: 1700 },
            { state: 'pairing', pairingPending: true, theme: 'dark', tiltX: 0.0, tiltY: 0.0, clock: 1700 },
            { state: 'pairing', pairingPending: true, theme: 'light', tiltX: 0.0, tiltY: 0.0, clock: 1700 },
        ];
        window.renderVariant = (canvas, variant) => {
            const ctx = canvas.getContext('2d');
            const violations = [];
            let calls = 0;
            const width = canvas.width;
            const height = canvas.height;
            const texts = [];
            ctx.font = '12px Pixel';
            ctx.textBaseline = 'top';
            const screen = {
                width, height,
                clear(color) { ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`; ctx.fillRect(0, 0, width, height); },
                fillRect(x, y, w, h, color) {
                    if (x < 0 || x + w > width || y < 0 || y + h > height) violations.push({ x, y, w, h });
                    calls++; ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`; ctx.fillRect(x, y, w, h);
                },
                measureText(text, style) { ctx.font = `${12 * (style?.scale || 1)}px Pixel`; return { width: ctx.measureText(text).width, height: 12 * (style?.scale || 1) }; },
                drawText(text, x, y, style) {
                    const size = this.measureText(text, style);
                    if (x < 0 || x + size.width > width || y < 0 || y + size.height > height) violations.push({ text, x, y });
                    const box = { text, x, y, w: size.width, h: size.height };
                    if (text) { for (const prior of texts) if (x < prior.x + prior.w && x + size.width > prior.x && y < prior.y + prior.h && y + size.height > prior.y) violations.push({ overlap: [prior, box] }); texts.push(box); }
                    ctx.fillStyle = `#${style.color.toString(16).padStart(6, '0')}`;
                    ctx.fillText(text, x, y);
                },
            };
            const authenticated = !['pairing', 'login'].includes(variant.state);
            const view = { ...Obeing.initialState(), ...variant, authenticated, connected: variant.state !== 'pairing', displayName: authenticated ? '小川' : '', enterpriseId: authenticated ? 'OBEING' : '', phoneName: 'Obeing Pixel Phone', pairingCode: '1234', level: 68 };
            if (authenticated && variant.state !== 'sleep' && variant.state !== 'idle') {
                view.userText = '今天适合去公园散步吗？';
                view.thinkingText = variant.state === 'thinking' ? '正在查询天气' : '天气查询已完成';
                view.assistantText = variant.state === 'speaking' ? '今天晴，气温 24°C。很适合散步，记得带水，也可以和我聊聊。' : '';
            }
            Obeing.drawScene(screen, view, { clock: variant.clock, tiltX: variant.tiltX, tiltY: variant.tiltY, battery: 86, settings: variant.settings === true,
                character: variant.character, fullscreen: variant.fullscreen, shake: variant.shake, pose: variant.pose || Obeing.poseFor(view.state, variant.clock, variant.tiltX, variant.tiltY, view.level, variant.shape) });
            const data = ctx.getImageData(0, 0, width, height).data;
            let whitePixels = 0;
            let chromaticPixels = 0;
            for (let y = 45; y < height - 110; y++) for (let x = 15; x < width - 15; x++) {
                const i = (y * width + x) * 4;
                if (data[i] > 248 && data[i + 1] > 248 && data[i + 2] > 248) whitePixels++;
                if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 100) chromaticPixels++;
            }
            return { character: variant.character, state: variant.state, shake: variant.shake, shape: variant.shape, fullscreen: Boolean(variant.fullscreen), theme: variant.theme, settings: variant.settings === true, pending: variant.pairingPending === true, width, height, fontHeight: texts[0]?.h, whitePixels, chromaticPixels, violations, calls, png: canvas.toDataURL() };
        };
        return [368, 320, 480].flatMap((width) => variants.map((variant) => {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = width === 480 ? 480 : 448; document.body.append(canvas);
            return window.renderVariant(canvas, variant);
        }));
    });
    for (const result of results) {
        assert.deepEqual(result.violations, []);
        if (result.fontHeight) assert.equal(result.fontHeight, result.width === 480 ? 24 : 12);
        if (result.state !== 'pairing' || result.pending) {
            assert.ok(result.whitePixels > (result.settings || result.character ? 2000 : 5000), `${result.character || result.state}: 主体不为空`);
            assert.ok(result.chromaticPixels > (result.settings ? 500 : 900), `${result.state}: 参考彩色边缘可见`);
        }
    }
    await page.screenshot({ path: join(output, 'states.png'), fullPage: true });
    const canvases = page.locator('canvas');
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const name = result.settings ? 'connection' : result.pending ? 'pairing-pending' : (result.character === 'cat' ? `cat-${result.state}` : result.character || result.state) + (result.shape ? '-' + result.shape : '') + (result.fullscreen ? '-fullscreen' : '') + (result.shake ? '-shake' : '');
        await canvases.nth(i).screenshot({ path: join(output, `${name}-${result.theme}-${result.width}.png`) });
    }
    const moving = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const before = window.renderVariant(canvas, { state: 'speaking', theme: 'dark', tiltX: -0.8, tiltY: -0.3, clock: 900 }).png;
        const after = window.renderVariant(canvas, { state: 'speaking', theme: 'dark', tiltX: 0.8, tiltY: 0.3, clock: 1350 }).png;
        return before !== after;
    });
    assert.equal(moving, true, 'IMU与说话时钟必须改变实际渲染像素');
    const transition = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 480;
        document.body.append(canvas);
        const motion = new Obeing.CatMotion(() => 0);
        motion.sample('idle', 0, 0, 0, 0);
        const images = [100, 240, 380, 520].map(clock => window.renderVariant(canvas, {
            state: 'listening', theme: 'dark', clock, tiltX: 0, tiltY: 0, fullscreen: true,
            pose: motion.sample('listening', clock, 0, 0, 50),
        }));
        canvas.remove();
        return { distinct: new Set(images.map(i => i.png)).size, violations: images.flatMap(i => i.violations) };
    });
    assert.equal(transition.distinct, 4, 'morph frames must change actual canvas pixels');
    assert.deepEqual(transition.violations, []);
    await page.setViewportSize({ width: 368, height: 448 });
    await page.addStyleTag({ content: 'body{display:block}canvas{display:none}canvas:first-child{display:block}' });
    await page.screenshot({ path: join(output, 'device-368x448.png') });
    // 每行三款造型，同一主题占两行，便于审阅源图比例与真实设备效果。
    const kittyImages = ['light', 'dark'].flatMap(theme => results.filter(result => result.character && result.character !== 'cat' && result.width === 368 && !result.fullscreen && result.theme === theme));
    await page.setViewportSize({ width: 1104, height: 1792 });
    await page.setContent('<style>body{margin:0;display:grid;grid-template-columns:repeat(3,368px)}img{display:block}</style>' + kittyImages.map(result => `<img src="${result.png}">`).join(''));
    await page.screenshot({ path: join(output, 'kitty-collection.png') });
    // 对照用户选定的四款截图，保持相同顺序和368px单屏尺寸。
    const referenceImages = ['kitty-classic', 'kitty-witch', 'kitty-fish', 'kitty-scarf'].map(character =>
        results.find(result => result.character === character && result.width === 368 && !result.fullscreen && result.theme === 'light'));
    await page.setContent('<style>body{margin:0;display:grid;grid-template-columns:repeat(4,368px);background:#eff1f1}img{display:block}</style>' + referenceImages.map(result => `<img src="${result.png}">`).join(''));
    await page.setViewportSize({ width: 1472, height: 448 });
    await page.screenshot({ path: join(output, 'kitty-reference-version.png') });
    const characterImages = ['cat', 'kitty-classic', 'kitty-witch', 'kitty-strawberry', 'kitty-pajamas', 'kitty-fish', 'kitty-scarf'].map(character =>
        results.find(result => result.character === character && result.state === 'idle' && result.width === 368 && !result.fullscreen && result.theme === 'light'));
    await page.setContent('<style>body{margin:0;display:grid;grid-template-columns:repeat(4,368px);background:#eff1f1}img{display:block}</style>' + characterImages.map(result => `<img src="${result.png}">`).join(''));
    await page.setViewportSize({ width: 1472, height: 896 });
    await page.screenshot({ path: join(output, 'character-collection.png') });
    console.log(JSON.stringify({ output, count: results.length, moving, transition, violations: results.reduce((n, r) => n + r.violations.length, 0) }));
} finally { await browser.close(); }
