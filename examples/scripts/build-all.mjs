#!/usr/bin/env node
/**
 * 统一验证脚本:对每个示例执行
 *   1) tsc --noEmit 严格类型检查(契约 = ../../sdk/types/pixelbox.d.ts)
 *   2) esbuild --bundle 打包为单文件 ES2020 → dist/main.js(与 pixelbox build 同参数)
 * 任一示例失败则退出码非 0。
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url))); // examples/
const tscBin = require.resolve('typescript/bin/tsc');

// 以 pixelbox.json 的存在识别示例目录
const dirs = readdirSync(root)
  .filter((d) => existsSync(join(root, d, 'pixelbox.json')))
  .sort();

if (dirs.length === 0) {
  console.error('未找到任何示例(缺少 pixelbox.json)');
  process.exit(1);
}

let failed = false;
for (const dir of dirs) {
  console.log(`\n=== ${dir} ===`);
  // 1) 类型检查
  const tsc = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', join(root, dir, 'tsconfig.json')], {
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    failed = true;
    console.error(`[FAIL] ${dir}: tsc 类型检查未通过`);
    continue;
  }
  // 2) 打包
  try {
    await build({
      entryPoints: [join(root, dir, 'src', 'main.ts')],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      outfile: join(root, dir, 'dist', 'main.js'),
      logLevel: 'silent',
    });
    console.log(`[OK] ${dir}: tsc + esbuild 通过 → ${dir}/dist/main.js`);
  } catch (err) {
    failed = true;
    console.error(`[FAIL] ${dir}: esbuild 打包失败:`, err instanceof Error ? err.message : err);
  }
}

console.log(failed ? '\n存在失败项' : `\n全部 ${dirs.length} 个示例验证通过`);
process.exit(failed ? 1 : 0);
