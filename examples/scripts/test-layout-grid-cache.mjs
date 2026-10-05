import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({ entryPoints: [root + 'examples/06-obeing-pixel/src/layout.ts'], bundle: true, write: false, format: 'esm' });
const { layoutScreen } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function capture(width = 480, height = 480, batched = true) {
  const pixels = new Uint32Array(width * height), calls = [];
  const target = { width, height, pixels,
    clear(color) { pixels.fill(color); }, drawText() {}, measureText() { return { width: 0, height: 12 }; },
    fillRect(x, y, w, h, color) { calls.push({ type: 'rect', rect: [x, y, w, h, color] });
      const l = Math.max(0, x), t = Math.max(0, y), r = Math.min(width, x + w), b = Math.min(height, y + h);
      for (let row = t; row < b; row++) pixels.fill(color, row * width + l, row * width + r);
    },
  };
  if (batched) target.fillRects = (rects, count) => {
    calls.push({ type: 'batch', count });
    for (let i = 0; i < count; i++) target.fillRect(...rects.subarray(i * 5, i * 5 + 5));
  };
  return { target, screen: layoutScreen(target), calls, pixels };
}
const grid = { top: 83, bottom: 393, color: 0x18201e }, covered = { left: 120, top: 130, right: 340, bottom: 290 };
function restore(screen, left = 40.25, top = 90.5, right = 440.75, bottom = 360.25, color = 0x080b0b, value = covered) {
  screen.restoreGridRect(left, top, right, bottom, color, grid, value);
}
// 两次相同恢复必须与无缓存参考逐像素、逐矩形顺序一致；缓存只改变组装路径。
for (const batched of [false, true]) {
  const reference = capture(480, 480, batched), actual = capture(480, 480, batched);
  restore(reference.screen); restore(reference.screen); reference.screen.finish?.();
  restore(actual.screen); restore(actual.screen); actual.screen.finish?.();
  assert.deepEqual(actual.calls, reference.calls, `重复恢复 batch=${batched}`);
  assert.deepEqual(actual.pixels, reference.pixels, `重复恢复像素 batch=${batched}`);
}
// 队列中已有矩形且跨过1024边界时，缓存批次必须分片，不能丢失先后顺序。
{
  const reference = capture(), actual = capture();
  for (let i = 0; i < 1020; i++) { reference.screen.fillRect(i % 480, i % 480, 1, 1, 0x123456); actual.screen.fillRect(i % 480, i % 480, 1, 1, 0x123456); }
  restore(reference.screen); restore(reference.screen); reference.screen.finish();
  restore(actual.screen); restore(actual.screen); actual.screen.finish();
  assert.deepEqual(actual.calls, reference.calls, '1024 队列边界');
  assert.deepEqual(actual.pixels, reference.pixels, '1024 队列边界像素');
}
// 背景、网格、覆盖矩形任一 key 变化都必须失效；相同 key 仍可在后续刷新后命中。
{
  const actual = capture(), reference = capture();
  restore(reference.screen); restore(actual.screen);
  restore(reference.screen, 41.25); restore(actual.screen, 41.25);
  restore(reference.screen, 40.25, 90.5, 440.75, 360.25, 0x080b0c); restore(actual.screen, 40.25, 90.5, 440.75, 360.25, 0x080b0c);
  restore(reference.screen, 40.25, 90.5, 440.75, 360.25, 0x080b0b, { ...covered, right: 341 });
  restore(actual.screen, 40.25, 90.5, 440.75, 360.25, 0x080b0b, { ...covered, right: 341 });
  reference.screen.finish(); actual.screen.finish();
  assert.deepEqual(actual.calls, reference.calls, 'key 变化失效');
  assert.deepEqual(actual.pixels, reference.pixels, 'key 变化像素');
}
// 无网格恢复不能创建可复用网格批次；后续相同网格调用仍必须得到完整结果。
{
  const actual = capture(), reference = capture();
  actual.screen.restoreGridRect(20, 20, 100, 100, 0x123456);
  reference.screen.restoreGridRect(20, 20, 100, 100, 0x123456);
  restore(actual.screen); restore(reference.screen); actual.screen.finish(); reference.screen.finish();
  assert.deepEqual(actual.calls, reference.calls, '无网格后恢复');
  assert.deepEqual(actual.pixels, reference.pixels, '无网格后恢复像素');
}
console.log('PASS layout restoreGridRect 最近批次缓存：逐矩形顺序、1024 队列边界、key 失效、无网格路径');
