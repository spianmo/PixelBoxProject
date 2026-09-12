#!/usr/bin/env node
// 与逐点反投影生成的快照对比，覆盖四款、睁闭眼、正面/倾斜及预览/普通/全屏区域。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '06-obeing-pixel/src');
const bundle = await build({ entryPoints: [join(source, 'kitty.ts')], bundle: true, write: false, format: 'esm', target: 'es2020' });
const { drawKitty } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const expected = JSON.parse(await readFile(new URL('./fixtures/kitty-projection.json', import.meta.url), 'utf8'));
let cases = 0, calls = 0;
for (const name of ['classic', 'witch', 'fish', 'scarf']) for (const state of ['idle', 'sleep']) for (const scale of [4.4, 11, 14]) {
    const hash = createHash('sha256');
    for (let i = 0; i < 40; i++) {
        const pixels = new Uint32Array(368 * 448);
        const screen = { width: 368, height: 448, fillRect(x, y, w, h, color) {
            calls++;
            for (let row = Math.max(0, Math.round(y)); row < Math.min(448, Math.round(y + h)); row++) {
                pixels.fill(color, row * 368 + Math.max(0, Math.round(x)), row * 368 + Math.min(368, Math.round(x + w)));
            }
        } };
        const pose = { yaw: i ? Math.sin(i / 5) * 1.4 : 0, pitch: i ? Math.cos(i / 7) * 0.7 : 0, lift: Math.sin(i / 3) * 3, squash: 1 };
        const region = scale === 4.4 ? undefined : scale === 11 ? { top: 83, bottom: 404 } : { top: 42, bottom: 381 };
        const bounds = drawKitty(screen, `kitty-${name}`, state, 1700, pose, 184, 210, scale, region);
        assert.ok(bounds.left >= 0 && bounds.right <= screen.width && bounds.top >= (region?.top ?? 0) && bounds.bottom <= (region?.bottom ?? screen.height), '投影及阴影不得越过角色区域');
        hash.update(Buffer.from(pixels.buffer)); hash.update(JSON.stringify(bounds)); cases++;
    }
    assert.equal(hash.digest('hex'), expected.hashes[`${name}/${state}/${scale}`], `${name}/${state}/${scale}: 轮廓、颜色和刷新范围应与独立反投影一致`);
}
assert.ok(calls < expected.calls * 0.7, '合并色段后绘图调用至少减少30%');
console.log(JSON.stringify({ cases, oldCalls: expected.calls, calls, reduction: 1 - calls / expected.calls }));

if (process.argv[2]) {
    // 使用仓库同款QuickJS，桌面耗时用于趋势比较，不作为ESP32帧率承诺。
    const benchmark = `import {drawKitty} from './kitty';
const screen={width:368,height:448,fillRect(){}};
for(const name of ['classic','witch','fish','scarf']){
 const cold=Date.now();drawKitty(screen,'kitty-'+name,'idle',1700,{yaw:.7,pitch:.3,lift:0,squash:1},184,210,11,{top:83,bottom:342});
 const coldMs=Date.now()-cold,t=Date.now();
 for(let i=0;i<120;i++)drawKitty(screen,'kitty-'+name,i%3?'idle':'sleep',1700,{yaw:Math.sin(i/13),pitch:Math.cos(i/17)*.6,lift:0,squash:1},184,210,11,{top:83,bottom:342});
 print(JSON.stringify({name,coldMs,frames:120,ms:Date.now()-t}));
}`;
    const built = await build({ stdin: { contents: benchmark, resolveDir: source, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2020' });
    const path = join(root, '06-obeing-pixel/.artifacts/kitty-benchmark.js');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, built.outputFiles[0].text);
    const result = spawnSync(resolve(process.argv[2]), [path], { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0);
}
