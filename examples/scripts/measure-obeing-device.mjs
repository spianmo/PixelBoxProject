import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { DevdClient } from '../../sdk/dist/devd.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  host: { type: 'string' }, output: { type: 'string' }, seconds: { type: 'string', default: '30' },
  scenarios: { type: 'string', default: 'idle,fullscreen,speaking-imu,kitty-classic' },
  profile: { type: 'boolean', default: false },
  'no-deploy': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node examples/scripts/measure-obeing-device.mjs --host IP --output DIR [--seconds 30] [--scenarios idle,fullscreen,speaking-imu,kitty-classic] [--profile] [--no-deploy]');
  process.exit(0);
}
const duration = Number(values.seconds);
if (!values.host || !values.output || !Number.isFinite(duration) || duration < 1 || duration > 3600)
  throw new Error('--host、--output 必填，--seconds 范围为 1..3600');
const scenarios = {
  idle: { state: 'idle', fullscreen: false, tilt: 0, character: 'cat' },
  fullscreen: { state: 'idle', fullscreen: true, tilt: 0, character: 'cat' },
  'speaking-imu': { state: 'speaking', fullscreen: false, tilt: 1.5, character: 'cat' },
  'kitty-classic': { state: 'idle', fullscreen: false, tilt: 0, character: 'kitty-classic' },
  'fullscreen-speaking': { state: 'speaking', fullscreen: true, tilt: 1.5, character: 'cat' },
};
const names = values.scenarios.split(',');
if (!names.length || names.some(name => !Object.hasOwn(scenarios, name)))
  throw new Error(`未知场景；可选 ${Object.keys(scenarios).join(',')}`);
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: true });
if (fs.existsSync(path.join(output, 'results.json'))) throw new Error('输出目录已有测量结果，请使用新目录');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'examples/07-obeing-harness/pixelbox.json'), 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const report = (label, value) => console.log(new Date().toISOString(), label, JSON.stringify(value));
const identity = "JSON.stringify({id:px.app.id,manifest:px.storage.fs.readText('/app/manifest.json'),sha:Array.from(new Uint8Array(px.util.sha256(px.storage.fs.readBytes('/app/main.js'))),v=>v.toString(16).padStart(2,'0')).join('')})";
let client;
try {
  client = await DevdClient.connect(values.host, { port: 8765, connectTimeoutMs: 10000 });
  save('device-original.json', JSON.parse(await client.evalJs(identity, 15000)));
  if (!values['no-deploy']) {
    const bundle = path.join(output, 'main.js');
    await build({ entryPoints: [path.join(root, 'examples/07-obeing-harness/fps-benchmark.ts')],
      bundle: true, format: 'esm', target: 'es2020', outfile: bundle });
    const data = fs.readFileSync(bundle);
    const sha256 = createHash('sha256').update(data).digest('hex');
    await client.pushApp(manifest, [{ path: 'main.js', data }], progress => {
      if (progress.phase === 'begin' || progress.phase === 'end') report('PUSH', progress);
    });
    // 热更新重建 VM；确认实际运行的是本次 bundle，不能仅凭应用 ID 判成功。
    const deadline = Date.now() + 30000;
    let current;
    while (Date.now() < deadline) {
      try {
        current = JSON.parse(await client.evalJs(identity, 5000));
        if (current.id === manifest.id && current.sha === sha256 &&
            await client.evalJs('typeof __fps === "object"', 5000) === 'true') break;
      } catch {}
      await delay(300);
    }
    if (!current || current.id !== manifest.id || current.sha !== sha256 ||
        await client.evalJs('typeof __fps === "object"', 5000) !== 'true')
      throw new Error('benchmark bundle 未在 30 秒内启动');
  }
  const original = JSON.parse(await client.evalJs(identity, 10000));
  if (original.id !== manifest.id || await client.evalJs('typeof __fps === "object"', 5000) !== 'true')
    throw new Error('设备未运行 example07 benchmark');
  save('initial.json', { hello: await client.hello(), original, duration, scenarios: names, profile: values.profile,
    startedAt: new Date().toISOString(), method: '有效 RGB565 变化且 FBIO_UPDATE 成功；不代表物理面板扫描率' });
  const results = [];
  for (const name of names) {
    await client.evalJs(`__fps.configure(${JSON.stringify({ ...scenarios[name], profile: values.profile })});true`, 5000);
    // 等应用分帧完成全部形态预热后再清零，共用设备单调时钟的计时基线。
    const deadline = Date.now() + 60000;
    let warmup;
    while (Date.now() < deadline) {
      warmup = JSON.parse(await client.evalJs('JSON.stringify(__fps.snapshot())', 5000));
      if (warmup.ready) break;
      await delay(250);
    }
    if (!warmup?.ready) throw new Error(`${name} 预热超时`);
    report('WARMED', { stage: name, frames: warmup.warming, shapes: warmup.warmedShapes });
    await client.evalJs('__fps.reset();true', 5000);
    await delay(duration * 1000);
    const value = JSON.parse(await client.evalJs('JSON.stringify(__fps.snapshot())', 10000));
    if (!value.ready || !value.measuring || !Number.isFinite(value.elapsedMs) ||
        value.elapsedMs <= 0 || !value.framebufferDelta)
      throw new Error(`${name} 测量中断或缺少 framebuffer 计数`);
    const delta = value.framebufferDelta;
    if (!Number.isSafeInteger(value.frames) || value.frames < 0)
      throw new Error(`${name} 无效回调帧数`);
    for (const key of ['frames', 'updates', 'changedPixels', 'convertedPixels', 'conversionMs', 'updateMs', 'errors'])
      if (!Number.isFinite(delta[key]) || delta[key] < 0) throw new Error(`${name} 无效计数 ${key}`);
    // 帧数与像素数来自原生整数累计值；拒绝不一致的旧协议或损坏快照。
    for (const key of ['frames', 'updates', 'changedPixels', 'convertedPixels', 'errors'])
      if (!Number.isSafeInteger(delta[key])) throw new Error(`${name} 无效整数计数 ${key}`);
    if (value.frames > delta.frames || delta.updates > delta.frames || delta.changedPixels > delta.convertedPixels)
      throw new Error(`${name} framebuffer 计数关系不一致`);
    // 失败样本不能先写入成功结果，避免仅消费 results.json 的工具误判通过。
    if (delta.errors) throw new Error(`${name} 发生 ${delta.errors} 次显示更新错误`);
    value.stage = name;
    value.callbackFps = value.frames * 1000 / value.elapsedMs;
    value.submittedFrames = delta.updates;
    value.fps = value.submittedFps = delta.updates * 1000 / value.elapsedMs;
    for (const key of ['changedPixels', 'convertedPixels', 'conversionMs', 'updateMs', 'errors']) value[key] = delta[key];
    value.conversionMeanMs = delta.frames ? delta.conversionMs / delta.frames : 0;
    value.updateMeanMs = delta.updates ? delta.updateMs / delta.updates : 0;
    value.warmup = { frames: warmup.warming, warmedShapes: warmup.warmedShapes };
    results.push(value);
    save('results.json', results);
    report('RESULT', value);
  }
} catch (error) {
  report('FAIL', { message: error.message });
  process.exitCode = 1;
} finally {
  client?.close();
}
