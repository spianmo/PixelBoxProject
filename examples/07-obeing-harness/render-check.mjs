import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.OBEING_PLAYWRIGHT || 'playwright');
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] || join(root, 'dist', 'screenshots'));
mkdirSync(output, { recursive: true });
const bundle = await build({ stdin: { contents: "export { drawHarness } from './render'; export { initialState } from '../../06-obeing-pixel/src/state';",
    resolveDir: join(root, 'src'), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'Harness', write: false, target: 'es2020' });
const font = readFileSync(join(root, '..', '..', 'simulator', 'src', 'renderer', 'src', 'device-sim', 'sandbox', 'fonts', 'fusion-pixel-12px-proportional-zh_hans.otf.woff2')).toString('base64');
const browser = await chromium.launch({ executablePath: process.env.OBEING_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1104, height: 896 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>@font-face{font-family:Pixel;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:repeat(3,368px);background:#ccc}canvas{image-rendering:pixelated}</style>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(async () => { await document.fonts.load('12px Pixel'); });
    const results = await page.evaluate(() => {
        window.renderHarnessVariant = (canvas, variant, tilt = 0.6) => {
            const ctx = canvas.getContext('2d');
            ctx.font = '12px Pixel'; ctx.textBaseline = 'top';
            const violations = [];
            const width = canvas.width;
            const screen = { width, height: 448,
                clear(color) { ctx.fillStyle = '#' + color.toString(16).padStart(6, '0'); ctx.fillRect(0, 0, width, 448); },
                fillRect(x, y, w, h, color) { if (x < 0 || y < 0 || x + w > width || y + h > 448) violations.push({ x, y, w, h }); ctx.fillStyle = '#' + color.toString(16).padStart(6, '0'); ctx.fillRect(x, y, w, h); },
                measureText(text) { return { width: ctx.measureText(text).width, height: 12 }; },
                drawText(text, x, y, style) { if (x < 0 || y < 0 || x + ctx.measureText(text).width > width || y + 12 > 448) violations.push({ text, x, y }); ctx.fillStyle = '#' + style.color.toString(16).padStart(6, '0'); ctx.fillText(text, x, y); },
            };
            const view = { ...Harness.initialState(), theme: variant.theme, state: 'speaking', authenticated: true, connected: true, displayName: '小川', enterpriseId: 'OBEING',
                userText: '今天适合去公园散步吗？', thinkingText: '天气查询已完成', assistantText: '今天晴，气温适宜。很适合散步，记得带水。', level: 62 };
            const form = { page: variant.page, returnPage: 'login', field: 'password', upper: false, symbols: false, busy: false, speechReady: true,
                values: { tenant: 'OBEING', account: 'USER01', password: 'fixture-password', region: 'eastasia', key: 'x'.repeat(32), origin: 'https://v4.teamhelper.cn', oem: '', domain: '', question: '' } };
            if (variant.page !== 'assistant') { view.userText = ''; view.assistantText = ''; view.thinkingText = ''; }
            Harness.drawHarness(screen, view, { clock: 1800, tiltX: tilt, tiltY: -0.4, battery: 86, settings: false }, form);
            const pixels = ctx.getImageData(0, 0, width, 448).data;
            let white = 0;
            let colors = 0;
            for (let y = 75; y < 265; y++) for (let x = 30; x < width - 30; x++) {
                const i = (y * width + x) * 4;
                if (pixels[i] > 248 && pixels[i + 1] > 248 && pixels[i + 2] > 248) white++;
                if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 100) colors++;
            }
            return { ...variant, width, violations, white, colors, png: canvas.toDataURL() };
        };
        const results = [];
        for (const width of [368, 320]) for (const theme of ['dark', 'light']) for (const page of ['login', 'speech', 'server', 'settings', 'editor', 'assistant']) {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 448;
            document.body.append(canvas);
            results.push(window.renderHarnessVariant(canvas, { page, theme }));
        }
        return results;
    });
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        assert.deepEqual(result.violations, [], `${result.page} ${result.theme} ${result.width}`);
        if (result.page === 'assistant') { assert.ok(result.white > 5000); assert.ok(result.colors > 900); }
        await page.locator('canvas').nth(i).screenshot({ path: join(output, `${result.page}-${result.theme}-${result.width}.png`) });
    }
    const moving = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return window.renderHarnessVariant(canvas, { page: 'assistant', theme: 'dark' }, -0.8).png !== window.renderHarnessVariant(canvas, { page: 'assistant', theme: 'dark' }, 0.8).png;
    });
    assert.equal(moving, true);
    await page.screenshot({ path: join(output, 'overview.png'), fullPage: true });
    console.log(JSON.stringify({ output, count: results.length, moving, violations: results.reduce((n, value) => n + value.violations.length, 0) }));
} finally { await browser.close(); }
