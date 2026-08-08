/**
 * 新建项目向导 — 脚手架生成服务(main 进程)
 *
 * IPC:
 * - project:default-location  默认项目位置 ~/PixelBoxProjects
 * - dialog:choose-directory   系统目录选择(「浏览…」)
 * - project:create            校验参数并按 kind 生成三类项目骨架,
 *                             返回 { root, kind, entryFile }
 * - project:info              读取工作区项目信息(kind/name/chip/manifest;
 *                             显式 type 优先,无 type 走启发式识别)
 *
 * 三类脚手架(契约见 docs/plans/ide-v3-project-types.md §2.7):
 * - app      pixelbox.json(type:'app')/ tsconfig.json / src/main.ts(按模板)/
 *            types/pixelbox.d.ts(IDE 内嵌契约全文)/ README.md / .gitignore / assets/
 * - firmware pixelbox.json(type:'firmware')/ CMakeLists.txt / main/(CMakeLists+main.c)/
 *            sdkconfig.defaults / README.md / .gitignore
 * - hardware pixelbox.json(type:'hardware')/ design/board.tsx + design/<模组封装>.tsx
 *            + design/enclosure.scad(按目标芯片从 templates/boards 注册表取微雪
 *            参考板卡模板 1:1 复刻:esp32s3 → ESP32-S3-Touch-AMOLED-2.16 等,
 *            单一数据源见 templates/boards/index.ts;各板均经 /tmp/tsc-probe
 *            沙箱多文件 fsMap 实测 0 DRC error)/
 *            tsconfig.json(jsx: react-jsx,与 IDE Monaco 对齐;类型由 IDE 注入)/
 *            README.md / .gitignore
 *
 * 错误以 `project:<code>` 前缀抛出,renderer 解析后映射 i18n 文案
 */
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  PixelboxManifest,
  ProjectCreateOptions,
  ProjectCreateResult,
  ProjectInfo,
  ProjectKind
} from '../shared/ipc-types'
import { CHIP_IDS } from '../shared/chipCapabilities'
import { enclosureScadFromParams } from '../shared/enclosureScadTemplate'
// 唯一契约文件全文(构建期 ?raw 内嵌;生成的项目自带一份,Monaco 与 tsc 共用)
import pixelboxDts from '../../../sdk/types/pixelbox.d.ts?raw'
// 按芯片选板注册表:ChipId → 微雪参考板卡模板(板 tsx / 真实模组封装 / 外壳
// 参数 / README 生成器;板卡正文与模组封装为 templates/ 下静态 .tsx 经 ?raw 内嵌)
import { hardwareBoardTemplate } from './templates/boards'

const NAME_RE = /^[a-zA-Z0-9_-]+$/
/** 反域名:至少一个点,各段字母数字/下划线/连字符,首段以字母开头 */
const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/

// ---------------------------------------------------------------
// app 模板(现状保留)
// ---------------------------------------------------------------

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

