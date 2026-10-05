// 使用真实Canvas/prelude入口验证原生逐行记录与JS绘制、自动提交及失败重试的衔接。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const prelude = fs.readFileSync(new URL('../src/prelude.js', import.meta.url), 'utf8');
const source = prelude.slice(prelude.indexOf('  class Canvas {'), prelude.indexOf('  px.screen = screen;'));
function setup() {
  let failDraw = false, failFlush = false, timer;
  const calls = [], draws = [];
  const native = {
    width: 8, height: 5,
    flush(...args) {
      calls.push({ args, rows: args[6] && [...args[6]] });
      if (failFlush) throw new Error('flush failed');
    },
    // 替身返回覆盖全画布的bbox，但只报告中间一行两像素；用于捕获JS误扩张tracker。
    draw(pixels, width, height, rows) {
      draws.push(rows);
      if (rows) { rows[4] = 3; rows[5] = 4; }
      pixels[18] = 0xffffff;
      if (failDraw) throw new Error('draw failed');
      return { x: 0, y: 0, width, height };
    },
    blitCanvas(p,w,h,src,sw,sh,x,y,sx,sy,bw,bh,rows) { return this.draw(p,w,h,rows); },
    composeRows(p,w,h,sources,geometry,regions,top,bottom,background,rows) {
      rows[4] = 3; rows[5] = 4;
      p[2 * w + 2] = 0xffffff;
    },
    fillRects(p, w, h, r, count, rows) { return this.draw(p, w, h, rows); },
    fillRectLayers(p, w, h, r, o, rows) { return this.draw(p, w, h, rows); },
    fillRunLayers(p, w, h, r, o, rows) { return { dirty: this.draw(p, w, h, rows), bounds: [1, 2, 3, 4] }; },
    fillRunLayersRestored(p, w, h, r, o, restore, rows) { return this.fillRunLayers(p, w, h, r, o, rows); },
    drawText() { if (failDraw) throw new Error('text failed'); return (8 << 12) | 5; },
    setRotation() { return true; }
  };
  const runtime = new Function('native', 'g', 'setTimeout', 'clearTimeout', `
    const unsupported = () => {throw new Error('ENOTSUP');};
    ${source}
    return {screen, Canvas};
  `)(native, { performance: { now: () => 100 } }, cb => { timer = cb; return 1; }, () => {});
  return { ...runtime, native, calls, draws, tick: () => timer(),
    setDrawFailure: value => { failDraw = value; }, setFlushFailure: value => { failFlush = value; } };
}
const allRows = [1,8,1,8,1,8,1,8,1,8];

test('所有原生绘制只合并bbox，自动flush保留稀疏rows', () => {
  for (const method of ['fillRect', 'fillRects', 'fillRectLayers', 'fillRunLayers', 'fillRunLayersRestored', 'drawImage']) {
    const { screen, Canvas, calls, draws } = setup();
    if (method === 'drawImage') screen.drawImage(new Canvas(8,5),0,0);
    else if (method === 'fillRect') screen.fillRect(0, 0, 8, 5, 1);
    else if (method === 'fillRects') screen.fillRects(new Int32Array(5), 1);
    else screen[method](new Int16Array(4), {}, new Float64Array(9));
    assert.equal(draws[0], screen._changedRows);
    assert.deepEqual(screen._dirty, { x: 0, y: 0, right: 8, bottom: 5 });
    assert.deepEqual([...screen._changedRows], [0,0,0,0,3,4,0,0,0,0]);
    screen.flush(true);
    assert.deepEqual(calls[0].rows, [0,0,0,0,3,4,0,0,0,0]);
    assert.equal(screen._dirty, null);
    assert.ok(screen._changedRows.every(x => x === 0));
  }
});

test('JS像素、裁剪、clear、图片、文字及旋转保守合并逐行范围', () => {
  const { screen, Canvas } = setup();
  screen.setPixel(0, 2, 1); screen.setPixel(7, 2, 2); screen.setPixel(-1, 1, 3);
  screen._markDirty(-2, -1, 4, 3);
  assert.deepEqual([...screen._changedRows], [1,2,1,2,1,8,0,0,0,0]);
  screen.flush(true);
  const image = new Canvas(1, 1); image.setPixel(0, 0, 5);
  screen.drawImage(image, 4, 3, {colorKey: -1});
  assert.deepEqual([...screen._changedRows], [0,0,0,0,0,0,5,5,0,0]);
  screen.flush(true); screen.drawText('x', 0, 0);
  assert.deepEqual([...screen._changedRows], allRows);
  screen.flush(true); screen.clear();
  assert.deepEqual([...screen._changedRows], allRows);
  screen.flush(true); screen.setRotation(90);
  assert.deepEqual([...screen._changedRows], allRows);
});

test('列表合成只提交原生追踪到的实际变化行', () => {
  const { screen, Canvas } = setup();
  const source = new Canvas(8, 1);
  screen._composeRows([source], new Int32Array([2, 1]), new Int32Array([0, 2, 8, 1]), 0, 5, 0);
  assert.deepEqual(screen._dirty, { x: 2, y: 2, right: 4, bottom: 3 });
  assert.deepEqual([...screen._changedRows], [0,0,0,0,3,4,0,0,0,0]);
});

test('原生异常全屏重扫，提交异常保留tracker直到重试成功', () => {
  const { screen, calls, setDrawFailure, setFlushFailure } = setup();
  setDrawFailure(true);
  assert.throws(() => screen.fillRect(0, 0, 8, 5, 1), /draw failed/);
  assert.deepEqual([...screen._changedRows], allRows);
  setFlushFailure(true);
  assert.throws(() => screen.flush(true), /flush failed/);
  assert.deepEqual([...screen._changedRows], allRows);
  assert.notEqual(screen._dirty, null);
  setFlushFailure(false); screen.flush(true);
  assert.deepEqual(calls[1].rows, allRows);
  assert.equal(screen._dirty, null);
  assert.ok(screen._changedRows.every(x => x === 0));
});

test('自动干净帧使用known-clean，显式flush始终全扫私有像素', () => {
  const { screen, calls, tick } = setup();
  screen.onFrame(() => {}); tick();
  assert.equal(calls[0].args[5], true);
  screen.setPixel(2, 2, 1); screen._pixels[0] = 2; screen.flush();
  assert.equal(calls[1].args.length, 1);
  assert.equal(screen._dirty, null);
  assert.ok(screen._changedRows.every(x => x === 0));
});

test('离屏画布不分配行表', () => {
  const { Canvas, draws } = setup();
  const canvas = new Canvas(3, 4);
  canvas.fillRect(0, 0, 3, 4, 1);
  assert.equal(draws[0], undefined);
  assert.equal(canvas._changedRows, undefined);
});
