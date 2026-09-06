import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, '06-obeing-pixel/src');
const bundle = await build({ entryPoints: [join(source, 'model.ts')], bundle: true, format: 'esm', write: false });
const model = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const simulatorBundle = await build({ entryPoints: [join(root, '../simulator/src/renderer/src/device-sim/sandbox/runtime/projection.ts')], bundle: true, format: 'esm', write: false });
const simulatorProjection = await import(`data:text/javascript;base64,${Buffer.from(simulatorBundle.outputFiles[0].text).toString('base64')}`);

function legacyRaster(pose, scale, cx, cy) {
    const projected = model.projectCat(pose, scale, cx, cy);
    const step = Math.max(2, Math.round(scale));
    const grid = new Map();
    for (const p of projected) {
        const x = Math.round(p.sx / step) * step, y = Math.round(p.sy / step) * step;
        grid.set(`${x},${y}`, { x, y });
    }
    const pixels = Array.from(grid.values()).sort((a, b) => a.y - b.y || a.x - b.x);
    const runs = [];
    for (const pixel of pixels) {
        const previous = runs[runs.length - 1];
        if (previous && previous.y === pixel.y && previous.x + previous.width === pixel.x) previous.width += step;
        else runs.push({ x: pixel.x, y: pixel.y, width: step });
    }
    return { pixels: pixels.length, runs };
}

let cases = 0;
for (const state of ['idle', 'sleep', 'thinking', 'speaking', 'wake']) {
    for (const width of [320, 368, 480]) for (const scale of [4.4, 6.5, 7.8, 12]) {
        for (const tilt of [-1, -0.55, 0, 0.55, 1]) {
            const pose = model.poseFor(state, 1700 + cases * 17, tilt, -tilt, 68);
            const old = legacyRaster(pose, scale, width / 2, 170);
            const next = model.rasterizeCat(pose, scale, width / 2, 170);
            const runs = Array.from({ length: next.count }, (_, i) => ({ x: next.x[i], y: next.y[i], width: next.width[i] }));
            assert.deepEqual(runs, old.runs);
            assert.equal(next.pixels, old.pixels);
            globalThis.px = { util: simulatorProjection };
            const accelerated = model.rasterizeCat(pose, scale, width / 2, 170);
            assert.deepEqual(Array.from({ length: accelerated.count }, (_, i) => ({ x: accelerated.x[i], y: accelerated.y[i], width: accelerated.width[i] })), old.runs);
            delete globalThis.px;
            cases++;
        }
    }
}
console.log(`[OK] ${cases} poses: optimized raster exactly matches previous drawing runs`);

const output = join(root, '06-obeing-pixel/dist/raster-bench.js');
await build({
    stdin: { contents: `import * as model from './model';
${legacyRaster.toString()}
const poses = Array.from({length: 120}, (_, i) => model.poseFor('speaking', i * 41.67, Math.sin(i / 19), Math.cos(i / 23), 68));
function measure(fn) {
    for (let i = 0; i < 20; i++) fn(poses[i], 7.8, 240, 170);
    const times = [];
    for (let repeat = 0; repeat < 3; repeat++) {
        const start = Date.now();
        for (const pose of poses) fn(pose, 7.8, 240, 170);
        times.push(Date.now() - start);
    }
    return times.sort((a, b) => a - b)[1];
}
const beforeMs = measure(legacyRaster), afterMs = measure(model.rasterizeCat);
print(JSON.stringify({engine: 'QuickJS-ng host', frames: poses.length, beforeMs, afterMs, speedup: beforeMs / afterMs}));`, resolveDir: source, loader: 'ts' },
    bundle: true, format: 'iife', target: 'es2020', outfile: output,
});
if (process.argv[2]) {
    const result = spawnSync(resolve(process.argv[2]), [output], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
} else console.log(`QuickJS benchmark bundle: ${output}`);
