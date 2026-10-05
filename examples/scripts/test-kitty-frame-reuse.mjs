import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exports = `
export { drawKitty } from './examples/06-obeing-pixel/src/kitty';
export { drawHarness } from './examples/07-obeing-harness/src/render';
export { initialState } from './examples/06-obeing-pixel/src/state';
export { CatMotion } from './examples/06-obeing-pixel/src/model';
export { fillRectLayers } from './sdk/src/run-layers';
`;
const uncached = { name: 'uncached-reference', setup(builder) {
  builder.onLoad({ filter: /06-obeing-pixel\/src\/kitty\.ts$/ }, args => {
    const source = readFileSync(args.path, 'utf8');
    const anchor = 'const retained = previous && paintings.get(previous);';
    assert.ok(source.includes(anchor), '参考路径必须明确禁用连续帧复用');
    return { contents: source.replace(anchor, 'const retained = undefined;'), loader: 'ts' };
  });
} };
async function compile(disable, format = 'esm') {
  return build({ stdin: { contents: format === 'iife' ? exports.replaceAll('export {', 'import {') +
    '\nglobalThis.__kittyModule={drawKitty,drawHarness,initialState,CatMotion,fillRectLayers};' : exports,
    resolveDir: root, loader: 'ts' }, bundle: true, write: false, format, target: 'es2020',
    plugins: disable ? [uncached] : [] });
}
function check(condition, message) { if (!condition) throw Error(message); }
function samePixelsOnHost(a, b, message) {
  if (typeof samePixels === 'function') {
    samePixels(a); check(samePixels(b), message); return;
  }
  check(a.length === b.length, message + ': size');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw Error(message + ': pixel=' + i);
}
function surface(width, height, api, nativeCanvas = false) {
  const target = { width, height, pixels: new Uint32Array(width * height), bodyCalls: 0, textCalls: 0,
    restoreCalls: 0, failNext: false,
    resize(w, h) { this.width = w; this.height = h; this.pixels = new Uint32Array(w * h); },
    clear(color) { this.pixels.fill(color); },
    fillRect(x, y, w, h, color) {
      const left = Math.max(0, x), top = Math.max(0, y);
      const right = Math.min(this.width, x + w), bottom = Math.min(this.height, y + h);
      if (right <= left || bottom <= top) return;
      for (let row = top; row < bottom; row++) this.pixels.fill(color, row * this.width + left, row * this.width + right);
    },
    fillRects(rects, count = rects.length / 5) {
      this.restoreCalls++;
      if (nativeCanvas) return native.fillRects(this.pixels, this.width, this.height, rects, count);
      for (let i = 0; i < count; i++) this.fillRect(...rects.subarray(i * 5, i * 5 + 5));
    },
    fillRectLayers(rects, options) {
      this.bodyCalls++;
      if (this.failNext) { this.failNext = false; throw Error('injected draw failure'); }
      if (nativeCanvas) native.fillRectLayers(this.pixels, this.width, this.height, rects, options);
      else api.fillRectLayers(this, rects, options);
    },
    drawText(text, x, y, style) {
      this.textCalls++;
      const scale = style?.scale || 1;
      for (const [index, character] of Array.from(text).entries()) {
        const code = character.codePointAt(0);
        for (let bit = 0; bit < 12; bit++) if (code & (1 << bit))
          this.fillRect(x + (index * 6 + bit % 3) * scale, y + Math.floor(bit / 3) * scale, scale, scale, style?.color ?? 0xffffff);
      }
    },
    measureText(text, style) { return { width: Array.from(text).length * 6 * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
  };
  if (nativeCanvas) target.fillRunLayers = (runs, options) => native.fillRunLayers(target.pixels, target.width, target.height, runs, options).bounds;
  return target;
}

function directCases(api) {
  const target = surface(368, 448, api), pose = { yaw: 0, pitch: 0, lift: 0, squash: 1 };
  let previous, restored = 0;
  const draw = (changes = {}, old = previous, before = () => { restored++; target.clear(0x193726); }) =>
    api.drawKitty(target, changes.character || 'kitty-classic', 'idle', changes.clock ?? 1700,
      { ...pose, ...changes.pose }, changes.cx ?? 184, changes.cy ?? 210, changes.scale ?? 11,
      changes.region || { top: 83, bottom: 342 }, old, before);
  previous = draw();
  const original = target.pixels.slice(), calls = target.bodyCalls;
  check(draw() === previous && target.bodyCalls === calls && restored === 1, '连续相同几何必须在恢复背景前命中');
  for (const changes of [{ pose: { lift: 4 } }, { pose: { yaw: .4 } }, { pose: { pitch: .4 } },
    { clock: 100 }, { character: 'kitty-witch' }, { region: { top: 84, bottom: 342 } },
    { region: { top: 83, bottom: 240 } }, { cx: 195 }, { cy: 220 }]) {
    const before = target.bodyCalls; previous = draw(changes);
    check(target.bodyCalls === before + 1, '几何、眨眼、配色、区域或位置变化必须重画');
  }
  previous = draw({}, undefined);
  // 恢复背景后抛错，或原生批处理失败，都要先撤销旧帧令牌，下一次不能留下空白/残影。
  let caught = false;
  try { draw({ pose: { lift: 4 } }, previous, () => { target.clear(0); throw Error('injected restore failure'); }); }
  catch { caught = true; }
  check(caught, '未触发背景恢复故障');
  let before = target.bodyCalls; previous = draw({}, previous);
  check(target.bodyCalls === before + 1, '背景已清空的旧令牌必须失效');
  samePixelsOnHost(original, target.pixels, '恢复故障重试后像素');
  target.failNext = true; caught = false;
  try { draw({ pose: { lift: 4 } }); } catch { caught = true; }
  check(caught, '未触发原生绘制故障');
  before = target.bodyCalls; previous = draw({}, previous);
  check(target.bodyCalls === before + 1, '绘制故障后的旧令牌必须失效');
  samePixelsOnHost(original, target.pixels, '绘制故障重试后像素');
  const other = surface(368, 448, api);
  api.drawKitty(other, 'kitty-classic', 'idle', 1700, pose, 184, 210, 11, { top: 83, bottom: 342 }, previous);
  check(other.bodyCalls === 1, '不同画布不能复用旧帧');
  target.resize(480, 480); before = target.bodyCalls;
  draw({}, previous);
  check(target.bodyCalls === before + 1, '同一画布尺寸变化必须失效');
  return 16;
}

function renderCases(reference, candidate, useNative = false) {
  let frames = 0, saved = 0, captionCalls = 0, waveformChanges = 0;
  const names = ['idle', 'imu', 'speaking-imu', 'fullscreen', 'caption', 'theme', 'layout', 'characters', 'pages', 'resize'];
  for (const [width, height] of [[320, 448], [368, 448], [480, 480]]) for (const name of names) {
    const expected = surface(width, height, reference), actual = surface(width, height, candidate, useNative);
    const view = reference.initialState(), motion = new reference.CatMotion(() => .37);
    Object.assign(view, { connected: true, authenticated: true, state: 'idle' });
    const form = { page: 'assistant', returnPage: 'assistant', field: 'question', values: {},
      upper: false, symbols: false, busy: false, speechReady: false };
    let prior;
    for (let i = 0; i < 90; i++) {
      const clock = 1000 + i * 67, moving = name.includes('imu');
      const tiltX = moving ? Math.sin(i / 9) * 1.5 : 0, tiltY = moving ? Math.cos(i / 13) * 1.5 : 0;
      view.state = name.includes('speaking') ? 'speaking' : 'idle'; view.level = i % 101;
      const pose = moving || name === 'idle' ? motion.sample(view.state, clock, tiltX, tiltY, view.level)
        : { yaw: 0, pitch: 0, lift: 0, squash: 1 };
      if (name === 'caption') view.assistantText = String(Math.floor(i / 3)).padStart(3, '0');
      if (name === 'theme') view.theme = Math.floor(i / 11) % 2 ? 'light' : 'dark';
      if (name === 'layout') view.assistantText = i % 30 < 10 ? '' : i % 30 < 20 ? 'Short' : 'Long reply '.repeat(15);
      if (name === 'pages') form.page = i % 30 < 20 ? 'assistant' : 'settings';
      if (name === 'resize' && i % 15 === 0) {
        const side = i % 30 ? 512 : 480;
        expected.resize(side, side); actual.resize(side, side);
      }
      const input = { clock, tiltX, tiltY, battery: 80, settings: false, pose, shake: 0,
        fullscreen: name === 'fullscreen' || name === 'layout' && i % 30 < 15,
        character: name === 'characters' ? ['kitty-classic', 'kitty-witch', 'cat', 'kitty-fish', 'kitty-classic'][Math.floor(i / 9) % 5] : 'kitty-classic' };
      delete globalThis.px;
      reference.drawHarness(expected, view, input, form);
      if (useNative) globalThis.px = { util: native };
      try { candidate.drawHarness(actual, view, input, form); }
      finally { delete globalThis.px; }
      samePixelsOnHost(expected.pixels, actual.pixels, name + ' ' + width + 'x' + height + ' frame=' + i);
      if (name === 'fullscreen' && prior) {
        let changed = false;
        for (let y = actual.height - 150; y < actual.height && !changed; y++)
          for (let x = 0; x < actual.width; x++) if (prior[y * actual.width + x] !== actual.pixels[y * actual.width + x]) { changed = true; break; }
        if (changed) waveformChanges++;
      }
      if (name === 'fullscreen') prior = actual.pixels.slice();
      frames++;
    }
    saved += expected.bodyCalls - actual.bodyCalls;
    check(actual.textCalls === expected.textCalls, '缓存不能跳过字幕更新 ' + name);
    if (name === 'caption') captionCalls += actual.textCalls;
    if (name === 'fullscreen' || name === 'caption') check(actual.bodyCalls < 10, name + '静止角色仍在重复绘制');
  }
  check(saved > 1200, '用例必须实际跳过大量连续相同角色');
  check(captionCalls > 100 && waveformChanges > 200, '字幕和全屏波形必须独立更新');
  return { frames, savedBodyDraws: saved, captionCalls, waveformChanges };
}

const nativeOutput = process.argv.find(value => value.startsWith('--native-out='))?.slice('--native-out='.length);
if (nativeOutput) {
  const base = await compile(true, 'iife'), current = await compile(false, 'iife');
  const program = base.outputFiles[0].text + '\nconst reference=__kittyModule;\n' + current.outputFiles[0].text +
    `\nconst candidate=__kittyModule;\n${check}\n${samePixelsOnHost}\n${surface}\n${renderCases}\n` +
    `print(JSON.stringify(renderCases(reference,candidate,true)));`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(nativeOutput, program);
  console.log('生成真实 native Canvas/投影与未缓存 JS 参考的 2700 帧对照：' + nativeOutput);
} else {
  const base = await compile(true), current = await compile(false);
  const reference = await import(`data:text/javascript;base64,${Buffer.from(base.outputFiles[0].text).toString('base64')}`);
  const candidate = await import(`data:text/javascript;base64,${Buffer.from(current.outputFiles[0].text).toString('base64')}`);
  const direct = directCases(candidate), rendered = renderCases(reference, candidate);
  console.log(JSON.stringify({ direct, ...rendered }));
}