function appReadme(name: string): string {
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

// ---------------------------------------------------------------
// firmware 模板(ESP-IDF 标准工程)
// ---------------------------------------------------------------

function firmwareRootCMake(name: string): string {
  return `cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(${name})
`
}

function firmwareMainCMake(): string {
  return `idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")
`
}

function firmwareMainC(name: string): string {
  return `/**
 * ${name} —— ESP-IDF 固件入口(FreeRTOS)
 *
 * app_main 由 ESP-IDF 启动任务调用;示例每秒打一条心跳日志,
 * 串口监视:idf.py monitor(Ctrl+] 退出)
 */
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"

static const char *TAG = "${name}";

void app_main(void)
{
    ESP_LOGI(TAG, "firmware up, free heap %" PRIu32 " bytes", esp_get_free_heap_size());
    uint32_t tick = 0;
    for (;;) {
        ESP_LOGI(TAG, "heartbeat #%" PRIu32, tick++);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`
}

function firmwareSdkconfigDefaults(name: string): string {
  return `# ${name} — sdkconfig 默认覆盖项
# 在此追加 CONFIG_* 键值(idf.py set-target / 首次构建时吸收到 sdkconfig)
`
}

function firmwareReadme(name: string, chip: string): string {
  return `# ${name}

ESP-IDF 固件工程(由 PixelBox IDE「新建项目」向导生成;默认目标芯片 \`${chip}\`)。

## 目录结构

- \`CMakeLists.txt\` — 工程入口(引 \`$IDF_PATH/tools/cmake/project.cmake\`)
- \`main/main.c\` — 固件入口(\`app_main\`,FreeRTOS 心跳示例)
- \`sdkconfig.defaults\` — sdkconfig 默认覆盖项

## 编译 / 烧录

IDE:标题栏 🔨 构建,⋮ 菜单内 打包 merged.bin / 烧录 / 清理(均作用于本工程目录)。

命令行(先加载 ESP-IDF 环境 \`. $IDF_PATH/export.sh\`):

\`\`\`bash
idf.py set-target ${chip}
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash monitor
\`\`\`
`
}

// ---------------------------------------------------------------
// hardware 模板(tscircuit PCB + 参数化外壳)
// ---------------------------------------------------------------

/**
 * hardware 工程 tsconfig:jsx 与 IDE Monaco 配置一致(react-jsx,见 monacoSetup.ts)。
 * tscircuit 元素/属性类型由 IDE 编辑器注入(@tscircuit/core d.ts extraLib),
 * 工程本身不带 node_modules —— 独立 `npx tsc` 需自行安装 tscircuit 依赖
 */
function hardwareTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true
      },
      include: ['design']
    },
    null,
    2
  )}\n`
}

// ---------------------------------------------------------------
// 创建
// ---------------------------------------------------------------

async function dirIsEmpty(dir: string): Promise<boolean> {
  const items = await fsp.readdir(dir)
  return items.filter((n) => n !== '.DS_Store').length === 0
}

/** 目录已存在且非空 → 拦截(避免覆盖既有内容) */
async function assertCreatable(root: string): Promise<void> {
  try {
    const st = await fsp.stat(root)
    if (!st.isDirectory()) throw new Error('project:dirNotEmpty')
    if (!(await dirIsEmpty(root))) throw new Error('project:dirNotEmpty')
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('project:')) throw err
    // 不存在:正常流程,继续创建
  }
}

/** manifest 落盘(2 空格缩进 + 尾换行) */
function manifestJson(m: PixelboxManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`
}

