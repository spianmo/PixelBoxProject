/**
 * 应用构建:esbuild 把 src/main.ts 打包为单文件 ES2020 dist/main.js
 * (无 sourcemap、无 npm 运行时依赖假设、纯 JS 库可打入),
 * 并拷贝 assets/ 与 manifest 到 dist/。
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadManifest } from './manifest';
import type { PixelboxManifest } from './protocol';
import type { PushFile } from './devd';

/** 构建选项 */
export interface BuildOptions {
  /** 是否压缩产物,默认 false(保持可读,便于设备端排错) */
  minify?: boolean;
}

/** 构建产物中的单个文件 */
export interface BuildFile {
  /** dist 内相对路径(POSIX 风格) */
  relPath: string;
  /** 绝对路径 */
  absPath: string;
  /** 字节数 */
  size: number;
}

/** 构建结果 */
export interface BuildResult {
  projectDir: string;
  distDir: string;
  manifest: PixelboxManifest;
  files: BuildFile[];
}

/** 递归收集 dist 下所有文件(跳过 .DS_Store 等隐藏杂项) */
function walkDist(distDir: string, base = ''): BuildFile[] {
  const out: BuildFile[] = [];
  const entries = fs.readdirSync(path.join(distDir, base), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') {
      continue;
    }
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    const abs = path.join(distDir, rel);
    if (entry.isDirectory()) {
      out.push(...walkDist(distDir, rel));
    } else if (entry.isFile()) {
      out.push({ relPath: rel, absPath: abs, size: fs.statSync(abs).size });
    }
  }
  return out;
}

/**
 * 构建应用:
 *   1. 读取并校验 pixelbox.json
 *   2. esbuild 打包 src/main.ts(或 src/main.js)→ dist/<entry>(ES2020、单文件、无 sourcemap)
 *   3. 拷贝 assets/ → dist/assets/
 *   4. 写入 dist/pixelbox.json
 */
export async function buildApp(projectDir: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const manifest = loadManifest(projectDir);

  const entryCandidates = [
    path.join(projectDir, 'src', 'main.ts'),
    path.join(projectDir, 'src', 'main.js'),
  ];
  const entry = entryCandidates.find((p) => fs.existsSync(p));
  if (!entry) {
    throw new Error(`未找到入口文件 src/main.ts(项目目录: ${projectDir})`);
  }

  // 每次全量重建 dist,避免残留旧产物
  const distDir = path.join(projectDir, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const outfile = path.join(distDir, manifest.entry);
  try {
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      // 输出 ESM 语法(无 import 时即普通脚本),QuickJS-ng 以模块方式求值
      format: 'esm',
      target: ['es2020'],
      platform: 'neutral',
      mainFields: ['module', 'main'],
      sourcemap: false,
      minify: opts.minify ?? false,
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'silent',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`esbuild 打包失败:\n${msg}`);
  }

  // 拷贝资源目录(.gitkeep / .DS_Store 等占位与杂项不进包)
  const assetsDir = path.join(projectDir, 'assets');
  if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
    fs.cpSync(assetsDir, path.join(distDir, 'assets'), {
      recursive: true,
      filter: (src) => {
        const name = path.basename(src);
        return name !== '.DS_Store' && name !== '.gitkeep';
      },
    });
  }

  // manifest 一并进 dist,便于查验与被其他工具消费
  fs.writeFileSync(path.join(distDir, 'pixelbox.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return { projectDir, distDir, manifest, files: walkDist(distDir) };
}

/**
 * 把构建结果转为待推送文件列表。
 * 注意:manifest 内容经 app.push_begin 的 manifest 参数下发(devd 自行落盘 manifest.json),
 * 因此 dist/pixelbox.json 不重复推送。
 */
export function collectPushFiles(build: BuildResult): PushFile[] {
  return build.files
    .filter((f) => f.relPath !== 'pixelbox.json')
    .map((f) => ({ path: f.relPath, data: fs.readFileSync(f.absPath) }));
}
