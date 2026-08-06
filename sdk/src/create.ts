/**
 * pixelbox create — 应用模板生成
 *
 * 关键点:模板 tsconfig 对 SDK 内 types/pixelbox.d.ts 的引用路径按场景写入 —
 *   - SDK 经包管理器安装(npm/pnpm 均可,包根路径含 node_modules):写
 *     "node_modules/@pixelbox/sdk/types/pixelbox.d.ts",并把 @pixelbox/sdk 写进模板
 *     devDependencies(npm/pnpm install 后路径即成立;pnpm 符号链接布局下 tsc 沿链接可解析);
 *   - SDK 位于仓库源码内(monorepo 内直接运行 dist/cli.js):写指向仓库内
 *     sdk/types/pixelbox.d.ts 的相对路径,devDependencies 用 file: 引用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sdkRoot, sdkTypesPath, sdkVersion } from './pkg';

/** 创建选项 */
export interface CreateOptions {
  /** 应用显示名称,默认取目录名 */
  name?: string;
  /** 应用 ID,默认 com.example.<目录名> */
  id?: string;
  /** 目标目录非空时仍强制生成 */
  force?: boolean;
}

/** 创建结果 */
export interface CreateResult {
  /** 应用目录绝对路径 */
  dir: string;
  /** SDK 安装场景 */
  scenario: 'npm' | 'repo';
  /** 模板 tsconfig 引用的 d.ts 路径 */
  typesRef: string;
  appName: string;
  appId: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 生成示例入口 src/main.ts(像素动画:弹跳小球 + HSV 变色 + 触摸交互) */
function mainTsTemplate(appName: string): string {
  return `/**
 * ${appName} — PixelBox 像素动画示例
 *
 * 全局对象 px 的完整 API 见 SDK 内 types/pixelbox.d.ts(tsconfig 已引用,编辑器可补全)。
 * 本示例演示:逐帧渲染 onFrame、基础绘图、HSV 颜色工具、触摸输入、应用退出收尾。
 */

const W = px.screen.width;
const H = px.screen.height;

/** 弹跳小球 */
interface Ball {
  x: number;
  y: number;
  vx: number; // 像素/秒
  vy: number;
  hue: number; // HSV 色相 0-360
  r: number; // 半径
}

const balls: Ball[] = [];
for (let i = 0; i < 6; i++) {
  balls.push({
    x: W * 0.2 + Math.random() * W * 0.6,
    y: H * 0.2 + Math.random() * H * 0.6,
    vx: (Math.random() * 2 - 1) * 120,
    vy: (Math.random() * 2 - 1) * 120,
    hue: Math.random() * 360,
    r: 4 + Math.floor(Math.random() * 6),
  });
}

px.screen.setFps(30);

const stopFrame = px.screen.onFrame((dt) => {
  const s = dt / 1000;
  px.screen.clear(px.color.BLACK);

  for (const b of balls) {
    b.x += b.vx * s;
    b.y += b.vy * s;
    // 撞墙反弹
    if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx);
    } else if (b.x > W - b.r) {
      b.x = W - b.r;
      b.vx = -Math.abs(b.vx);
    }
    if (b.y < b.r) {
      b.y = b.r;
      b.vy = Math.abs(b.vy);
    } else if (b.y > H - b.r) {
      b.y = H - b.r;
      b.vy = -Math.abs(b.vy);
    }
    // 色相随时间流转
    b.hue = (b.hue + 90 * s) % 360;
    px.screen.fillCircle(Math.round(b.x), Math.round(b.y), b.r, px.color.hsv(b.hue, 100, 100));
  }

  // 居中标题
  const title = 'PixelBox';
  const m = px.screen.measureText(title, { font: 'pixel12', scale: 2 });
  px.screen.drawText(title, Math.floor((W - m.width) / 2), 16, {
    font: 'pixel12',
    scale: 2,
    color: px.color.WHITE,
  });
  // onFrame 回调返回后自动 flush,无需手动提交
});

// 点按屏幕:所有小球朝触点飞去
px.input.onTouch((ev) => {
  if (ev.type !== 'down') {
    return;
  }
  for (const b of balls) {
    b.vx = (ev.x - b.x) * 1.5;
    b.vy = (ev.y - b.y) * 1.5;
  }
});

// 热更新替换 / 停止前收尾
px.app.onExit(() => {
  stopFrame();
  console.log('应用退出,已停止渲染');
});

console.log(\`你好,PixelBox!屏幕 \${W}x\${H},应用 \${px.app.name}@\${px.app.version}\`);
`;
}

/** 生成模板 README.md */
function readmeTemplate(appName: string, scenario: 'npm' | 'repo', typesRef: string): string {
  const scenarioNote =
    scenario === 'npm'
      ? '当前引用的是包管理器安装的 SDK 包内路径,先执行 `npm install`(或 `pnpm install`)该路径才会存在。'
      : '当前引用的是仓库内 sdk/types/pixelbox.d.ts 的相对路径,无需安装即可类型检查。';
  return `# ${appName}

PixelBox 像素盒应用(由 \`pixelbox create\` 生成)。

## 目录结构

\`\`\`
├── pixelbox.json   # 应用 manifest(id/name/version/entry/assets)
├── tsconfig.json   # TS 严格模式;files 引用 SDK 的设备 API 声明
├── src/main.ts     # 应用入口(esbuild 打包为 dist/main.js)
└── assets/         # 静态资源,构建时原样拷贝进应用包
\`\`\`

## 快速开始

包管理器 npm / pnpm 任选其一(模板不锁定包管理器):

\`\`\`bash
npm install          # 安装 TypeScript(类型检查用);pnpm 用户: pnpm install
npm run typecheck    # tsc --noEmit 类型检查;      pnpm 用户: pnpm run typecheck
pixelbox build       # 打包到 dist/(ES2020 单文件 + assets + manifest)
pixelbox push        # 推送到真机(mDNS 自动发现,或 --device <ip>)
pixelbox dev         # 开发闭环:监听改动 → 增量构建 → 热更新推送 → 实时日志
\`\`\`

## 类型说明

\`tsconfig.json\` 的 \`files\` 字段引用了 SDK 契约文件:

\`\`\`
${typesRef}
\`\`\`

${scenarioNote}
该文件为唯一事实源,提供 \`px.*\` 全部设备 API 的全局类型(屏幕/音频/语音/网络/传感器等),
请勿修改;编辑器(VS Code 等)可据此获得完整补全与签名提示。
`;
}

/** 内部小工具:写文件(自动建目录) */
function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 创建应用模板,返回创建信息 */
export function createApp(targetDir: string, opts: CreateOptions = {}): CreateResult {
  const dir = path.resolve(targetDir);

  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir).filter((n) => n !== '.DS_Store');
    if (entries.length > 0 && !opts.force) {
      throw new Error(`目标目录非空: ${dir}(可加 --force 强制生成)`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });

  const rawBase = path.basename(dir);
  const slug =
    rawBase
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pixelbox-app';
  const appName = opts.name ?? rawBase;
  const appId = opts.id ?? `com.example.${slug}`;

  // 场景检测:SDK 包根路径含 node_modules 即视为 npm 安装场景
  const root = sdkRoot();
  const scenario: 'npm' | 'repo' = root.split(path.sep).includes('node_modules') ? 'npm' : 'repo';

  // 用真实路径计算相对引用,规避 /tmp -> /private/tmp 这类符号链接带来的 .. 偏差
  const realDir = fs.realpathSync(dir);
  const typesRef =
    scenario === 'npm'
      ? 'node_modules/@pixelbox/sdk/types/pixelbox.d.ts'
      : toPosix(path.relative(realDir, fs.realpathSync(sdkTypesPath())));
  const sdkDep =
    scenario === 'npm'
      ? `^${sdkVersion()}`
      : `file:${toPosix(path.relative(realDir, fs.realpathSync(root)))}`;

  // pixelbox.json(manifest,见 architecture.md §6)
  const manifest = {
    id: appId,
    name: appName,
    version: '1.0.0',
    entry: 'main.js',
    assets: ['assets/**'],
    minFirmware: '0.1.0',
  };

  // tsconfig:strict + noEmit(实际打包交给 esbuild),files 引用设备 API 声明
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2020'],
      strict: true,
      noEmit: true,
      types: [],
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src/**/*.ts'],
    files: [typesRef],
  };

  // package.json:脚本委托给 pixelbox CLI;typescript 仅用于类型检查
  const pkg = {
    name: slug,
    version: '1.0.0',
    private: true,
    description: `${appName} — PixelBox 像素盒应用`,
    scripts: {
      build: 'pixelbox build',
      dev: 'pixelbox dev',
      push: 'pixelbox push',
      typecheck: 'tsc --noEmit',
    },
    devDependencies: {
      '@pixelbox/sdk': sdkDep,
      typescript: '^5.6.0',
    },
  };

  const gitignore = `node_modules/
dist/
.DS_Store
`;

  writeFile(path.join(dir, 'pixelbox.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFile(path.join(dir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
  writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFile(path.join(dir, 'src', 'main.ts'), mainTsTemplate(appName));
  writeFile(path.join(dir, 'README.md'), readmeTemplate(appName, scenario, typesRef));
  writeFile(path.join(dir, '.gitignore'), gitignore);
  writeFile(path.join(dir, 'assets', '.gitkeep'), '');

  return { dir, scenario, typesRef, appName, appId };
}