async function createAppProject(root: string, name: string, opts: ProjectCreateOptions): Promise<string> {
  const appId = (opts.appId ?? '').trim()
  if (!APP_ID_RE.test(appId)) throw new Error('project:appIdInvalid')
  const manifest: PixelboxManifest = {
    type: 'app',
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
  const entryFile = join(root, 'src', 'main.ts')
  await Promise.all([
    fsp.writeFile(join(root, 'pixelbox.json'), manifestJson(manifest), 'utf8'),
    fsp.writeFile(join(root, 'tsconfig.json'), projectTsconfig(), 'utf8'),
    fsp.writeFile(entryFile, opts.template === 'blank' ? blankTemplate(name) : helloTemplate(name), 'utf8'),
    fsp.writeFile(join(root, 'types', 'pixelbox.d.ts'), pixelboxDts, 'utf8'),
    fsp.writeFile(join(root, 'README.md'), appReadme(name), 'utf8'),
    fsp.writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n.ide/\n', 'utf8')
  ])
  return entryFile
}

async function createFirmwareProject(root: string, name: string, chip: string): Promise<string> {
  const manifest: PixelboxManifest = {
    type: 'firmware',
    id: name,
    name,
    version: '0.1.0',
    entry: '',
    chip
  }
  await fsp.mkdir(join(root, 'main'), { recursive: true })
  const entryFile = join(root, 'main', 'main.c')
  await Promise.all([
    fsp.writeFile(join(root, 'pixelbox.json'), manifestJson(manifest), 'utf8'),
    fsp.writeFile(join(root, 'CMakeLists.txt'), firmwareRootCMake(name), 'utf8'),
    fsp.writeFile(join(root, 'main', 'CMakeLists.txt'), firmwareMainCMake(), 'utf8'),
    fsp.writeFile(entryFile, firmwareMainC(name), 'utf8'),
    fsp.writeFile(join(root, 'sdkconfig.defaults'), firmwareSdkconfigDefaults(name), 'utf8'),
    fsp.writeFile(join(root, 'README.md'), firmwareReadme(name, chip), 'utf8'),
    fsp.writeFile(join(root, '.gitignore'), 'build*/\nsdkconfig\nmanaged_components/\n.ide/\n', 'utf8'),
    // .clangd:IDE 内 C/C++ 智能提示走系统 clangd(见 main/clangd.ts),Apple/主线 clangd
    // 不认识 xtensa/riscv 交叉 gcc 的少数专有 flags,会报「Unknown argument」噪音诊断 —— 移除之
    fsp.writeFile(
      join(root, '.clangd'),
      [
        'CompileFlags:',
        '  Remove:',
        '    - -mlongcalls',
        '    - -mdisable-hardware-atomics',
        '    - -fno-tree-switch-conversion',
        '    - -fno-shrink-wrap',
        '    - -mtext-section-literals',
        '    - -march=*',
        '    - -mabi=*',
        ''
      ].join('\n'),
      'utf8'
    )
  ])
  return entryFile
}

async function createHardwareProject(root: string, name: string, chip: string): Promise<string> {
  const manifest: PixelboxManifest = {
    type: 'hardware',
    id: name,
    name,
    version: '0.1.0',
    entry: '',
    chip
  }
  // 按目标芯片取微雪参考板卡模板(未收录芯片回退 esp32s3,单一数据源 templates/boards)
  const tpl = hardwareBoardTemplate(chip)
  await fsp.mkdir(join(root, 'design'), { recursive: true })
  const entryFile = join(root, 'design', 'board.tsx')
  await Promise.all([
    fsp.writeFile(join(root, 'pixelbox.json'), manifestJson(manifest), 'utf8'),
    fsp.writeFile(entryFile, tpl.boardTsx(name), 'utf8'),
    // 真实主控模组封装(board.tsx 相对导入;evaluateDesign 会把 design/ 下全部
    // .ts/.tsx 一并放进 fsMap,多文件工程开箱即用)
    fsp.writeFile(join(root, 'design', tpl.moduleFile.fileName), tpl.moduleFile.content, 'utf8'),
    // tsconfig:jsx 配置与 IDE Monaco 对齐;类型由 IDE 注入,不落 8MB d.ts 进工程
    fsp.writeFile(join(root, 'tsconfig.json'), hardwareTsconfig(), 'utf8'),
    // OpenSCAD 外壳源(外壳即代码;IDE 硬件面板即时编译渲染,打印页分件导出;
    // 电池占位等契约经文件尾 PB_META echo 传给 IDE;enclosure.json 已退役)
    fsp.writeFile(
      join(root, 'design', 'enclosure.scad'),
      enclosureScadFromParams(tpl.enclosure, tpl.boardSizeMM, tpl.screenRect),
      'utf8'
    ),
    fsp.writeFile(join(root, 'README.md'), tpl.readme(name, chip), 'utf8'),
    fsp.writeFile(join(root, '.gitignore'), 'export/\n.ide/\n', 'utf8')
  ])
  return entryFile
}

/** 校验参数并按 kind 生成项目骨架 */
export async function createProject(opts: ProjectCreateOptions): Promise<ProjectCreateResult> {
  const name = opts.name.trim()
  const location = opts.location.trim()
  if (!NAME_RE.test(name)) throw new Error('project:nameInvalid')
  if (location.length === 0) throw new Error('project:locationRequired')
  // 相对路径会被解析到 main 进程 cwd(打包后是 / 或 .app 内),必须拒绝
  if (!isAbsolute(location)) throw new Error('project:locationInvalid')
  const kind: ProjectKind = opts.kind
  if (kind !== 'app' && kind !== 'firmware' && kind !== 'hardware') {
    throw new Error('project:kindInvalid')
  }
  // firmware/hardware 目标芯片:缺省 esp32s3,非法值拦截(单一数据源 CHIP_IDS)
  const chip = (opts.chip ?? 'esp32s3').trim()
  if (!(CHIP_IDS as readonly string[]).includes(chip)) throw new Error('project:chipInvalid')

  const root = resolve(join(location, name))
  await assertCreatable(root)

  let entryFile: string
  if (kind === 'app') entryFile = await createAppProject(root, name, opts)
  else if (kind === 'firmware') entryFile = await createFirmwareProject(root, name, chip)
  else entryFile = await createHardwareProject(root, name, chip)
  return { root, kind, entryFile }
}

// ---------------------------------------------------------------
// project:info(工作区类型识别,门控矩阵的数据源)
// ---------------------------------------------------------------

function isProjectKind(v: unknown): v is ProjectKind {
  return v === 'app' || v === 'firmware' || v === 'hardware'
}

/** 合法 app manifest:id/name/version/entry 均为非空字符串(与 builder.ts readManifest 同判据) */
function isValidAppManifest(m: PixelboxManifest): boolean {
  return (['id', 'name', 'version', 'entry'] as const).every(
    (key) => typeof m[key] === 'string' && (m[key] as string).length > 0
  )
}

/**
 * 读取工作区项目信息:
 * 1. pixelbox.json 有显式合法 type → 直接采信
 * 2. 无 type:合法 app manifest → app(旧应用工程向后兼容)
 * 3. CMakeLists.txt + main/ 目录 → firmware(裸 ESP-IDF 工程,无 manifest 也识别)
 * 4. 其余 kind:null(普通目录,隐藏所有类型化动作)
 */
export async function readProjectInfo(root: string): Promise<ProjectInfo> {
  const abs = resolve(root)
  let manifest: PixelboxManifest | null = null
  try {
    const raw = JSON.parse(await fsp.readFile(join(abs, 'pixelbox.json'), 'utf8')) as unknown
    if (typeof raw === 'object' && raw !== null) manifest = raw as PixelboxManifest
  } catch {
    // 无 pixelbox.json / 解析失败:走启发式
  }

  let kind: ProjectKind | null = null
  if (manifest && isProjectKind(manifest.type)) {
    kind = manifest.type
  } else if (manifest && isValidAppManifest(manifest)) {
    kind = 'app'
  } else {
    try {
      const [cmake, mainDir] = await Promise.all([
        fsp.stat(join(abs, 'CMakeLists.txt')),
        fsp.stat(join(abs, 'main'))
      ])
      if (cmake.isFile() && mainDir.isDirectory()) kind = 'firmware'
    } catch {
      // 非固件工程
    }
  }

  return {
    kind,
    name: typeof manifest?.name === 'string' && manifest.name.length > 0 ? manifest.name : null,
    chip: typeof manifest?.chip === 'string' && manifest.chip.length > 0 ? manifest.chip : null,
    manifest
  }
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

  // 工作区项目信息(applyWorkspace 时查询;pixelbox.json fs-event 变更时重取)
  ipcMain.handle('project:info', async (_e, root: string): Promise<ProjectInfo> => {
    if (typeof root !== 'string' || root.trim().length === 0) {
      return { kind: null, name: null, chip: null, manifest: null }
    }
    return readProjectInfo(root)
  })
}
