import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const benchmark = await build({ entryPoints: [root + 'examples/07-obeing-harness/fps-benchmark.ts'],
  bundle: true, write: false, format: 'iife', target: 'es2020' });
const projection = await build({ entryPoints: [root + 'simulator/src/renderer/src/device-sim/sandbox/runtime/projection.ts'],
  bundle: true, write: false, format: 'esm' });
const util = await import(`data:text/javascript;base64,${Buffer.from(projection.outputFiles[0].text).toString('base64')}`);
const layersBundle = await build({ entryPoints: [root + 'sdk/src/run-layers.ts'], bundle: true, write: false, format: 'esm' });
const layers = await import(`data:text/javascript;base64,${Buffer.from(layersBundle.outputFiles[0].text).toString('base64')}`);
const counterNames = ['frames', 'updates', 'changedPixels', 'convertedPixels', 'conversionMs', 'updateMs', 'errors'];
const counters = () => Object.fromEntries(counterNames.map(name => [name, 0]));

function device({ failFlush = false } = {}) {
  let now = 0, frame, fps;
  const stats = counters();
  const batchCalls = { runs: 0, rects: 0 };
  const pixels = new Uint32Array(480 * 480), previous = new Uint32Array(pixels.length);
  const fill = (x, y, width, height, color) => {
    const left = Math.max(0, Math.trunc(x)), top = Math.max(0, Math.trunc(y));
    const right = Math.min(480, Math.trunc(x + width)), bottom = Math.min(480, Math.trunc(y + height));
    if (right <= left || bottom <= top) return;
    for (let row = top; row < bottom; row++) pixels.fill(color, row * 480 + left, row * 480 + right);
  };
  const screen = { width: 480, height: 480,
    clear(color) { pixels.fill(color); },
    fillRect: fill,
    fillRects(rects, count = rects.length / 5) {
      for (let i = 0; i < count; i++) fill(...rects.subarray(i * 5, i * 5 + 5));
      now += .2;
    },
    fillRunLayers(runs, options) {
      batchCalls.runs++; now += .3;
      return layers.fillRunLayers(screen, runs, options);
    },
    fillRectLayers(rects, options) {
      batchCalls.rects++; now += .4;
      layers.fillRectLayers(screen, rects, options);
    },
    drawText(text, x, y, style) {
      const scale = style?.scale || 1;
      // 固定字形替身保留文本、位置和颜色的变化，用真实像素比较验证提交行为。
      Array.from(text).forEach((character, index) => {
        const code = character.codePointAt(0);
        for (let bit = 0; bit < 12; bit++) if (code & (1 << bit))
          fill(x + (index * 6 + bit % 3) * scale, y + Math.floor(bit / 3) * scale, scale, scale, style?.color ?? 0xffffff);
      });
    },
    measureText(text, style) { return { width: Array.from(text).length * 6 * (style?.scale || 1), height: 12 * (style?.scale || 1) }; },
    setFps(value) { fps = value; }, onFrame(callback) { frame = callback; },
    frameStats() { now += .75; return { ...stats }; },
    flush() {
      if (failFlush) throw new Error('display flush failed');
      stats.frames++;
      let changed = 0;
      for (let i = 0; i < pixels.length; i++) if (pixels[i] !== previous[i]) changed++;
      if (changed) {
        stats.updates++; stats.changedPixels += changed; stats.convertedPixels += changed;
        stats.conversionMs += .5; stats.updateMs += 2;
        previous.set(pixels);
      }
      now += 2.5;
    }
  };
  const context = vm.createContext({ px: { screen, util: { ...util } }, performance: { now: () => now },
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array });
  vm.runInContext(benchmark.outputFiles[0].text, context);
  return { api: context.__fps, stats, screen, batchCalls, get fps() { return fps; },
    frame(dt = 1000 / 30) { now += 1000 / 30; frame(dt); screen.flush(); } };
}

function warm(value) {
  let count = 0;
  while (!value.api.snapshot().ready && ++count < 500) value.frame();
  assert.ok(value.api.snapshot().ready, '全部形态预热必须完成');
  return count;
}

