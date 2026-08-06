#!/usr/bin/env node
/**
 * pixelbox CLI — PixelBox 像素盒应用开发命令行工具
 *
 * 命令一览:
 *   create <dir>   创建应用模板
 *   build          esbuild 打包 src/main.ts → dist/main.js,拷贝 assets 与 manifest
 *   push           devd 协议推送 dist/ 到设备(热更新)
 *   dev            监听改动 → 增量构建 → 自动推送 → 实时日志(开发闭环)
 *   logs           订阅设备日志
 *   devices        mDNS 发现局域网设备
 *   eval <code>    在设备 JS VM 中执行一段代码
 */
import { Command } from 'commander';
import { watch as chokidarWatch } from 'chokidar';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import pc from 'picocolors';

import { DevdClient, type PushProgress } from './devd';
import { discoverDevices, parseDirectTarget, type DeviceTarget } from './discovery';
import { buildApp, collectPushFiles, type BuildResult } from './build';
import { loadManifest } from './manifest';
import { createApp } from './create';
import { fmtBytes, formatDeviceEvent, printDeviceTable, term } from './term';
import { sdkVersion } from './pkg';

/** 统一失败出口 */
function fail(e: unknown): never {
  term.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

/** 解析毫秒参数 */
function parseMs(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 解析 --device 参数并定位目标设备:
 *   - ip / ip:port / *.local 直连
 *   - 名称 → mDNS 匹配
 *   - 未指定 → mDNS 发现;唯一设备自动选择,多设备交互选择
 */
async function selectDevice(device: string | undefined, timeoutMs: number): Promise<DeviceTarget> {
  if (device) {
    const direct = parseDirectTarget(device);
    if (direct) {
      return direct;
    }
    term.info(`正在通过 mDNS 查找设备 "${device}" ...`);
    const list = await discoverDevices(timeoutMs);
    const lower = device.toLowerCase();
    const hit =
      list.find((d) => d.name.toLowerCase() === lower) ??
      list.find(
        (d) => d.name.toLowerCase().includes(lower) || d.host.toLowerCase().startsWith(lower),
      );
    if (!hit) {
      throw new Error(
        `未发现名为 "${device}" 的设备;可用 "pixelbox devices" 查看在线设备,或直接 --device <ip>`,
      );
    }
    return { host: hit.ip, port: hit.port, name: hit.name };
  }

  term.info('未指定设备,正在通过 mDNS 发现 _pixelbox._tcp ...');
  const list = await discoverDevices(timeoutMs);
  if (list.length === 0) {
    throw new Error('未发现任何 PixelBox 设备;请确认设备与电脑在同一局域网,或用 --device <ip> 指定');
  }
  if (list.length === 1) {
    const d = list[0];
    term.info(`发现唯一设备: ${d.name} (${d.ip}:${d.port})`);
    return { host: d.ip, port: d.port, name: d.name };
  }

  printDeviceTable(list);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`请选择设备编号 [1-${list.length}]: `)).trim();
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) {
        const d = list[n - 1];
        return { host: d.ip, port: d.port, name: d.name };
      }
      term.warn('输入无效,请输入列表中的编号');
    }
  } finally {
    rl.close();
  }
}

/** 生成推送进度打印回调(TTY 下单行刷新百分比) */
function makePushPrinter(): (p: PushProgress) => void {
  const tty = process.stdout.isTTY === true;
  return (p) => {
    if (p.phase === 'begin') {
      term.info(`开始推送应用包 (${fmtBytes(p.totalBytes)})`);
      return;
    }
    if (p.phase === 'file' && tty && p.totalBytes > 0) {
      const pct = Math.floor((p.sentBytes / p.totalBytes) * 100);
      process.stdout.write(
        `\r  推送中 ${pct}% (${fmtBytes(p.sentBytes)}/${fmtBytes(p.totalBytes)}) ${p.file ?? ''}   `,
      );
      return;
    }
    if (p.phase === 'end') {
      if (tty) {
        process.stdout.write('\r\x1b[2K');
      }
      term.ok(`推送完成 (${fmtBytes(p.totalBytes)}),设备正在热重启应用`);
    }
  };
}

