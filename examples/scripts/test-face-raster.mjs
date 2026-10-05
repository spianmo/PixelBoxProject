import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = `
import { CAT_SHAPES, CatMotion, facePoints, posedShapePoint, projectPoint, projectionAngles,
    rasterizeFace } from './examples/06-obeing-pixel/src/model';

const native = globalThis.native || globalThis.px.util;
const states = ['offline','pairing','login','idle','sleep','wake','listening','thinking','speaking','muted','error'];
const templates = new Set();
const equal = (actual, expected, label) => {
    if (actual !== expected) throw Error(label + ': ' + actual + ' !== ' + expected);
};
let cases = 0, pointsChecked = 0, nativeCalls = 0, mixedRoundingDifferences = 0;
let previousResult;
function check(state, clock, level, pose, scale, cx, cy, step = Math.max(2, Math.round(scale))) {
    const voxels = facePoints(state, clock, level);
    const original = JSON.stringify(voxels), originalPose = JSON.stringify(pose);
    templates.add(voxels.map(p => p.x + ',' + p.y).join(';'));
    const angles = projectionAngles(pose);
    const shaped = voxels.map(voxel => posedShapePoint(voxel, pose));
    const expected = shaped.map(point => {
        const p = projectPoint(point, pose, scale, cx, cy, angles);
        return [Math.round(p.sx / step) || 0, Math.round(p.sy / step) || 0];
    });
    const verify = (result, label) => {
        equal(result.count, voxels.length, label + ' count');
        equal(result.upper.length, voxels.length, label + ' upper.length');
        if (previousResult) equal(result, previousResult, '复用输出对象');
        previousResult = result;
        for (let i = 0; i < result.count; i++) {
            equal(result.xy[i * 2], expected[i][0], label + ' gx ' + cases + ':' + i);
            equal(result.xy[i * 2 + 1], expected[i][1], label + ' gy ' + cases + ':' + i);
            equal(result.upper[i], voxels[i].y < 2 ? 1 : 0, label + ' upper ' + i);
        }
    };
    // 不存在 px、util 或 projectPoints 三种状态都必须使用原 Double 投影。
    if (cases % 3 === 0) delete globalThis.px;
    else globalThis.px = cases % 3 === 1 ? {} : { util: {} };
    verify(rasterizeFace(state, clock, level, pose, scale, cx, cy, step), 'fallback');
    const before = nativeCalls;
    globalThis.px = { util: { projectPoints(points, options, output) {
        nativeCalls++;
        equal(points.length, shaped.length * 3, 'native 输入点数');
        for (let i = 0; i < shaped.length; i++) for (let axis = 0; axis < 3; axis++) {
            const key = ['x', 'y', 'z'][axis];
            equal(points[i * 3 + axis], shaped[i][key], '最终 Float32 坐标 ' + cases + ':' + i + ':' + key);
        }
        native.projectPoints(points, options, output);
    } } };
    verify(rasterizeFace(state, clock, level, pose, scale, cx, cy, step), 'native');
    equal(nativeCalls - before, 1, '每帧一次 native 调用');
    equal(JSON.stringify(voxels), original, '体素不变');
    equal(JSON.stringify(pose), originalPose, 'pose/weights 不变');
    pointsChecked += voxels.length;
    cases++;
}

// 穷举所有状态、眨眼及嘴型边界和 11 个形态；同一模板的缓存跨状态复用。
for (const state of states) for (const clock of [0, 139.999, 140, 200, 500, 5299.999, 5300, 5439.999, 5440])
    for (const level of [0, 35, 35.0001, 100]) for (let i = 0; i < CAT_SHAPES.length; i++) {
        const pose = { shape: CAT_SHAPES[i], yaw: (i - 5) * .21, pitch: (i % 3 - 1) * .29,
            lift: (i % 5 - 2) * 2.125, squash: .74 + i * .041 };
        check(state, clock, level, pose, [4.4, 7.8, 14][i % 3], 240.375, 220.625);
    }
equal(templates.size, 9, '全部 9 个有限面部模板');

let seed = 0x537bf619;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
for (let i = 0; i < 1600; i++) {
    const weights = new Float32Array(CAT_SHAPES.length);
    if (i % 4 !== 0) for (let j = 0; j < weights.length; j++)
        weights[j] = i % 4 === 1 && random() < .7 ? 0 : random();
    if (i % 4 === 2) {
        const total = weights.reduce((a, b) => a + b, 0);
        for (let j = 0; j < weights.length; j++) weights[j] /= total;
    }
    const pose = { weights, yaw: (random() - .5) * 6.28, pitch: (random() - .5) * 2.9,
        squash: .6 + random() * .8, lift: (random() - .5) * 32 };
    const state = states[i % states.length], clock = random() * 12000, level = random() * 100;
    check(state, clock, level, pose, .7 + random() * 24, (random() - .5) * 1500, (random() - .5) * 1500);
    // 证明用逐项 Float32 blendPoints 替代会更改输入，防止测试只覆盖巧合等值权重。
    for (const voxel of facePoints(state, clock, level)) {
        const expected = posedShapePoint(voxel, pose);
        let x = 0, y = 0, z = 0;
        for (let j = 0; j < weights.length; j++) {
            if (!weights[j]) continue;
            const point = posedShapePoint(voxel, { ...pose, weights: undefined, shape: CAT_SHAPES[j] });
            x = Math.fround(x + point.x * weights[j]);
            y = Math.fround(y + point.y * weights[j]);
            z = Math.fround(z + point.z * weights[j]);
        }
        if (x !== expected.x || y !== expected.y || z !== expected.z) mixedRoundingDifferences++;
    }
}
if (!mixedRoundingDifferences) throw Error('缺少能区分 Double 累加和逐项 Float32 的权重');

// 状态每 93 ms 改变，早于 420 ms 的形态过渡结束，覆盖连续打断和复用 weights。
const motion = new CatMotion(random);
for (let i = 0; i < 360; i++) {
    const state = states[Math.floor(i / 3) % states.length], clock = i * 31;
    check(state, clock, i % 101, motion.sample(state, clock, Math.sin(i / 7), Math.cos(i / 9), i % 101),
        8.2 + (i % 5) * .1, 160.125, 220.875);
}

// 对准第一个点的半像素，再分别扰动两边，覆盖负坐标及奇数/偶数二级 grid 舍入。
for (const shape of CAT_SHAPES) for (const grid of [1, 2, 3, 4, 7, 14, 3.5])
    for (const offset of [-1e-9, 0, 1e-9]) {
        const pose = { shape, yaw: .713, pitch: -.291, lift: 1.25, squash: .93 };
        const point = posedShapePoint(facePoints('idle', 200, 0)[0], pose), scale = 7.75;
        const a = projectionAngles(pose), x = point.x * a.cosYaw + point.z * a.sinYaw;
        const z = -point.x * a.sinYaw + point.z * a.cosYaw;
        const y = point.y * pose.squash * a.cosPitch - z * a.sinPitch;
        const depth = point.y * a.sinPitch + z * a.cosPitch, perspective = 64 / (64 - depth);
        const cx = -17.5 - x * scale * perspective + offset;
        const cy = -10.5 - y * scale * perspective - pose.lift + offset;
        check('idle', 200, 0, pose, scale, cx, cy, grid);
    }

// facePoints 仍返回独立体素，调用方改动它不能污染模板缓存。
const owned = facePoints('speaking', 200, 100);
owned[0].x = 1e6; owned.length = 0;
check('speaking', 200, 100, { yaw: 0, pitch: 0, lift: 0, squash: 1 }, 8, 160, 220);

// 原生中断必须向外传播；下一帧重新调用要完整重写结果，不泄露半帧。
if (typeof globalThis.armInterrupt === 'function') {
    let interrupted = false;
    globalThis.px = { util: native };
    armInterrupt(0);
    try { rasterizeFace('error', 200, 0, { shape: 'error', yaw: .1, pitch: .1, lift: 0, squash: 1 }, 8, 160, 220); }
    catch (error) { interrupted = String(error).includes('test native interruption'); }
    armInterrupt(-1);
    if (!interrupted) throw Error('未传播真实原生中断');
    check('error', 200, 0, { shape: 'error', yaw: .1, pitch: .1, lift: 0, squash: 1 }, 8, 160, 220);
}
globalThis.px = { util: native };
globalThis.faceRasterTestResult = { cases, pointsChecked, nativeCalls, templates: templates.size, mixedRoundingDifferences };
`;

