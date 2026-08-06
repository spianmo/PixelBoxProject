/**
 * 新建项目向导 — 脚手架生成服务(main 进程)
 *
 * IPC:
 * - project:default-location  默认项目位置 ~/PixelBoxProjects
 * - dialog:choose-directory   系统目录选择(「浏览…」)
 * - project:create            校验参数并生成项目骨架,返回 { root, mainTs }
 *
 * 生成物(manifest 契约字段与 builder.ts readManifest 对齐):
 *   pixelbox.json / tsconfig.json / src/main.ts(按模板)/
 *   types/pixelbox.d.ts(IDE 内嵌契约全文,独立于仓库可用)/
 *   README.md / .gitignore / assets/(空目录)
 *
 * 错误以 `project:<code>` 前缀抛出,renderer 解析后映射 i18n 文案
 */
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PixelboxManifest, ProjectCreateOptions, ProjectCreateResult } from '../shared/ipc-types'
// 唯一契约文件全文(构建期 ?raw 内嵌;生成的项目自带一份,Monaco 与 tsc 共用)
import pixelboxDts from '../../../sdk/types/pixelbox.d.ts?raw'

const NAME_RE = /^[a-zA-Z0-9_-]+$/
/** 反域名:至少一个点,各段字母数字/下划线/连字符,首段以字母开头 */
const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/

/** 「像素动画 Hello」模板:弹跳方块 + HSV 彩虹(展示 onFrame / fillRect / color.hsv) */
function helloTemplate(name: string): string {
  return `/**
 * ${name} —— 像素动画 Hello(弹跳方块示例)
 *
 * 演示:
 *   - px.screen.onFrame 逐帧渲染(dt = 与上一帧间隔毫秒,回调返回后自动 flush)
 *   - px.color.hsv 彩虹渐变 + 碰壁反弹
 */

const W = px.screen.width;
const H = px.screen.height;

/** 方块边长(按屏幕短边取值,保像素风) */
const SIZE = Math.max(16, Math.floor(Math.min(W, H) / 5));

let x = (W - SIZE) / 2;
let y = (H - SIZE) / 3;
let vx = 96; // 速度(像素/秒)
let vy = 72;
let hue = 0; // 彩虹色相 0-360

px.screen.setFps(60);

px.screen.onFrame((dt) => {
  const dtSec = dt / 1000;

  // 位置积分 + 碰壁反弹
  x += vx * dtSec;
  y += vy * dtSec;
  if (x <= 0 || x + SIZE >= W) {
    vx = -vx;
    x = Math.min(Math.max(x, 0), W - SIZE);
  }
  if (y <= 0 || y + SIZE >= H) {
    vy = -vy;
    y = Math.min(Math.max(y, 0), H - SIZE);
  }

  // 色相随时间流动
  hue = (hue + dtSec * 90) % 360;

  px.screen.clear(0x000000);
  px.screen.fillRect(Math.round(x), Math.round(y), SIZE, SIZE, px.color.hsv(hue, 100, 100));
  px.screen.drawText('Hello PixelBox', 8, 8, { color: 0xdfe1e5, font: 'pixel12' });
});
`
}

/** 「空白项目」模板:最小 onFrame 骨架 */
function blankTemplate(name: string): string {
  return `/**
 * ${name} —— PixelBox 应用入口
 *
 * px.screen.onFrame:逐帧回调,回调返回后自动 flush 上屏
 */

px.screen.onFrame(() => {
  px.screen.clear(0x000000);
  // TODO: 在此绘制(px.screen.fillRect / drawText / drawImage …)
});
`
}

/** 生成的项目 tsconfig:include 指向自带的 types/pixelbox.d.ts,独立于仓库可用 */
function projectTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        noFallthroughCasesInSwitch: true
      },
      include: ['src', 'types']
    },
    null,
    2
  )}\n`
}

function readme(name: string): string {
  return `# ${name}

PixelBox 像素盒应用(由 IDE「新建项目」向导生成)。

## 目录结构

- \`pixelbox.json\` — 应用清单(id / 名称 / 版本 / 入口)
- \`src/main.ts\` — 应用入口(\`px.screen.onFrame\` 逐帧渲染)
- \`types/pixelbox.d.ts\` — 设备 API 类型契约(编辑器补全与 \`tsc\` 校验共用,随项目自包含)
- \`assets/\` — 静态资源(构建时拷贝到 \`dist/assets/\`)

## 运行

在 PixelBox 模拟器 IDE 中打开本目录,点击标题栏 ▶ 运行到虚拟设备;
独立类型检查:\`npx tsc --noEmit\`。
`
}

async function dirIsEmpty(dir: string): Promise<boolean> {
  const items = await fsp.readdir(dir)
  return items.filter((n) => n !== '.DS_Store').length === 0
}

/** 校验参数并生成项目骨架 */
export async function createProject(opts: ProjectCreateOptions): Promise<ProjectCreateResult> {
  const name = opts.name.trim()
  const appId = opts.appId.trim()
  const location = opts.location.trim()
  if (!NAME_RE.test(name)) throw new Error('project:nameInvalid')
  if (!APP_ID_RE.test(appId)) throw new Error('project:appIdInvalid')
  if (location.length === 0) throw new Error('project:locationRequired')

  const root = resolve(join(location, name))
  // 目录已存在且非空 → 拦截(避免覆盖既有内容)
  try {
    const st = await fsp.stat(root)
    if (!st.isDirectory()) throw new Error('project:dirNotEmpty')
    if (!(await dirIsEmpty(root))) throw new Error('project:dirNotEmpty')
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('project:')) throw err
    // 不存在:正常流程,继续创建
  }

  const manifest: PixelboxManifest = {
    id: appId,
    name,
    version: '0.1.0',
    entry: 'main.js',
    assets: [],
    minFirmware: '0.1.0'
  }

  await fsp.mkdir(join(root, 'src'), { recursive: true })
  await fsp.mkdir(join(root, 'types'), { recursive: true })
  await fsp.mkdir(join(root, 'assets'), { recursive: true })
  const mainTs = join(root, 'src', 'main.ts')
  await Promise.all([
    fsp.writeFile(join(root, 'pixelbox.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    fsp.writeFile(join(root, 'tsconfig.json'), projectTsconfig(), 'utf8'),
    fsp.writeFile(mainTs, opts.template === 'blank' ? blankTemplate(name) : helloTemplate(name), 'utf8'),
    fsp.writeFile(join(root, 'types', 'pixelbox.d.ts'), pixelboxDts, 'utf8'),
    fsp.writeFile(join(root, 'README.md'), readme(name), 'utf8'),
    fsp.writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n', 'utf8')
  ])
  return { root, mainTs }
}

export function registerProjectScaffoldIpc(): void {
  // 默认项目位置(不主动创建,创建时 mkdir recursive 兜底)
  ipcMain.handle('project:default-location', (): string => {
    return join(app.getPath('home'), 'PixelBoxProjects')
  })

  // 「浏览…」系统目录选择
  ipcMain.handle('dialog:choose-directory', async (_e, defaultPath?: string): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      ...(defaultPath ? { defaultPath } : {})
    }
    const ret = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (ret.canceled || ret.filePaths.length === 0) return null
    return ret.filePaths[0]
  })

  ipcMain.handle('project:create', async (_e, opts: ProjectCreateOptions): Promise<ProjectCreateResult> => {
    return createProject(opts)
  })
}
