import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const built = await build({ stdin: { contents: `
export {drawHarness} from './examples/07-obeing-harness/src/render';
export {drawCat,beginScene} from './examples/06-obeing-pixel/src/render';
export {layoutScreen,layoutScale} from './examples/06-obeing-pixel/src/layout';
export {CatMotion} from './examples/06-obeing-pixel/src/model';
export {initialState} from './examples/06-obeing-pixel/src/state';
export {fillRunLayers} from './sdk/src/run-layers';
`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm' });
const { drawHarness, drawCat, beginScene, layoutScreen, layoutScale, CatMotion, initialState, fillRunLayers } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

function surface(width, height, fused = false) {
  const pixels = new Uint32Array(width * height);
  const target = { width, height, pixels, events: [], fusedCalls: 0, fail: false,
    clear(color) { pixels.fill(color); },
    fillRect(x, y, w, h, color) {
      const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(width, x + w), bottom = Math.min(height, y + h);
      if (right <= left || bottom <= top) return;
      for (let row = top; row < bottom; row++) pixels.fill(color, row * width + left, row * width + right);
    },
    fillRects(rects, count) {
      this.events.push('batch');
      for (let i = 0; i < count; i++) this.fillRect(...rects.subarray(i * 5, i * 5 + 5));
    },
    drawText(text, x, y, style) {
      const scale = style?.scale || 1;
      for (const [index, character] of Array.from(text).entries()) {
        const code = character.codePointAt(0);
        for (let bit = 0; bit < 12; bit++) if (code & (1 << bit)) this.fillRect(
          x + (index * 6 + bit % 3) * scale, y + Math.floor(bit / 3) * scale, scale, scale, style?.color ?? 0xffffff);
      }
    },
    measureText(text, style) { return { width: Array.from(text).length * 6 * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
  };
  if (fused) target.fillRunLayersRestored = function (runs, options, restore) {
    this.events.push('fused'); this.fusedCalls++;
    assert.equal(this, target, 'layout必须保留目标方法receiver');
    assert.ok(restore instanceof Float64Array); assert.equal(restore.length, 9);
    assert.equal(options.scale, layoutScale(target));
    assert.ok([...restore].every(Number.isFinite));
    if (this.fail) throw Error('injected fused failure');
    // 独立参考完整恢复旧背景/网格，再绘制主体；不调用被测layout的restore/innerRect。
    const scale = options.scale, logicalWidth = width / scale, logicalHeight = height / scale;
    const [oldLeft, oldTop, oldRight, oldBottom, color, gridTop, gridBottom, gridColor, enabled] = restore;
    const left = Math.max(0, Math.floor(oldLeft)), top = Math.max(0, Math.floor(oldTop));
    const right = Math.min(logicalWidth, Math.ceil(oldRight)), bottom = Math.min(logicalHeight, Math.ceil(oldBottom));
    const paint = (x, y, w, h, ink) => {
      const l = Math.round(x * scale), t = Math.round(y * scale);
      target.fillRect(l, t, Math.round((x + w) * scale) - l, Math.round((y + h) * scale) - t, ink);
    };
    paint(left, top, right - left, bottom - top, color);
    if (enabled) {
      for (let x = 24; x < logicalWidth - 20; x += 20) if (x >= left && x < right)
        paint(x, Math.max(top, gridTop), 1, Math.max(0, Math.min(bottom, gridBottom) - Math.max(top, gridTop)), gridColor);
      for (let y = gridTop; y < gridBottom; y += 20) if (y >= top && y < bottom)
        paint(Math.max(left, 24), y, Math.max(0, Math.min(right, logicalWidth - 24) - Math.max(left, 24)), 1, gridColor);
    } else assert.deepEqual([...restore.subarray(5)], [0, 0, 0, 0]);
    return fillRunLayers(target, runs, options);
  };
  return target;
}

// 无能力不得伪造方法；有能力必须先提交队列，且保持输入/options不变。
const absent = surface(480, 480);
assert.equal(layoutScreen(absent).fillRunLayersRestored, undefined);
const present = surface(480, 480, true), layout = layoutScreen(present);
const runs = new Int32Array([2, 2, 3]), options = { step: 3 }, restore = new Float64Array([.5, .5, 20.25, 20.5, 0, 0, 0, 0, 0]);
layout.fillRect(1, 1, 2, 2, 0xffffff);
layout.fillRunLayersRestored(runs, options, restore);
assert.deepEqual(present.events.slice(0, 2), ['batch', 'fused']);
assert.deepEqual(options, { step: 3 });
assert.deepEqual([...restore], [.5, .5, 20.25, 20.5, 0, 0, 0, 0, 0]);
present.fail = true;
assert.throws(() => layout.fillRunLayersRestored(runs, options, restore), /injected fused failure/);
present.fail = false;

let frames = 0, fusedCalls = 0, skippedOldRestore = 0;
const form = { page: 'assistant', returnPage: 'assistant', field: 'question', values: {}, upper: false, symbols: false, busy: false, speechReady: false };
for (const [width, height] of [[320, 448], [368, 448], [480, 480]]) {
  for (const fullscreen of [false, true]) for (const character of ['cat', 'kitty-classic']) {
    const expected = surface(width, height), actual = surface(width, height, true);
    const optimized = layoutScreen(actual);
    // 融合条件满足时旧JS主体覆盖/网格恢复都不应再执行；Kitty继续走既有路径。
    if (character === 'cat') {
      optimized.runLayerInnerRect = () => { throw Error('fused path called JS innerRect'); };
      optimized.restoreGridRect = () => { throw Error('fused path called JS restore'); };
    }
    const view = initialState(), motion = new CatMotion(() => .37);
    Object.assign(view, { connected: true, authenticated: true, state: 'idle' });
    for (let i = 0; i < 80; i++) {
      const clock = i * 131, tiltX = Math.sin(i / 6), tiltY = Math.cos(i / 9);
      view.state = ['idle', 'speaking', 'thinking', 'sleep'][Math.floor(i / 10) % 4]; view.level = i * 7 % 100;
      view.theme = i < 40 ? 'dark' : 'light'; view.assistantText = i < 20 ? '' : i < 50 ? 'Reply' : 'Long reply '.repeat(10);
      const input = { clock, tiltX, tiltY, battery: 80, settings: false, fullscreen, character,
        shake: [0, .2, .6, 1][i % 4], pose: motion.sample(view.state, clock, tiltX, tiltY, view.level) };
      drawHarness(expected, view, input, form); drawHarness(actual, view, input, form);
      assert.deepEqual(actual.pixels, expected.pixels, `融合/完整恢复像素不同 ${width}x${height} ${character} full=${fullscreen} frame=${i}`);
      frames++;
    }
    if (character === 'cat') { assert.ok(actual.fusedCalls > 60); skippedOldRestore += actual.fusedCalls; }
    else assert.equal(actual.fusedCalls, 0, 'Kitty不得走融合主体路径');
    fusedCalls += actual.fusedCalls;
  }
}

// 直接调用drawCat时旧边界必须保留原浮点，不应在JS重复floor/ceil或缩放。
{
  const target = surface(480, 480, true), screen = layoutScreen(target), view = initialState();
  Object.assign(view, { connected: true, authenticated: true, state: 'idle' });
  const input = { clock: 1700, tiltX: .31, tiltY: -.27, battery: 80, settings: false,
    character: 'cat', shake: .65, pose: { yaw: .31, pitch: -.23, lift: .35, squash: 1 } };
  const render = () => drawCat(screen, view, input, 210.35, 9.4, { top: 83.25, bottom: 341.75 });
  beginScene(screen, 'direct', 0x080b0b); render(); screen.finish();
  const original = target.fillRunLayersRestored;
  let captured;
  target.fillRunLayersRestored = function (r, o, value) { captured = [...value]; return original.call(this, r, o, value); };
  beginScene(screen, 'direct', 0x080b0b); render(); screen.finish();
  assert.ok(captured.slice(0, 4).some(value => !Number.isInteger(value)), '必须有浮点边界覆盖');
  const before = target.fusedCalls;
  beginScene(screen, 'new-scene', 0x080b0b); render(); screen.finish();
  assert.equal(target.fusedCalls, before, '新场景首帧不能恢复已清除旧背景');
}
console.log(JSON.stringify({ frames, fusedCalls, skippedOldRestore, capabilityAndQueueChecks: true, rawBounds: true }));