test('真实 benchmark 分帧预热、独立 bounds 计时与 reset 计数', () => {
  const value = device();
  assert.equal(value.fps, 30);
  assert.throws(() => value.api.reset(), /still warming/);
  const count = warm(value);
  assert.ok(count > 300 && count < 400, `分帧预热次数 ${count}`);
  assert.equal(value.api.snapshot().measuring, false);
  value.api.reset();
  for (let i = 0; i < 100; i++) value.frame();
  const result = value.api.snapshot();
  assert.equal(result.frames, 100);
  assert.equal(result.framebufferDelta.frames, 100);
  assert.ok(result.framebufferDelta.updates > 0);
  assert.equal(result.callbackFps, result.frames * 1000 / result.elapsedMs);
  assert.equal(result.submittedFps, result.framebufferDelta.updates * 1000 / result.elapsedMs);
  for (const name of ['bounds', 'project', 'faceProject', 'rect', 'draw', 'flush']) assert.ok(result.stats[name].count > 0, name);
  assert.ok(value.batchCalls.runs > 0, '角色主体必须经过 fillRunLayers 批处理');
  value.api.configure({ character: 'kitty-classic', tilt: 1.5 });
  assert.equal(value.api.snapshot().ready, false);
  assert.equal(value.api.snapshot().measuring, false);
  assert.throws(() => value.api.reset(), /still warming/);
});

test('Kitty 原生批处理调用计入 rect 时间', () => {
  const value = device();
  value.api.configure({ character: 'kitty-classic', tilt: 1.5 });
  value.frame(); value.api.reset();
  for (let i = 0; i < 12; i++) value.frame();
  assert.ok(value.batchCalls.rects > 0, 'Kitty 必须经过 fillRectLayers 批处理');
  const result = value.api.snapshot();
  assert.ok(result.stats.rect.count > 0);
  assert.ok(result.stats.rect.max >= .399, '批处理耗时必须计入 rect');
});

test('静态画面的回调帧率和屏幕提交帧率分别统计', () => {
  const value = device();
  value.api.configure({ character: 'kitty-classic' });
  value.frame(0); value.api.reset();
  for (let i = 0; i < 30; i++) value.frame(0);
  const result = value.api.snapshot();
  assert.equal(result.frames, 30);
  assert.equal(result.framebufferDelta.frames, 30);
  assert.equal(result.framebufferDelta.updates, 0);
  assert.equal(result.submittedFps, 0);
  assert.ok(result.callbackFps > 0);
});

test('关闭分项插桩保留成功绘制和真实提交计数，且能重新开启', () => {
  const value = device();
  value.api.configure({ character: 'kitty-classic', profile: false });
  value.frame(0); value.api.reset();
  for (let i = 0; i < 30; i++) value.frame(0);
  const result = value.api.snapshot();
  assert.equal(result.frames, 30);
  assert.equal(result.framebufferDelta.frames, 30);
  assert.equal(result.framebufferDelta.updates, 0);
  assert.ok(result.callbackFps > 0);
  for (const item of Object.values(result.stats)) assert.equal(item.count, 0);
  value.api.configure({ profile: true, tilt: 1.5 });
  value.frame(); value.api.reset(); value.frame();
  assert.ok(value.api.snapshot().stats.rect.count > 0);
});

test('屏幕提交失败不能把 benchmark 标记 ready', () => {
  const value = device({ failFlush: true });
  value.api.configure({ character: 'kitty-classic' });
  assert.throws(() => value.frame(), /display flush failed/);
  assert.equal(value.api.snapshot().ready, false);
});

const hostUrl = new URL('./measure-obeing-device.mjs', import.meta.url);
const hostSource = readFileSync(hostUrl, 'utf8');
// 只替换ESM静态导入及模块URL，正式入口的参数解析、部署、测量和错误处理原样执行。
assert.equal(hostSource.match(/^import [^\n]*;$/gm)?.length, 7, '新增主机依赖时显式补齐测试替身');
const executableHost = hostSource.replace(/^import [^\n]*;\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(hostUrl.href));
const manifest = JSON.parse(readFileSync(new URL('../07-obeing-harness/pixelbox.json', import.meta.url), 'utf8'));

