import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.OBEING_PLAYWRIGHT || 'playwright');
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] || join(root, '.artifacts', 'screenshots'));
mkdirSync(output, { recursive: true });
const bundle = await build({ stdin: { contents: "export { drawHarness } from './render'; export { initialState } from '../../06-obeing-pixel/src/state';",
    resolveDir: join(root, 'src'), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'Harness', write: false, target: 'es2020' });
const font = readFileSync(join(root, '..', '..', 'simulator', 'src', 'renderer', 'src', 'device-sim', 'sandbox', 'fonts', 'fusion-pixel-12px-proportional-zh_hans.otf.woff2')).toString('base64');
const browser = await chromium.launch({ executablePath: process.env.OBEING_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1104, height: 896 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>@font-face{font-family:Pixel;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:repeat(3,480px);background:#ccc}canvas{image-rendering:pixelated}</style>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(async () => { await document.fonts.load('12px Pixel'); });
    const results = await page.evaluate(() => {
        window.renderHarnessVariant = (canvas, variant, tilt = 0.6) => {
            const ctx = canvas.getContext('2d');
            ctx.font = '12px Pixel'; ctx.textBaseline = 'top';
            const violations = [];
            const width = canvas.width;
            const height = canvas.height;
            const texts = [];
            const screen = { width, height,
                clear(color) { ctx.fillStyle = '#' + color.toString(16).padStart(6, '0'); ctx.fillRect(0, 0, width, height); },
                fillRect(x, y, w, h, color) { if (x < 0 || y < 0 || x + w > width || y + h > height) violations.push({ x, y, w, h }); ctx.fillStyle = '#' + color.toString(16).padStart(6, '0'); ctx.fillRect(x, y, w, h); },
                measureText(text, style) { ctx.font = `${12 * (style?.scale || 1)}px Pixel`; return { width: ctx.measureText(text).width, height: 12 * (style?.scale || 1) }; },
                drawText(text, x, y, style) {
                    const size = this.measureText(text, style);
                    if (x < 0 || y < 0 || x + size.width > width || y + size.height > height) violations.push({ text, x, y });
                    const box = { text, x, y, w: size.width, h: size.height };
                    if (text) { for (const prior of texts) if (x < prior.x + prior.w && x + size.width > prior.x && y < prior.y + prior.h && y + size.height > prior.y) violations.push({ overlap: [prior, box] }); texts.push(box); }
                    ctx.fillStyle = '#' + style.color.toString(16).padStart(6, '0'); ctx.fillText(text, x, y);
                },
            };
            const view = { ...Harness.initialState(), theme: variant.theme, state: variant.state || 'speaking', authenticated: true, connected: true, displayName: '小川', enterpriseId: 'OBEING',
                userText: '今天适合去公园散步吗？', thinkingText: '天气查询已完成', assistantText: '今天晴，气温适宜。很适合散步，记得带水。', level: 62 };
            const form = { page: variant.page, returnPage: 'login', field: 'password', upper: false, symbols: false, busy: false, speechReady: true,
                values: { tenant: 'OBEING', account: 'USER01', password: 'fixture-password', region: 'eastasia', key: 'x'.repeat(32), origin: 'https://v4.teamhelper.cn', oem: '', domain: '', question: '' } };
            if (variant.page !== 'assistant' || variant.wakePhrase || (variant.character === 'cat' && ['idle', 'sleep'].includes(variant.state))) { view.userText = ''; view.assistantText = ''; view.thinkingText = ''; }
            if (variant.error) view.errorText = '设备 TLS 内存不足，请更新固件后重新登录企业账号';
            Harness.drawHarness(screen, view, { clock: 1800, tiltX: variant.tiltX ?? tilt, tiltY: variant.tiltY ?? -0.4, battery: 86, settings: false, fullscreen: variant.fullscreen, character: variant.character }, form, variant.wakePhrase);
            const pixels = ctx.getImageData(0, 0, width, height).data;
            let white = 0;
            let colors = 0;
            for (let y = 45; y < height - 110; y++) for (let x = 15; x < width - 15; x++) {
                const i = (y * width + x) * 4;
                if (pixels[i] > 248 && pixels[i + 1] > 248 && pixels[i + 2] > 248) white++;
                if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 100) colors++;
            }
            if (variant.page === 'assistant' && texts.some(box => box.text === '小川')) violations.push('account name on assistant');
            if (variant.fullscreen && texts.some(box => box.y < height - 145)) violations.push('text above fullscreen captions');
            if (variant.wakePhrase === '小爱同学' && !texts.some(box => box.text === variant.wakePhrase)) violations.push('custom wake phrase missing');
            return { ...variant, width, height, fontHeight: texts[0].h, violations, white, colors, png: canvas.toDataURL() };
        };
        const results = [];
        // 默认小猫的正面与睡眠图用于对照原素材，避免全部截图倾斜而掩盖比例问题。
        for (const width of [320, 368, 480]) for (const state of ['idle', 'listening', 'thinking', 'speaking', 'sleep']) for (const theme of ['dark', 'light']) {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = width === 480 ? 480 : 448;
            document.body.append(canvas);
            results.push(window.renderHarnessVariant(canvas, { page: 'assistant', state, character: 'cat', theme, tiltX: 0, tiltY: 0 }));
        }
        for (const width of [320, 368, 480]) for (const character of ['kitty-classic', 'kitty-witch', 'kitty-strawberry', 'kitty-pajamas', 'kitty-fish', 'kitty-scarf']) for (const theme of ['dark', 'light']) for (const fullscreen of [false, true]) {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = width === 480 ? 480 : 448;
            document.body.append(canvas);
            results.push(window.renderHarnessVariant(canvas, { page: 'assistant', state: 'idle', character, theme, fullscreen }, 0.25));
        }
        for (const width of [368, 320, 480]) for (const theme of ['dark', 'light']) for (const page of ['login', 'speech', 'server', 'settings', 'editor', 'assistant']) {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = width === 480 ? 480 : 448;
            document.body.append(canvas);
            results.push(window.renderHarnessVariant(canvas, { page, theme, error: page === 'login' }));
        }
        for (const width of [320, 368, 480]) for (const state of ['idle', 'listening', 'thinking', 'speaking']) {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = width === 480 ? 480 : 448;
            document.body.append(canvas);
            results.push(window.renderHarnessVariant(canvas, { page: 'assistant', theme: 'dark', state, fullscreen: true }));
        }
        for (const width of [320, 368, 480]) for (const wakePhrase of ['小爱同学', '欢迎使用语音助手请帮我处理今天的工作安排和日程']) {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = width === 480 ? 480 : 448;
            document.body.append(canvas);
            results.push(window.renderHarnessVariant(canvas, { page: 'assistant', theme: 'dark', state: 'idle', wakePhrase }));
        }
        return results;
    });
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        assert.deepEqual(result.violations, [], `${result.page} ${result.theme} ${result.width}`);
        assert.equal(result.fontHeight, result.width === 480 ? 24 : 12);
        if (result.page === 'assistant') { assert.ok(result.white > (result.character ? 2000 : 5000)); assert.ok(result.colors > 900); }
        const name = result.character === 'cat' ? `cat-${result.state}` : result.character || result.page;
        await page.locator('canvas').nth(i).screenshot({ path: join(output, `${name}${result.fullscreen ? '-fullscreen-' + result.state : ''}-${result.theme}-${result.width}.png`) });
    }
    const moving = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return window.renderHarnessVariant(canvas, { page: 'assistant', theme: 'dark' }, -0.8).png !== window.renderHarnessVariant(canvas, { page: 'assistant', theme: 'dark' }, 0.8).png;
    });
    assert.equal(moving, true);
    await page.screenshot({ path: join(output, 'overview.png'), fullPage: true });
    console.log(JSON.stringify({ output, count: results.length, moving, violations: results.reduce((n, value) => n + value.violations.length, 0) }));
} finally { await browser.close(); }