const simulator = await build({ entryPoints: [join(root, 'simulator/src/renderer/src/device-sim/sandbox/runtime/projection.ts')],
    bundle: true, write: false, format: 'esm' });
const util = await import(`data:text/javascript;base64,${Buffer.from(simulator.outputFiles[0].text).toString('base64')}`);
const bundled = await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, bundle: true,
    write: false, format: 'iife', target: 'es2020' });
const previous = globalThis.px;
try {
    globalThis.px = { util };
    await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
    console.log('PASS face raster fallback/simulator:', JSON.stringify(globalThis.faceRasterTestResult));
} finally {
    if (previous === undefined) delete globalThis.px; else globalThis.px = previous;
    delete globalThis.faceRasterTestResult;
}

// 可选独立 QuickJS 原生验证，不修改或构建共享固件树。
if (process.argv[2]) {
    const hostBuild = resolve(process.argv[2]);
    const outputDir = join(root, 'tmp/face-raster-tests');
    mkdirSync(outputDir, { recursive: true });
    const script = join(outputDir, 'face-raster.js'), binary = join(outputDir, 'face-raster-native');
    writeFileSync(script, bundled.outputFiles[0].text);
    const result = spawnSync('cc', ['-std=gnu11', '-O2', '-g', '-Wall', '-Wextra', '-Werror', '-DPX_TEST_PROJECTION',
        '-fsanitize=undefined', '-fno-sanitize-recover=all', '-I' + join(hostBuild, 'generated/quickjs-ng'),
        '-I' + join(root, 'firmware-nuttx/include'), join(root, 'firmware-nuttx/src/projection.c'),
        join(root, 'firmware-nuttx/tests/test_projection.c'), join(hostBuild, 'libpixelbox_quickjs.a'),
        '-lpthread', '-lm', '-o', binary], { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, '独立 QuickJS 原生投影编译失败');
    const run = spawnSync(binary, [script], { stdio: 'inherit', timeout: 60000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, '面部栅格在真实 QuickJS + 原生投影下不一致');
    console.log('PASS face raster QuickJS + native + UBSan（含真实中断后恢复）');
}