async function runHost({ measurement = {}, ready = true, duration = '1', deploy = false,
  deployedSha, hasBenchmark = true, appId = manifest.id, existingResults = false } = {}) {
  let time = 0, closed = 0, connected = 0, polls = 0, reset = false, deployed = false;
  const calls = [], reports = [], files = new Map(), pushes = [];
  const output = path.join(root, 'test-output');
  const bundle = Buffer.from('test benchmark bundle');
  const expectedSha = createHash('sha256').update(bundle).digest('hex');
  const arguments_ = ['--host', 'test-device', '--output', output, '--seconds', duration, '--scenarios', 'idle'];
  if (!deploy) arguments_.push('--no-deploy');
  const client = {
    async hello() { return { id: 'test-device' }; },
    async pushApp(value, data, progress) {
      pushes.push({ manifest: value, files: data });
      progress({ phase: 'begin' }); deployed = true; progress({ phase: 'end' });
    },
    async evalJs(code) {
      calls.push(code);
      if (code.startsWith('JSON.stringify({id:px.app.id')) return JSON.stringify({
        id: deployed ? manifest.id : appId, manifest: '{}', sha: deployed ? deployedSha ?? expectedSha : 'previous-bundle' });
      if (code === 'typeof __fps === "object"') return hasBenchmark ? 'true' : 'false';
      if (code.startsWith('__fps.configure(')) { reset = false; return 'true'; }
      if (code === '__fps.reset();true') { reset = true; return 'true'; }
      if (code === 'JSON.stringify(__fps.snapshot())') {
        if (!reset) {
          polls++;
          return JSON.stringify({ ready: ready && polls > 1, warming: 351, warmedShapes: 11 });
        }
        return JSON.stringify({ ready: true, measuring: true, elapsedMs: 1000, frames: 30,
          framebuffer: Object.fromEntries(counterNames.map(name => [name, 90000])),
          framebufferDelta: { frames: 30, updates: 24, changedPixels: 1200, convertedPixels: 1500,
            conversionMs: 15, updateMs: 48, errors: 0 }, ...measurement });
      }
      throw new Error('unexpected eval: ' + code);
    }, close() { closed++; }
  };
  class FakeDate extends Date { constructor() { super(time); } static now() { return time; } }
  const process = { exitCode: 0 };
  const context = { process, Date: FakeDate, URL, path, fileURLToPath, createHash,
    parseArgs(options) { return parseArgs({ ...options, args: arguments_ }); },
    fs: {
      mkdirSync() {},
      existsSync(file) { return existingResults && file === path.join(output, 'results.json'); },
      writeFileSync(file, data) { files.set(file, data); },
      readFileSync(file) {
        if (file.endsWith('/pixelbox.json')) return JSON.stringify(manifest);
        if (files.has(file)) return files.get(file);
        throw new Error('unexpected read: ' + file);
      }
    },
    async build(options) { files.set(options.outfile, bundle); },
    DevdClient: { async connect() { connected++; return client; } },
    console: { log(...args) { reports.push(args); } },
    setTimeout(callback, ms) { time += ms; queueMicrotask(callback); }
  };
  let error;
  try { await vm.runInNewContext('(async()=>{\n' + executableHost + '\n})()', context, { timeout: 60000 }); }
  catch (value) { error = value; }
  const resultsPath = path.join(output, 'results.json');
  return { calls, reports, files, process, closed, connected, polls, pushes, error, expectedSha,
    result: files.has(resultsPath) ? JSON.parse(files.get(resultsPath))[0] : null };
}

test('主机复用设备 reset 基线，分别计算提交率和回调率', async () => {
  const value = await runHost();
  assert.equal(value.process.exitCode, 0);
  assert.equal(value.closed, 1);
  assert.equal(value.polls, 2);
  assert.equal(value.result.callbackFps, 30);
  assert.equal(value.result.submittedFps, 24);
  assert.equal(value.result.conversionMeanMs, .5);
  assert.equal(value.result.updateMeanMs, 2);
  assert.equal(value.result.changedPixels, 1200);
  assert.equal(value.result.fps, 24);
  assert.ok(value.calls.some(code => code.startsWith('__fps.configure(') && code.includes('"profile":false')));
});

test('正式主机入口拒绝缺少 framebuffer 统计的设备', async () => {
  const value = await runHost({ measurement: { framebuffer: null, framebufferDelta: null } });
  assert.equal(value.process.exitCode, 1);
  assert.equal(value.result, null);
  assert.equal(value.closed, 1);
});

for (const bad of [-1, null, 'invalid', .5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`拒绝设备无效计数 ${JSON.stringify(bad)}`, async () => {
    const value = await runHost({ measurement: { framebufferDelta: { ...counters(), frames: bad } } });
    assert.equal(value.process.exitCode, 1);
    assert.equal(value.closed, 1);
    assert.equal(value.result, null);
    assert.ok(value.reports.some(([, kind, body]) => kind === 'FAIL' && body.includes('计数')));
  });
}

