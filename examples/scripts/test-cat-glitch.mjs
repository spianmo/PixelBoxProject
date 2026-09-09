import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function moduleAt(path) {
    const bundled = await build({ entryPoints: [resolve(root, path)], bundle: true, format: 'esm', write: false });
    return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
}
const model = await moduleAt('06-obeing-pixel/src/model.ts');
const render = await moduleAt('06-obeing-pixel/src/render.ts');
const { initialState } = await moduleAt('06-obeing-pixel/src/state.ts');
const view = { ...initialState(), state: 'idle', connected: true, authenticated: true };
const colors = new Set([0x2050ef, 0xe31c35, 0x17f5f5, 0xf9fb54]);
function screenAt(width = 480, height = 480) {
    const pixels = new Uint32Array(width * height);
    return { width, height, pixels, rects: [],
        clear(color) { pixels.fill(color); },
        fillRect(x, y, w, h, color) {
            assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height);
            this.rects.push({ x, y, w, h, color });
            for (let row = Math.round(y); row < Math.round(y + h); row++)
                pixels.fill(color, row * width + Math.round(x), row * width + Math.round(x + w));
        },
    };
}

// 强度按原始 X/Y 合成，反方向等效；倾角已饱和时，更大的冲击仍增强故障效果。
for (const axis of [0, 1]) {
    let previous = -1;
    for (const g of [0, 0.1, 0.3, 0.6, 1, 1.2, 1.5]) {
        const input = axis ? [0, g] : [g, 0];
        const level = model.imuGlitch(...input);
        assert.ok(level > previous);
        assert.equal(level, model.imuGlitch(...input.map(n => -n)));
        previous = level;
    }
}
assert.equal(model.imuGlitch(0.03, 0.03), 0);
assert.equal(model.imuGlitch(NaN, Infinity), 0);
assert.equal(model.imuGlitch(100, -100), 1);
assert.ok(model.imuGlitch(0.5, 0.5) > model.imuGlitch(0.5, 0));
for (const name of ['06-obeing-pixel', '07-obeing-harness']) {
    const main = await readFile(resolve(root, name, 'src/main.ts'), 'utf8');
    const callback = main.match(/px\.sensors\.imu\.start\(\{ rateHz: 50, onData\(data\) \{([\s\S]*?)\n\s*\} \}\);/);
    assert.ok(callback, `${name}: 找到实际 IMU 入口`);
    const sample = (ax, ay) => runInNewContext(`${callback[1]}; ({targetX, targetY, shake})`, {
        data: { ax, ay }, targetX: 0, targetY: 0, shake: 0, imuGlitch: model.imuGlitch, clamp: model.clamp,
    });
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const mild = sample(x, y), strong = sample(x * 1.4, y * 1.4);
        assert.equal(strong.targetX, mild.targetX);
        assert.equal(strong.targetY, mild.targetY);
        assert.ok(strong.shake > mild.shake, `${name}: 超过转向上限后仍增强`);
        assert.equal(sample(x, y).shake, mild.shake, '恒定加速度不随时间退回弱效果');
    }
    assert.equal(sample(0, 0).shake, 0);
}

// 固定姿态，比较最终可见的彩色像素，排除三维转向造成的面积变化。
const neutral = model.poseFor('idle', 0, 0, 0, 0);
const visible = [];
for (const g of [0, 0.3, 0.75, 1.5]) {
    const screen = screenAt();
    render.drawCat(screen, view, { clock: 0, tiltX: 0, tiltY: 0, battery: 86, settings: false,
        pose: neutral, shake: model.imuGlitch(g, 0) }, 230, 8);
    visible.push(screen.pixels.reduce((n, color) => n + Number(colors.has(color)), 0));
}
for (let i = 1; i < visible.length; i++) assert.ok(visible[i] > visible[i - 1], visible.join(' < '));

// 最大故障强度覆盖所有形态、两轴正负极限、普通与全屏主体范围，包含扫描条。
let cases = 0;
for (const width of [320, 368, 480]) for (const fullscreen of [false, true]) {
    const height = width === 480 ? 480 : 448;
    const region = { top: fullscreen ? 42 : 83, bottom: height - 140 };
    for (const shape of model.CAT_SHAPES) for (const [x, y] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const screen = screenAt(width, height);
        const pose = model.poseFor('idle', 1700, x, y, 0, shape);
        const input = { clock: 1700, tiltX: x, tiltY: y, battery: 86, settings: false, pose, shake: 1 };
        render.drawCat(screen, view, input, (region.top + region.bottom) / 2, fullscreen ? 14 : 11, region);
        assert.ok(screen.rects.length > 0);
        for (const box of screen.rects) assert.ok(box.y >= region.top && box.y + box.h <= region.bottom);
        cases++;
    }
}

// 强度和速度下降后，旧错位条完整清理；局部更新与从空白完整绘制逐像素一致。
const actual = screenAt();
for (let frame = 0; frame < 12; frame++) {
    const shake = [0, 0.3, 0.7, 1, 0.5, 0][frame % 6];
    const input = { clock: frame * 50, tiltX: 0, tiltY: 0, battery: 86, settings: false, shake };
    render.beginScene(actual, 'glitch', 0x080b0b);
    render.drawCat(actual, view, input, 230, 8);
    const expected = screenAt();
    render.beginScene(expected, 'glitch', 0x080b0b);
    render.drawCat(expected, view, input, 230, 8);
    assert.deepEqual(actual.pixels, expected.pixels, `frame ${frame}`);
}
console.log(`IMU 故障渐强通过：彩色像素 ${visible.join(' → ')}；${cases} 个极限场景无越界，强弱切换无残影`);
