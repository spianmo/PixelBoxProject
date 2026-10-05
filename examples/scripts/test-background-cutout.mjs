import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({ stdin: { contents: `
export { fillRunLayers, runLayerInnerRect } from './sdk/src/run-layers';
export { layoutScreen } from './examples/06-obeing-pixel/src/layout';
`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm' });
const { fillRunLayers, runLayerInnerRect, layoutScreen } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function surface(width, height, batch = true) {
  const pixels = new Uint32Array(width * height);
  // 非纯色旧图可直接暴露误跳过背景留下的残影。
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.imul(i + 1, 0x739e) & 0xffffff;
  const target = { width, height, pixels, writes: 0,
    clear(color) { pixels.fill(color); }, drawText() {}, measureText() { return { width: 0, height: 12 }; },
    fillRect(x, y, w, h, color) {
      const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(width, x + w), bottom = Math.min(height, y + h);
      if (right <= left || bottom <= top) return;
      this.writes += (right - left) * (bottom - top);
      for (let row = top; row < bottom; row++) pixels.fill(color, row * width + left, row * width + right);
    },
  };
  if (batch) target.fillRects = function (rects, count = rects.length / 5) {
    for (let i = 0; i < count; i++) this.fillRect(...rects.subarray(i * 5, i * 5 + 5));
  };
  return target;
}

let coverageCases = 0, coveredCases = 0;
function verifyCoverage(width, height, values, options) {
  const runs = new Int32Array(values), target = surface(width, height);
  target.pixels.fill(0);
  fillRunLayers(target, runs, { ...options, color: 0xffffff });
  const before = [...runs], rect = runLayerInnerRect(target, runs, options);
  assert.deepEqual([...runs], before, '覆盖分析不能修改投影缓冲');
  if (rect) {
    coveredCases++;
    for (const value of Object.values(rect)) assert.ok(Number.isInteger(value), '覆盖边界必须是物理整数');
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height);
    assert.ok(rect.left < rect.right && rect.top < rect.bottom);
    for (let y = rect.top; y < rect.bottom; y++) for (let x = rect.left; x < rect.right; x++)
      assert.equal(target.pixels[y * width + x], 0xffffff,
        `覆盖区不是主体实心像素 case=${coverageCases} at=${x},${y}`);
  }
  coverageCases++;
  return rect;
}

// 双耳、多段、单格针孔、缺行、极值和 count 前缀都不能制造假实心区域。
const shapes = [
  [], [4, 4, 6],
  [0, 0, 2, 7, 0, 2, 0, 1, 2, 7, 1, 2, 0, 2, 9, 0, 3, 9, 0, 4, 9],
  [0, 0, 2, 3, 0, 2, 0, 1, 2, 3, 1, 2, 0, 2, 5, 0, 3, 5],
  [0, 0, 8, 0, 1, 8, 0, 3, 8, 0, 4, 8, 0, 7, 8],
  [-4, -3, 9, -3, -2, 8, -2, -1, 7, -1, 0, 6, 0, 1, 5],
  [2147483638, 0, 8, 2147483639, 1, 7, 2147483640, 2, 6],
];
for (const values of shapes) for (const scale of [.25, .5, 1, 480 / 448, 1.5, 2])
  for (const padding of [0, 1, 2.5]) for (const margin of [undefined, 3.5])
    verifyCoverage(160, 180, values, { step: 5, scale, padding, margin,
      left: -.5, right: 110.5, clipTop: 2.5, clipBottom: 90.5,
      layers: new Int32Array([5, -5, 0x123456, -5, 5, 0x654321]) });
assert.equal(runLayerInnerRect({ width: 50, height: 50 }, new Int32Array([0, 0, 9, 0, -1, -1]), { count: 0 }), undefined);
verifyCoverage(100, 100, [2, 1, 7, 2, 2, 7, 0, -1, -1], { count: 2, step: 5 });

let seed = 0x936577;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
function randomRuns() {
  const values = [];
  for (let row = -2; row < 45; row++) {
    if (random() < .12) continue;
    let x = Math.floor(random() * 10) - 3;
    const count = Math.ceil(random() * 3);
    for (let i = 0; i < count; i++) {
      const width = 1 + Math.floor(random() * 12);
      values.push(x, row, width); x += width + Math.floor(random() * 4);
    }
  }
  return values;
}
for (let i = 0; i < 1200; i++) verifyCoverage(160, 180, randomRuns(), {
  step: 1 + Math.floor(random() * 9), scale: [.25, .5, 1, 480 / 448, 1.5][i % 5],
  padding: [0, .5, 1, 1.5][i % 4], margin: i % 2 ? undefined : 4.5,
  clipTop: i % 3 ? .5 : -3.5, clipBottom: 80 + random() * 90,
  layers: new Int32Array([9, -9, 0x123456, -9, 9, 0x654321]),
});

let restoreCases = 0, normalWrites = 0, reducedWrites = 0;
for (const [width, height] of [[320, 448], [368, 448], [480, 480]]) for (const batch of [false, true]) {
  const expected = surface(width, height, batch), actual = surface(width, height, batch);
  const full = layoutScreen(expected), cut = layoutScreen(actual);
  for (let i = 0; i < 120; i++) {
    const runs = new Int32Array(randomRuns());
    const options = { step: 4 + i % 5, padding: 1, margin: 12, left: 20.5, right: 220.5,
      clipTop: 83.5, clipBottom: 335.5, layers: new Int32Array([5, -5, 0x113377, -5, 5, 0x773311]) };
    const cover = cut.runLayerInnerRect(runs, options);
    const left = -3.5 + random() * 70, top = 65.5 + random() * 40;
    const right = 180.5 + random() * 110, bottom = 200.5 + random() * 130;
    const grid = i % 5 ? { top: 83, bottom: 337.25, color: 0x18201e } : undefined;
    // 覆盖区之外的既有队列及绘制顺序也必须保留。
    full.fillRect(1.125, 4.5, 3.25, .5, 0xff0000); cut.fillRect(1.125, 4.5, 3.25, .5, 0xff0000);
    expected.writes = actual.writes = 0;
    full.restoreGridRect(left, top, right, bottom, 0x080b0b, grid);
    cut.restoreGridRect(left, top, right, bottom, 0x080b0b, grid, cover);
    full.finish(); cut.finish();
    assert.ok(actual.writes <= expected.writes, '背景扣除不应增加物理像素写入');
    normalWrites += expected.writes; reducedWrites += actual.writes;
    full.fillRunLayers(runs, options); cut.fillRunLayers(runs, options);
    full.finish(); cut.finish();
    assert.deepEqual(actual.pixels, expected.pixels, `背景扣除后残影 ${width}x${height} batch=${batch} case=${i}`);
    restoreCases++;
  }
}
assert.ok(coveredCases > 500, '随机用例必须实际覆盖足够多的非空内矩形');
assert.ok(reducedWrites < normalWrites, '实际背景写入必须下降');
console.log(`PASS ${coverageCases} 组主体物理覆盖、${restoreCases} 组缩放/网格/旧图恢复；背景写入 ${normalWrites} → ${reducedWrites} 像素`);