/** 构建并打印摘要 */
async function runBuild(projectDir: string, minify: boolean): Promise<BuildResult> {
  const t0 = Date.now();
  const result = await buildApp(projectDir, { minify });
  const total = result.files.reduce((s, f) => s + f.size, 0);
  term.ok(
    `构建完成: ${result.manifest.name}@${result.manifest.version} → ${path.relative(process.cwd(), result.distDir) || 'dist'} ` +
      `(${result.files.length} 个文件, ${fmtBytes(total)}, ${Date.now() - t0}ms)`,
  );
  return result;
}

/** 构建 + 推送(push / dev 共用) */
async function buildAndPushOnce(projectDir: string, client: DevdClient, minify: boolean): Promise<void> {
  const result = await runBuild(projectDir, minify);
  const files = collectPushFiles(result);
  await client.pushApp(result.manifest, files, makePushPrinter());
}

// ------------------------------------------------------------
// 命令定义
// ------------------------------------------------------------

const program = new Command();
program
  .name('pixelbox')
  .description('PixelBox 像素盒应用开发 CLI:创建 / 构建 / 推送热更新 / 日志 / 设备发现 / 远程执行')
  .version(sdkVersion(), '-V, --version', '输出 SDK 版本号');

program
  .command('create <dir>')
  .description('创建 PixelBox 应用模板(pixelbox.json + tsconfig + src/main.ts 像素动画示例)')
  .option('--name <显示名>', '应用显示名称(默认取目录名)')
  .option('--id <应用ID>', '应用 ID,反向域名风格(默认 com.example.<目录名>)')
  .option('--force', '目标目录非空时仍强制生成', false)
  .action((dir: string, opts: { name?: string; id?: string; force?: boolean }) => {
    try {
      const info = createApp(dir, { name: opts.name, id: opts.id, force: opts.force });
      term.ok(`应用已创建: ${info.dir}`);
      term.info(`应用 ID: ${info.appId} · SDK 场景: ${info.scenario === 'npm' ? 'npm 安装包' : '仓库内源码'}`);
      term.info(`d.ts 引用: ${info.typesRef}`);
      console.log('');
      console.log('后续步骤:');
      console.log(pc.cyan(`  cd ${dir}`));
      console.log(pc.cyan('  npm install          # 安装 TypeScript,启用类型检查(pnpm 用户: pnpm install)'));
      console.log(pc.cyan('  pixelbox build       # 打包到 dist/'));
      console.log(pc.cyan('  pixelbox dev         # 连接真机,保存即热更新'));
    } catch (e) {
      fail(e);
    }
  });

