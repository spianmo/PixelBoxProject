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
const output = resolve(process.argv[2] || join(root, '06-obeing-pixel', 'dist', 'screenshots'));
mkdirSync(output, { recursive: true });
const bundle = await build({
    stdin: { contents: "export { drawScene } from './render'; export { initialState } from './state';", resolveDir: join(root, '06-obeing-pixel', 'src'), loader: 'ts' },
    bundle: true, format: 'iife', globalName: 'Obeing', write: false, target: 'es2020',
});
const font = readFileSync(join(root, '..', 'simulator', 'src', 'renderer', 'src', 'device-sim', 'sandbox', 'fonts', 'fusion-pixel-12px-proportional-zh_hans.otf.woff2')).toString('base64');
const browser = await chromium.launch({ executablePath: process.env.OBEING_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1104, height: 896 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>@font-face{font-family:Pixel;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#ddd;display:grid;grid-template-columns:repeat(3,368px)}canvas{height:448px;image-rendering:pixelated}</style>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(async () => { await document.fonts.load('12px Pixel'); });
    const results = await page.evaluate(() => {
        const variants = [
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
            ctx.font = '12px Pixel';
            ctx.textBaseline = 'top';
            const screen = {
                width, height: 448,
                clear(color) { ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`; ctx.fillRect(0, 0, width, 448); },
                fillRect(x, y, w, h, color) {
                    if (x < 0 || x + w > width || y < 0 || y + h > 448) violations.push({ x, y, w, h });
                    calls++; ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`; ctx.fillRect(x, y, w, h);
                },
                measureText(text) { return { width: ctx.measureText(text).width, height: 12 }; },
                drawText(text, x, y, style) {
                    if (x < 0 || x + ctx.measureText(text).width > width || y < 0 || y + 12 > 448) violations.push({ text, x, y });
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
            Obeing.drawScene(screen, view, { clock: variant.clock, tiltX: variant.tiltX, tiltY: variant.tiltY, battery: 86, settings: variant.settings === true });
            const data = ctx.getImageData(0, 0, width, 448).data;
            let whitePixels = 0;
            let chromaticPixels = 0;
            for (let y = 70; y < 280; y++) for (let x = 30; x < width - 30; x++) {
                const i = (y * width + x) * 4;
                if (data[i] > 248 && data[i + 1] > 248 && data[i + 2] > 248) whitePixels++;
                if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 100) chromaticPixels++;
            }
            return { state: variant.state, theme: variant.theme, settings: variant.settings === true, pending: variant.pairingPending === true, width, whitePixels, chromaticPixels, violations, calls, png: canvas.toDataURL() };
        };
        return [368, 320].flatMap((width) => variants.map((variant) => {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 448; document.body.append(canvas);
            return window.renderVariant(canvas, variant);
        }));
    });
    for (const result of results) {
        assert.deepEqual(result.violations, []);
        if (result.state !== 'pairing' || result.pending) {
            assert.ok(result.whitePixels > (result.settings ? 2000 : 5000), `${result.state}: 主体不为空`);
            assert.ok(result.chromaticPixels > (result.settings ? 500 : 900), `${result.state}: 参考彩色边缘可见`);
        }
    }
    await page.screenshot({ path: join(output, 'states.png'), fullPage: true });
    const canvases = page.locator('canvas');
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const name = result.settings ? 'connection' : result.pending ? 'pairing-pending' : result.state;
        await canvases.nth(i).screenshot({ path: join(output, `${name}-${result.theme}-${result.width}.png`) });
    }
    const moving = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const before = window.renderVariant(canvas, { state: 'speaking', theme: 'dark', tiltX: -0.8, tiltY: -0.3, clock: 900 }).png;
        const after = window.renderVariant(canvas, { state: 'speaking', theme: 'dark', tiltX: 0.8, tiltY: 0.3, clock: 1350 }).png;
        return before !== after;
    });
    assert.equal(moving, true, 'IMU与说话时钟必须改变实际渲染像素');
    await page.setViewportSize({ width: 368, height: 448 });
    await page.addStyleTag({ content: 'body{display:block}canvas{display:none}canvas:first-child{display:block}' });
    await page.screenshot({ path: join(output, 'device-368x448.png') });
    console.log(JSON.stringify({ output, moving, results: results.map(({ png, ...rest }) => rest) }, null, 2));
} finally { await browser.close(); }