test('预热超时不会 reset 或开始测量', async () => {
  const value = await runHost({ ready: false });
  assert.equal(value.process.exitCode, 1);
  assert.equal(value.closed, 1);
  assert.ok(!value.calls.includes('__fps.reset();true'));
  assert.ok(value.reports.some(([, kind, body]) => kind === 'FAIL' && body.includes('预热超时')));
});

test('应用测量被中断时关闭连接并报告失败', async () => {
  const value = await runHost({ measurement: { measuring: false } });
  assert.equal(value.process.exitCode, 1);
  assert.equal(value.closed, 1);
  assert.equal(value.result, null);
});

test('无效测量时长在连接设备前被拒绝', async () => {
  const value = await runHost({ duration: '0' });
  assert.match(value.error?.message, /--seconds/);
  assert.equal(value.connected, 0);
});

for (const elapsedMs of [undefined, null, '1000', 0, -1, NaN, Infinity]) {
  test(`正式主机入口拒绝无效设备计时 ${String(elapsedMs)}`, async () => {
    const value = await runHost({ measurement: { elapsedMs } });
    assert.equal(value.process.exitCode, 1);
    assert.equal(value.result, null);
    assert.ok(!value.reports.some(([, kind]) => kind === 'RESULT'));
  });
}

for (const frames of [undefined, null, '30', -30, .5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`正式主机入口拒绝无效回调帧数 ${String(frames)}`, async () => {
    const value = await runHost({ measurement: { frames } });
    assert.equal(value.process.exitCode, 1);
    assert.equal(value.result, null);
  });
}

for (const delta of [
  { frames: 30, updates: 31 },
  { frames: 29, updates: 24 },
  { frames: 30, updates: 24, changedPixels: 1501, convertedPixels: 1500 },
]) {
  test(`拒绝不一致的原生计数 ${JSON.stringify(delta)}`, async () => {
    const value = await runHost({ measurement: { framebufferDelta: { ...counters(), ...delta } } });
    assert.equal(value.process.exitCode, 1);
    assert.equal(value.result, null);
  });
}

test('显示更新失败不写成功结果，也不先广播 RESULT', async () => {
  const value = await runHost({ measurement: { framebufferDelta: {
    ...counters(), frames: 30, updates: 24, errors: 1 } } });
  assert.equal(value.process.exitCode, 1);
  assert.equal(value.result, null);
  assert.ok(!value.reports.some(([, kind]) => kind === 'RESULT'));
  assert.ok(value.reports.some(([, kind, body]) => kind === 'FAIL' && body.includes('显示更新错误')));
});

test('正式主机入口保留静态画面的零提交率', async () => {
  const value = await runHost({ measurement: { framebufferDelta: { ...counters(), frames: 30 } } });
  assert.equal(value.process.exitCode, 0);
  assert.equal(value.result.submittedFps, 0);
  assert.equal(value.result.callbackFps, 30);
});

test('部署后只有正确 bundle SHA 和 benchmark 对象都确认才开始测量', async () => {
  const value = await runHost({ deploy: true, appId: 'previous-app' });
  assert.equal(value.process.exitCode, 0);
  assert.equal(value.pushes.length, 1);
  assert.equal(value.pushes[0].manifest.id, manifest.id);
  assert.equal(value.pushes[0].files[0].path, 'main.js');
  assert.equal(value.result.submittedFps, 24);
  assert.ok(value.calls.filter(code => code.startsWith('JSON.stringify({id:px.app.id')).length >= 3);
});

for (const options of [{ deployedSha: 'wrong-bundle' }, { hasBenchmark: false }]) {
  test(`部署身份未确认时拒绝测量 ${JSON.stringify(options)}`, async () => {
    const value = await runHost({ deploy: true, ...options });
    assert.equal(value.process.exitCode, 1);
    assert.equal(value.pushes.length, 1);
    assert.equal(value.result, null);
    assert.ok(!value.calls.includes('__fps.reset();true'));
  });
}

test('no-deploy 仍要求正确应用 ID', async () => {
  const value = await runHost({ appId: 'other-app' });
  assert.equal(value.process.exitCode, 1);
  assert.equal(value.pushes.length, 0);
  assert.equal(value.result, null);
});

test('已有结果目录不覆盖也不连接设备', async () => {
  const value = await runHost({ existingResults: true });
  assert.match(value.error?.message, /已有测量结果/);
  assert.equal(value.connected, 0);
});
