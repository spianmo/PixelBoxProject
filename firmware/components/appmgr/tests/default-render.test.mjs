import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../src/default_app.js', import.meta.url)), 'utf8');

function createDevice(width = 368, height = 448) {
  let frameCallback;
  const calls = [];
  const screen = {
    width,
    height,
    setFps(value) { calls.push(['setFps', value]); },
    onFrame(callback) { frameCallback = callback; },
    clear(color) { calls.push(['clear', color]); },
    fillRect(x, y, w, h, color) { calls.push(['fillRect', x, y, w, h, color]); },
    drawRect(x, y, w, h, color) { calls.push(['drawRect', x, y, w, h, color]); },
    measureText(text, style = {}) {
      const unit = style.font === 'pixel16' ? 16 : 12;
      const scale = style.scale || 1;
      return { width: [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? unit / 2 : unit), 0) * scale };
    },
    drawText(text, x, y, style) { calls.push(['drawText', text, x, y, style]); },
  };
  const context = vm.createContext({
    px: {
      color: {
        lerp(a, b, amount) { return amount < 0.5 ? a : b; },
        hsv() { return 0xffffff; },
      },
      screen,
    },
    console: { log() {}, warn() {}, error() {} },
    setInterval() {},
    Math,
  });
  vm.runInContext(source, context);
  assert.equal(typeof frameCallback, 'function', '欢迎页必须注册帧回调');
  return {
    calls,
    step(dt = 1000 / 30) {
      calls.length = 0;
      frameCallback(dt);
      return calls.slice();
    },
  };
}

const device = createDevice();
const first = device.step();
const second = device.step();
const third = device.step();

assert.equal(first.filter(call => call[0] === 'clear').length, 1, '首帧应清屏一次');
assert.equal(second.filter(call => call[0] === 'clear').length, 0, '后续帧不应整屏清除');
assert.equal(first.filter(call => call[0] === 'drawText').length, 4, '首帧应绘制标题、命令行和两行提示');
assert.equal(second.filter(call => call[0] === 'drawText' && call[1] === 'PixelBox').length, 0, '标题只应绘制一次');
assert.equal(second.filter(call => call[0] === 'drawText' && call[1] === '推送你的应用').length, 0, '静态提示只应绘制一次');
assert.equal(second.filter(call => call[0] === 'drawText' && call[1] === '开始创作').length, 0, '静态提示只应绘制一次');
assert.equal(second.filter(call => call[0] === 'drawText' && call[1] === 'pixelbox push').length, 1, '动态副标题应持续刷新');
assert.equal(third.filter(call => call[0] === 'drawText' && call[1] === 'pixelbox push').length, 1, '动态副标题应持续刷新');
for (const call of [...first, ...second, ...third]) {
  if (call[0] === 'fillRect' || call[0] === 'drawRect') {
    assert.ok(call[3] > 0, `${call[0]} 宽度必须为正数`);
    assert.ok(call[4] > 0, `${call[0]} 高度必须为正数`);
  }
}

console.log('default-render.test.mjs: ok');
