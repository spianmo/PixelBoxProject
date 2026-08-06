#!/usr/bin/env node
/**
 * dev 编排脚本(替代 electron-vite dev)
 *
 * 职责:
 *   1. 以 Rsbuild JS API 启动 dev(三 environments 同一 watch:renderer 走
 *      devServer + HMR/React Fast Refresh;main/preload 为 node target,
 *      dev.writeToDisk 落盘 out/{main,preload});
 *   2. 首轮编译完成后启动 electron,注入 ELECTRON_RENDERER_URL=http://localhost:<port>
 *      (main/toolWindows/settingsWindow 均按该语义分流 dev/prod 加载,保持不变);
 *   3. watch out/main、out/preload 产物:内容真实变化(hash 比对,规避 watch 空写)
 *      → 自动重启 electron;renderer 改动只走 HMR,不动 electron;
 *   4. electron 自行退出(用户关窗 / 各 PIXELBOX_* 冒烟钩子 app.quit)时,
 *      本脚本以相同退出码收尾退出(冒烟脚本依赖该语义判定 PASS/FAIL);
 *      收到 SIGINT/SIGTERM(Ctrl-C / check 脚本杀进程组)时杀净 electron 后退出。
 *
 * 冒烟钩子全部经环境变量透传(PIXELBOX_SMOKE_THEME / SMOKE_FS / SMOKE_FS_VISUAL /
 * SMOKE_SESSION / SMOKE_MONACO / OPEN_SETTINGS / FORCE_PIPE),electron stdio
 * 直通本进程,外层检查脚本(如 fullscreen-visual-check.mjs)照常解析标记行。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRsbuild, loadConfig } from '@rsbuild/core'
import chokidar from 'chokidar'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simRoot = resolve(__dirname, '..')
const require = createRequire(import.meta.url)
// electron 包的默认导出即可执行文件路径
const electronBin = require('electron')

const log = (msg) => console.log(`[dev] ${msg}`)

// ----------------------------------------------------------------
// Rsbuild dev(renderer devServer + main/preload watch 写盘)
// ----------------------------------------------------------------
// command: 'dev' → rsbuild.config.ts 按 dev 语义取值(sourcemap 开等)
const { content } = await loadConfig({ cwd: simRoot, command: 'dev' })
const rsbuild = await createRsbuild({ cwd: simRoot, config: content })

/** electron 子进程与生命周期状态 */
let electron = null
let restarting = false
let shuttingDown = false
let rendererUrl = ''

function startElectron() {
  electron = spawn(electronBin, ['.'], {
    cwd: simRoot,
    stdio: 'inherit', // 冒烟标记行([theme]/[fs]/[fs-visual]…)直通外层脚本
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl }
  })
  electron.on('exit', (code, signal) => {
    if (restarting) {
      // 主动重启:旧进程退净后再拉新进程(避免 userData 单实例竞争)
      restarting = false
      startElectron()
      return
    }
    if (!shuttingDown) {
      // electron 自行退出(用户关窗/冒烟钩子 app.quit):以相同退出码收尾
      void shutdown(code ?? (signal ? 1 : 0))
    }
  })
}

function restartElectron(reason) {
  if (shuttingDown) return
  log(`${reason} → 重启 electron`)
  if (!electron || electron.exitCode !== null) {
    startElectron()
    return
  }
  restarting = true
  electron.kill('SIGTERM')
}

let devServer = null
async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  if (electron && electron.exitCode === null) {
    electron.kill('SIGTERM')
  }
  try {
    await devServer?.server?.close()
  } catch {
    /* 收尾尽力而为 */
  }
  process.exit(code)
}

// Ctrl-C / 外层检查脚本杀进程组:杀净 electron 后退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => void shutdown(0))
}

// ----------------------------------------------------------------
// 首轮编译完成 → 启动 electron;之后 out/main|preload 内容变化 → 重启
// ----------------------------------------------------------------
const MAIN_OUT = join(simRoot, 'out/main')
const PRELOAD_OUT = join(simRoot, 'out/preload')
/** 产物内容 hash:Rspack watch 可能原样重写文件,仅内容变化才值得重启 */
const outHashes = new Map()
const hashOf = (file) => {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}
const snapshotOutputs = () => {
  for (const dir of [MAIN_OUT, PRELOAD_OUT]) {
    const index = join(dir, 'index.js')
    if (existsSync(index)) outHashes.set(index, hashOf(index))
  }
}

let electronStarted = false
let firstCompileDone = false
let restartTimer = null

/** 两个前置都齐(首轮编译完成 + devServer 端口已知)才启动 electron */
function maybeStartElectron() {
  if (electronStarted || shuttingDown) return
  if (!firstCompileDone || rendererUrl === '') return
  if (!existsSync(join(MAIN_OUT, 'index.js'))) return
  electronStarted = true
  log(`renderer devServer @ ${rendererUrl},启动 electron`)
  startElectron()
  // 首启后才开始盯产物变化(初轮写盘不触发重启)
  const watcher = chokidar.watch([MAIN_OUT, PRELOAD_OUT], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 }
  })
  watcher.on('all', (_event, file) => {
    if (!/\.js$/.test(file)) return // sourcemap 等辅助产物不触发
    const next = hashOf(file)
    if (next === outHashes.get(file)) return
    outHashes.set(file, next)
    // 去抖:一次重编译可能连续写多个文件,合并为一次重启
    clearTimeout(restartTimer)
    const which = file.includes('out/preload') ? 'preload' : 'main'
    restartTimer = setTimeout(() => restartElectron(`${which} 产物已更新`), 200)
  })
}

rsbuild.onDevCompileDone(({ isFirstCompile }) => {
  if (isFirstCompile) {
    firstCompileDone = true
    snapshotOutputs()
    maybeStartElectron()
  }
})

devServer = await rsbuild.startDevServer()
rendererUrl = `http://localhost:${devServer.port}`
maybeStartElectron()
