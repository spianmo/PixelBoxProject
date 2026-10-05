import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function load(part, reference, suffix = '') {
  const path = reference ? `examples/scripts/fixtures/${part}-lowcost-reference.ts` : `examples/06-obeing-pixel/src/${part}.ts`;
  const result = await build({ stdin: { contents: readFileSync(root + path, 'utf8') +
    (part === 'render' && !reference ? '\nexport { waveform };' : ''),
    resolveDir: root + path.slice(0, path.lastIndexOf('/')), loader: 'ts' },
    bundle: true, write: false, format: 'esm' });
  // 独立实例使prepareCat的冷缓存/部分预热路径不会被前一组测试掩盖。
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + '\n//' + suffix).toString('base64')}`);
}
const reference = await load('model', true), candidate = await load('model', false);
const states = ['idle','sleep','wake','listening','thinking','speaking','muted','error','offline','pairing','login'];
const original = new reference.CatMotion(() => .371), actual = new candidate.CatMotion(() => .371);
let poses = 0, preparations = 0, getterCases = 0;
// 频繁打断过渡，比较字段顺序、可选weights存在性和返回对象与内部current的隔离。
for (let i = 0; i < 12000; i++) {
  const state = states[Math.floor(i / (i % 3 ? 37 : 5)) % states.length], clock = i * 31.25;
  const tiltX = i % 127 === 0 ? NaN : Math.sin(i / 17) * 1.5;
  const tiltY = i % 151 === 0 ? Infinity : Math.cos(i / 23) * 1.5;
  const a = actual.sample(state, clock, tiltX, tiltY, i % 101), b = original.sample(state, clock, tiltX, tiltY, i % 101);
  assert.deepEqual(Object.keys(a), Object.keys(b)); assert.deepEqual(a, b); poses++;
  if (i % 19 === 0) { a.yaw = b.yaw = 77; a.shape = b.shape = 'error'; a.extra = b.extra = 'outside'; }
}
for (const mode of ['plain', 'changing', 'throws']) {
  const observations = [];
  for (const api of [await load('model', true, mode), await load('model', false, mode)]) {
    const trace = []; let reads = 0;
    for (let i = 0; i < 500; i++) {
      const shape = api.CAT_SHAPES[Math.floor(i / 43) % api.CAT_SHAPES.length];
      const weights = new Float32Array(api.CAT_SHAPES.length); weights[i % weights.length] = .4; weights[(i + 3) % weights.length] = .6;
      const pose = { get shape() { trace.push('shape'); return shape; }, get weights() {
        trace.push('weights');
        if (mode === 'throws' && i % 29 === 0) throw Error('weights failed');
        if (mode === 'changing') return ++reads % 5 ? weights : undefined;
        return i % 7 ? undefined : weights;
      } };
      let result; try { result = api.prepareCat(pose, i % 3 ? 32 : 400); } catch (error) { result = error.message; }
      trace.push(result); preparations++;
    }
    observations.push(trace);
  }
  assert.deepEqual(observations[0], observations[1], mode + ' prepareCat读取顺序和预热结果'); getterCases++;
}

const renderers = [await load('render', true), await load('render', false)];
let renderGetterCases = 0;
for (const shake of [0, .15, .1666666666667, .6, 1]) for (const mode of ['plain', 'changing', 'throws']) {
  const observations = [];
  for (const api of renderers) {
    const trace = [], calls = []; let clockReads = 0, stateReads = 0;
    const rawView = { state: 'speaking', level: 67 };
    const view = new Proxy(rawView, { get(object, key) {
      trace.push('v.' + key);
      if (key === 'state' && mode === 'changing') return ++stateReads % 3 ? 'speaking' : 'thinking';
      return object[key];
    } });
    const rawInput = { clock: 1800, fullscreen: true, shake, tiltX: .2, tiltY: -.3, character: 'cat',
      pose: { shape: 'talk', yaw: .22, pitch: -.1, lift: 2, squash: .95 } };
    const input = new Proxy(rawInput, { get(object, key) {
      trace.push('i.' + key);
      if (key === 'clock') {
        clockReads++;
        if (mode === 'throws' && clockReads === 2) throw Error('clock failed');
        if (mode === 'changing') return object[key] + clockReads * 30;
      }
      return object[key];
    } });
    const screen = { width: 448, height: 448, fillRect(...args) { calls.push(args); } };
    let error;
    try { api.drawCat(screen, view, input, 220, 11, { top: 42, bottom: 390 }); } catch (e) { error = e.message; }
    observations.push({ trace, calls, error });
  }
  assert.deepEqual(observations[0], observations[1], `${shake}/${mode} drawCat字段和绘制顺序`); renderGetterCases++;
}
for (const mode of ['plain', 'changing', 'throws']) {
  const observations = [];
  for (const api of renderers) {
    const trace = [], calls = []; let reads = 0;
    const view = { level: 67, muted: false, get state() {
      trace.push('state'); reads++;
      if (mode === 'throws' && reads === 2) throw Error('state failed');
      return mode === 'changing' ? states[reads % states.length] : 'speaking';
    } };
    const input = { get clock() { trace.push('clock'); return 1800; } };
    let error;
    try { api.waveform({ width: 448, fillRect(...args) { calls.push(args); } }, view, input, 350, 0x123456); }
    catch (e) { error = e.message; }
    observations.push({ trace, calls, error });
  }
  assert.deepEqual(observations[0], observations[1], mode + ' waveform字段和绘制顺序'); renderGetterCases++;
}
console.log(JSON.stringify({ poses, preparations, getterCases, renderGetterCases }));
