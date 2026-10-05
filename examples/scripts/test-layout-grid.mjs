import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({ entryPoints: [root + 'examples/06-obeing-pixel/src/layout.ts'], bundle: true, write: false, format: 'esm' });
const { layoutScreen } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function capture(width, height, batch) {
  const output = [];
  const target = { width, height, clear() {}, drawText() {}, measureText() { return { width: 0, height: 12 }; },
    fillRect(...rect) { output.push(rect); } };
  if (batch) target.fillRects = (rects, count) => {
    for (let i = 0; i < count; i++) output.push([...rects.subarray(i * 5, i * 5 + 5)]);
  };
  return { screen: layoutScreen(target), output };
}
function original(screen, left, top, right, bottom, color, grid) {
  screen.fillRect(left, top, right - left, bottom - top, color);
  if (!grid) return;
  for (let x = 24; x < screen.width - 20; x += 20)
    if (x >= left && x < right) screen.fillRect(x, Math.max(top, grid.top), 1,
      Math.max(0, Math.min(bottom, grid.bottom) - Math.max(top, grid.top)), grid.color);
  for (let y = grid.top; y < grid.bottom; y += 20)
    if (y >= top && y < bottom) screen.fillRect(Math.max(left, 24), y,
      Math.max(0, Math.min(right, screen.width - 24) - Math.max(left, 24)), 1, grid.color);
}
let seed = 0x739ee4;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
let cases = 0;
// 比较原循环实际发出的物理矩形，覆盖缓存失效、零宽与非整数缩放，强于仅比较最终像素。
for (const [width, height] of [[320,448],[368,448],[480,480],[333,517],[1,2]]) for (const batch of [false,true]) {
  const expected = capture(width, height, batch), actual = capture(width, height, batch);
  for (let i = 0; i < 240; i++) {
    const grid = i % 11 === 0 ? undefined : { top: i % 13 === 0 ? -3.75 : 83,
      bottom: i % 7 === 0 ? 393.125 : 380, color: i % 2 ? 0x18201e : 0xdce2df };
    const left = Math.floor(random() * 300 - 20), right = left + Math.ceil(random() * 250);
    const top = Math.floor(random() * 400 - 20), bottom = top + Math.ceil(random() * 350);
    // 已排队矩形也必须保序，不能为新快路径丢失或提前覆盖。
    expected.screen.fillRect(1.125, 4.5, 3.25, .5, 0xff0000);
    actual.screen.fillRect(1.125, 4.5, 3.25, .5, 0xff0000);
    original(expected.screen, left, top, right, bottom, 0x080b0b, grid);
    actual.screen.restoreGridRect(left, top, right, bottom, 0x080b0b, grid);
    expected.screen.finish(); actual.screen.finish();
    assert.deepEqual(actual.output, expected.output, `grid ${width}x${height} batch=${batch} case=${i}`);
    expected.output.length = actual.output.length = 0;
    cases++;
  }
}
console.log(`PASS ${cases} 组背景网格缓存与原布局四次取整逐矩形一致`);