program
  .command('build')
  .description('构建应用:esbuild 打包 src/main.ts → dist/main.js(ES2020 单文件),拷贝 assets 与 manifest')
  .option('-C, --dir <路径>', '应用项目目录', '.')
  .option('--minify', '压缩产物', false)
  .action(async (opts: { dir: string; minify: boolean }) => {
    try {
      await runBuild(path.resolve(opts.dir), opts.minify);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('push')
  .description('推送应用到设备(devd 协议热更新);默认先重新构建,--no-build 跳过')
  .option('-d, --device <ip|名称>', '目标设备 IP / 主机名 / mDNS 名称(缺省时自动发现)')
  .option('-C, --dir <路径>', '应用项目目录', '.')
  .option('--no-build', '跳过构建,直接推送现有 dist/')
  .option('--minify', '构建时压缩产物', false)
  .option('--timeout <毫秒>', 'mDNS 发现超时', '3000')
  .action(async (opts: { device?: string; dir: string; build: boolean; minify: boolean; timeout: string }) => {
    let client: DevdClient | null = null;
    try {
      const projectDir = path.resolve(opts.dir);
      loadManifest(projectDir); // 提前校验,发现问题不必再连设备
      const target = await selectDevice(opts.device, parseMs(opts.timeout, 3000));
      term.info(`连接设备 ${target.name} (${target.host}:${target.port}) ...`);
      client = await DevdClient.connect(target.host, { port: target.port });
      const hello = await client.hello();
      term.info(`已连接 ${hello.name} · 固件 ${hello.fw} · 空闲堆 ${fmtBytes(hello.heapFree)}`);

      if (opts.build) {
        await buildAndPushOnce(projectDir, client, opts.minify);
      } else {
        const result = await buildResultFromDist(projectDir);
        await client.pushApp(result.manifest, collectPushFiles(result), makePushPrinter());
      }
      client.close();
      process.exit(0);
    } catch (e) {
      client?.close();
      fail(e);
    }
  });

/** --no-build 时从现有 dist 组装推送清单 */
async function buildResultFromDist(projectDir: string): Promise<BuildResult> {
  const fs = await import('node:fs');
  const manifest = loadManifest(projectDir);
  const distDir = path.join(projectDir, 'dist');
  if (!fs.existsSync(path.join(distDir, manifest.entry))) {
    throw new Error(`dist/${manifest.entry} 不存在,请先执行 "pixelbox build"(或去掉 --no-build)`);
  }
  // 复用 build.ts 的目录收集逻辑:此处直接重新扫描 dist
  const { readdirSync, statSync } = fs;
  const walk = (base: string): Array<{ relPath: string; absPath: string; size: number }> => {
    const out: Array<{ relPath: string; absPath: string; size: number }> = [];
    for (const name of readdirSync(path.join(distDir, base))) {
      if (name === '.DS_Store') {
        continue;
      }
      const rel = base === '' ? name : `${base}/${name}`;
      const abs = path.join(distDir, rel);
      if (statSync(abs).isDirectory()) {
        out.push(...walk(rel));
      } else {
        out.push({ relPath: rel, absPath: abs, size: statSync(abs).size });
      }
    }
    return out;
  };
  return { projectDir, distDir, manifest, files: walk('') };
}

program
  .command('dev')
  .description('开发模式:监听 src/ 与 assets/ → 增量构建 → 热更新推送 → 常驻实时日志')
  .option('-d, --device <ip|名称>', '目标设备 IP / 主机名 / mDNS 名称(缺省时自动发现)')
  .option('-C, --dir <路径>', '应用项目目录', '.')
  .option('--minify', '构建时压缩产物', false)
  .option('--timeout <毫秒>', 'mDNS 发现超时', '3000')
  .action(async (opts: { device?: string; dir: string; minify: boolean; timeout: string }) => {
    try {
      const projectDir = path.resolve(opts.dir);
      loadManifest(projectDir);
      const target = await selectDevice(opts.device, parseMs(opts.timeout, 3000));
      term.info(`目标设备: ${target.name} (${target.host}:${target.port})`);

      let client: DevdClient | null = null;
      let building = false;
      let pendingChange = false;
      let exiting = false;

      /** 取得可用连接(断线自动重建并重新订阅日志) */
      const ensureClient = async (): Promise<DevdClient> => {
        if (client && !client.isClosed) {
          return client;
        }
        const c = await DevdClient.connect(target.host, { port: target.port });
        c.onEvent((event, data) => {
          console.log(formatDeviceEvent(event, data));
        });
        c.onClose(() => {
          client = null;
          if (!exiting) {
            term.warn('与设备连接断开,2 秒后重连 ...');
            setTimeout(() => {
              void reconnect();
            }, 2000);
          }
        });
        await c.subscribeLogs();
        client = c;
        return c;
      };

      const reconnect = async (): Promise<void> => {
        if (exiting) {
          return;
        }
        try {
          await ensureClient();
          term.ok('已重新连接设备,日志订阅恢复');
        } catch {
          setTimeout(() => {
            void reconnect();
          }, 2000);
        }
      };

      /** 构建 + 推送;构建期间的新改动合并到下一轮 */
      const buildAndPush = async (): Promise<void> => {
        if (building) {
          pendingChange = true;
          return;
        }
        building = true;
        try {
          const c = await ensureClient();
          await buildAndPushOnce(projectDir, c, opts.minify);
        } catch (e) {
          term.error(e instanceof Error ? e.message : String(e));
        }
        building = false;
        if (pendingChange) {
          pendingChange = false;
          void buildAndPush();
        }
      };

      // 首次:全量构建 + 推送
      await buildAndPush();

      // 监听 src/ assets/ pixelbox.json,防抖 250ms
      const watcher = chokidarWatch(
        [path.join(projectDir, 'src'), path.join(projectDir, 'assets'), path.join(projectDir, 'pixelbox.json')],
        {
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        },
      );
      let debounce: NodeJS.Timeout | null = null;
      watcher.on('all', (event, file) => {
        term.dim(`变更: ${event} ${path.relative(projectDir, file)}`);
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
          void buildAndPush();
        }, 250);
      });

      process.on('SIGINT', () => {
        exiting = true;
        void watcher.close();
        client?.close();
        console.log('');
        term.info('已退出 dev 模式');
        process.exit(0);
      });

      term.info('dev 模式已启动:保存 src/ 或 assets/ 内文件即热更新;Ctrl+C 退出');
    } catch (e) {
      fail(e);
    }
  });

program
  .command('logs')
  .description('订阅并实时打印设备日志(console.* 与 ESP_LOG)')
  .option('-d, --device <ip|名称>', '目标设备 IP / 主机名 / mDNS 名称(缺省时自动发现)')
  .option('--timeout <毫秒>', 'mDNS 发现超时', '3000')
  .action(async (opts: { device?: string; timeout: string }) => {
    try {
      const target = await selectDevice(opts.device, parseMs(opts.timeout, 3000));
      term.info(`连接设备 ${target.name} (${target.host}:${target.port}) ...`);
      const client = await DevdClient.connect(target.host, { port: target.port });
      const hello = await client.hello();
      term.info(`已连接 ${hello.name} · 固件 ${hello.fw} · 应用 ${hello.app}@${hello.appVersion}`);
      client.onEvent((event, data) => {
        console.log(formatDeviceEvent(event, data));
      });
      client.onClose((reason) => {
        term.error(`连接断开: ${reason}`);
        process.exit(1);
      });
      await client.subscribeLogs();
      term.info('日志订阅中,Ctrl+C 退出');
      process.on('SIGINT', () => {
        client.close();
        process.exit(0);
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('devices')
  .description('通过 mDNS 发现局域网内的 PixelBox 设备并列出')
  .option('--timeout <毫秒>', 'mDNS 发现超时', '3000')
  .action(async (opts: { timeout: string }) => {
    try {
      const timeoutMs = parseMs(opts.timeout, 3000);
      term.info(`正在发现 _pixelbox._tcp 服务 (${timeoutMs}ms) ...`);
      const list = await discoverDevices(timeoutMs);
      if (list.length === 0) {
        term.warn('未发现任何设备;请确认设备已开机并与电脑处于同一局域网');
        process.exit(0);
      }
      printDeviceTable(list);
      term.ok(`共发现 ${list.length} 台设备`);
      process.exit(0);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('eval <code>')
  .description('在设备 JS VM 中执行一段代码并打印结果,如 pixelbox eval "px.system.info()"')
  .option('-d, --device <ip|名称>', '目标设备 IP / 主机名 / mDNS 名称(缺省时自动发现)')
  .option('--timeout <毫秒>', 'mDNS 发现超时', '3000')
  .action(async (code: string, opts: { device?: string; timeout: string }) => {
    let client: DevdClient | null = null;
    try {
      const target = await selectDevice(opts.device, parseMs(opts.timeout, 3000));
      client = await DevdClient.connect(target.host, { port: target.port });
      const result = await client.evalJs(code);
      console.log(result);
      client.close();
      process.exit(0);
    } catch (e) {
      client?.close();
      fail(e);
    }
  });

// 子命令统一中文帮助选项
program.helpOption('-h, --help', '显示帮助信息');
program.helpCommand('help [command]', '显示指定命令的帮助');
for (const cmd of program.commands) {
  cmd.helpOption('-h, --help', '显示帮助信息');
}

program.parseAsync(process.argv).catch(fail);
