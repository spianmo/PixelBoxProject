#!/usr/bin/env node
// 同一份回归在 Node 和真实 QuickJS 执行；宿主耗时不能当作 ESP32 实测。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

function legacyRmsLevel(pcm) {
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) return 0;
    const samples = new Int16Array(pcm);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
    return Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 400));
}

function verifyRms() {
    let cases = 0;
    function compare(pcm, description) {
        const before = new Uint8Array(pcm).slice();
        const expected = legacyRmsLevel(pcm), actual = rmsLevel(pcm);
        if (actual !== expected) throw Error(`${description}: ${actual} !== ${expected}`);
        const after = new Uint8Array(pcm);
        for (let i = 0; i < after.length; i++) {
            if (after[i] !== before[i]) throw Error(`${description}: PCM 被修改`);
        }
        cases++;
    }
    for (const length of [0, 1, 3, 127]) compare(new ArrayBuffer(length), `invalid-${length}`);
    // 全部 int16 单样本覆盖每个取整门槛、正负满量程与饱和区。
    const single = new Int16Array(1);
    for (let sample = -32768; sample <= 32767; sample++) {
        single[0] = sample;
        compare(single.buffer, `single-${sample}`);
    }
    const sizes = [1, 2, 3, 127, 160, 319, 320, 640, 2048, 24000];
    for (const size of sizes) {
        const frame = new Int16Array(size);
        for (const amplitude of [0, 1, -1, 40, 41, 122, 123, 8150, 8151, 8192, 32767, -32768]) {
            frame.fill(amplitude);
            compare(frame.buffer, `constant-${size}-${amplitude}`);
        }
        for (let i = 0; i < size; i++) frame[i] = i % 2 ? 32767 : -32768;
        compare(frame.buffer, `alternating-${size}`);
    }
    // 固定随机种子兼顾未饱和小信号和满量程噪音，避免全随机只验证钳制 100。
    let seed = 0x493e5173;
    for (let round = 0; round < 500; round++) {
        const size = sizes[round % sizes.length];
        const frame = new Int16Array(size), divisor = 1 + round % 32;
        for (let i = 0; i < size; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
            frame[i] = (seed >> 16) / divisor;
        }
        compare(frame.buffer, `random-${round}-${size}`);
    }
    console.log(JSON.stringify({ test: 'obeing-rms-equivalence', cases, exact: true }));
}

function benchmarkRms() {
    for (const samples of [160, 320, 640, 2048]) {
        const frame = new Int16Array(samples);
        for (let i = 0; i < samples; i++) frame[i] = (i * 4771 % 12001) - 6000;
        const pcm = frame.buffer, iterations = Math.ceil(2000000 / samples);
        let checksum = 0;
        function measure(fn) {
            for (let i = 0; i < 100; i++) checksum += fn(pcm);
            const started = Date.now();
            for (let i = 0; i < iterations; i++) checksum += fn(pcm);
            return Date.now() - started;
        }
        const before = [], after = [];
        // 交替执行顺序，降低缓存与宿主负载变化对单次比较的影响。
        for (let repeat = 0; repeat < 5; repeat++) {
            if (repeat % 2) { after.push(measure(rmsLevel)); before.push(measure(legacyRmsLevel)); }
            else { before.push(measure(legacyRmsLevel)); after.push(measure(rmsLevel)); }
        }
        before.sort((a, b) => a - b); after.sort((a, b) => a - b);
        console.log(JSON.stringify({ engine: 'QuickJS-ng host', samples, iterations,
            beforeMs: before[2], afterMs: after[2], speedup: before[2] / after[2], checksum }));
    }
}

const source = join(dirname(dirname(fileURLToPath(import.meta.url))), '06-obeing-pixel/src');
const quickjs = process.argv[2];
const bundle = await build({ stdin: { contents: `import { rmsLevel } from './state';
${legacyRmsLevel.toString()}
${verifyRms.toString()}
verifyRms();
${quickjs ? `${benchmarkRms.toString()}\nbenchmarkRms();` : ''}`,
    resolveDir: source, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2020' });
if (!quickjs) {
    runInNewContext(bundle.outputFiles[0].text, { console }, { timeout: 60000 });
} else {
    const temporary = await mkdtemp(join(tmpdir(), 'pixelbox-obeing-rms-'));
    try {
        const file = join(temporary, 'rms.js');
        await writeFile(file, bundle.outputFiles[0].text);
        const result = spawnSync(resolve(quickjs), ['--app-root', temporary, '--data-root', temporary,
            '--turn-timeout-ms', '55000', '--timeout-ms', '58000', file], { stdio: 'inherit', timeout: 60000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, '真实 QuickJS RMS 回归或基准失败');
    } finally { await rm(temporary, { recursive: true, force: true }); }
}
