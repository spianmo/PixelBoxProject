#!/usr/bin/env node
/**
 * ToolchainService 真实执行自检(阶段 3,无 GUI)
 *
 * 直接打包并运行【生产代码】src/main/toolchain.ts(electron 以最小桩替换:
 * app.getPath/getAppPath、ipcMain.handle、BrowserWindow.getAllWindows),
 * 经与 renderer 完全相同的 IPC 通道语义驱动:
 *
 *   1. toolchain:detect   —— 检测 ESP-IDF(路径 + 版本)
 *   2. toolchain:ports    —— 串口扫描(无设备环境应返回空数组,
 *                            对应烧录对话框「扫描为空 + 下载模式指引」分支)
 *   3. toolchain:start flash(非法端口)—— 校验 badPort 防护
 *   4. toolchain:start merge esp32s3 —— 真实 login shell + export.sh + idf.py
 *      build + merge-bin,捕获 toolchain:log 数据流(即「构建」tab 的数据源)
 *      并断言 firmware/dist/esp32s3-merged.bin 落盘与体积
 *   5. toolchain:cancel —— 启动构建后 1.5s 取消(此时仍在 export.sh 加载阶段,
 *      不会破坏构建目录),断言进程树被杀且 done 事件 cancelled=true
 *
 * 用法:cd simulator && npm run check:toolchain [-- --kind merge --target esp32s3]
 * 注意:会触发一次真实固件构建(有增量缓存时较快)。
 */
import * as esbuild from 'esbuild'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simRoot = resolve(__dirname, '..')

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const KIND = argOf('kind', 'merge') // build | merge
const TARGET = argOf('target', 'esp32s3')

let failed = 0
const ok = (label, extra = '') => console.log(`  ✓ ${label}${extra ? `(${extra})` : ''}`)
const fail = (label, message) => {
  failed++
  console.error(`  ✗ ${label}: ${message}`)
}

// ----------------------------------------------------------------
// 打包生产代码(electron → 全局桩)
// ----------------------------------------------------------------
console.log('[1/5] 打包 src/main/toolchain.ts(electron 桩替换)')
const tmpDir = mkdtempSync(join(tmpdir(), 'pixelbox-toolchain-check-'))
const bundlePath = join(tmpDir, 'toolchain.bundle.mjs')

const electronStubPlugin = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        export const app = globalThis.__electronStub.app
        export const ipcMain = globalThis.__electronStub.ipcMain
        export const BrowserWindow = globalThis.__electronStub.BrowserWindow
      `
    }))
  }
}

await esbuild.build({
  entryPoints: [resolve(simRoot, 'src/main/toolchain.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  plugins: [electronStubPlugin],
  logLevel: 'silent'
})
ok('toolchain.ts 打包完成')

// ----------------------------------------------------------------
// electron 最小桩:ipcMain.handle 收集 + webContents.send 捕获事件流
// ----------------------------------------------------------------
const handlers = new Map()
const logLines = [] // toolchain:log 事件流(=「构建」tab 数据源)
const doneResolvers = [] // 每个任务一个 done 等待者(FIFO)
const waitDone = () => new Promise((res) => doneResolvers.push(res))

globalThis.__electronStub = {
  app: {
    // userData 指向临时目录:设置文件走默认值(不读用户真实设置)
    getPath: () => tmpDir,
    // getAppPath 与 electron dev 形态一致(= simulator/),firmware 目录据此解析
    getAppPath: () => simRoot
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn)
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel, payload) => {
            if (channel === 'toolchain:log') {
              for (const l of payload) {
                logLines.push(l)
                console.log(`    | ${l.level.padEnd(5)} ${l.text}`)
              }
            } else if (channel === 'toolchain:done') {
              doneResolvers.shift()?.(payload)
            }
          }
        }
      }
    ]
  }
}

const mod = await import(pathToFileURL(bundlePath).href)
mod.registerToolchainIpc()
const invoke = (channel, ...a) => handlers.get(channel)(null, ...a)

// ----------------------------------------------------------------
// 2) 检测 + 串口扫描(无设备分支)
// ----------------------------------------------------------------
console.log('[2/5] toolchain:detect / toolchain:ports')
const info = await invoke('toolchain:detect')
if (info.ok && info.version) ok('检测到 ESP-IDF', `${info.version} @ ${info.idfPath}`)
else fail('ESP-IDF 检测', JSON.stringify(info))
if (existsSync(join(info.firmwareDir, 'CMakeLists.txt'))) ok('firmware 目录解析', info.firmwareDir)
else fail('firmware 目录解析', info.firmwareDir)

const ports = await invoke('toolchain:ports')
if (Array.isArray(ports)) {
  ok(
    '串口扫描返回数组',
    ports.length === 0 ? '空 → 烧录对话框走「无设备 + BOOT 下载模式指引」分支' : ports.map((p) => p.path).join(', ')
  )
} else fail('串口扫描', String(ports))

// ----------------------------------------------------------------
// 3) 烧录防护:非法端口直接拒绝(不 spawn)
// ----------------------------------------------------------------
console.log('[3/5] toolchain:start flash 非法端口防护')
try {
  await invoke('toolchain:start', { kind: 'flash', target: TARGET, port: '/tmp/evil; rm -rf' })
  fail('badPort 防护', '未抛错')
} catch (err) {
  if (String(err.message).includes('toolchain:badPort')) ok('非法端口被拒绝', 'toolchain:badPort')
  else fail('badPort 防护', err.message)
}

// ----------------------------------------------------------------
// 4) 真实构建 + merge_bin(login shell + export.sh + idf.py)
// ----------------------------------------------------------------
console.log(`[4/5] toolchain:start ${KIND} ${TARGET}(真实构建,流式日志如下)`)
const t0 = Date.now()
const done4 = waitDone()
await invoke('toolchain:start', { kind: KIND, target: TARGET })
const result = await done4
const secs = ((Date.now() - t0) / 1000).toFixed(1)

if (result.success) ok(`任务成功(${KIND} → ${TARGET})`, `${secs}s,exit=${result.exitCode}`)
else fail('任务失败', `exit=${result.exitCode} cancelled=${result.cancelled}`)

if (logLines.length > 10) ok('toolchain:log 数据流', `${logLines.length} 行(经 IPC 到「构建」tab)`)
else fail('toolchain:log 数据流', `仅 ${logLines.length} 行`)

for (const a of result.artifacts ?? []) {
  if (existsSync(a.path) && statSync(a.path).size === a.sizeBytes && a.sizeBytes > 0) {
    ok('产物落盘', `${a.path}(${(a.sizeBytes / 1024 / 1024).toFixed(2)} MB)`)
  } else {
    fail('产物落盘', a.path)
  }
}
if (KIND === 'merge') {
  const merged = (result.artifacts ?? []).find((a) => a.path.endsWith(`${TARGET}-merged.bin`))
  if (merged) ok('merged.bin 命名与位置', merged.path)
  else fail('merged.bin', '结果中未包含 <target>-merged.bin 产物')
}

// ----------------------------------------------------------------
// 5) 取消:再次启动构建,1.5s 后杀进程树
//    (仍处 export.sh 加载阶段,不触及构建目录,安全)
// ----------------------------------------------------------------
console.log('[5/5] toolchain:cancel(启动 1.5s 后取消)')
const done5 = waitDone()
await invoke('toolchain:start', { kind: 'build', target: TARGET })
setTimeout(() => void invoke('toolchain:cancel'), 1500)
const cancelT0 = Date.now()
const cancelled = await done5
if (cancelled.cancelled === true && cancelled.success === false) {
  ok('取消生效(进程树已终止)', `${((Date.now() - cancelT0) / 1000).toFixed(1)}s 后收到 done`)
} else {
  fail('取消', JSON.stringify(cancelled))
}
// 取消后应可立即再次接受任务(状态复位)
const status = await invoke('toolchain:status')
if (status.running === null) ok('取消后状态复位', 'running=null')
else fail('取消后状态复位', JSON.stringify(status))

// 收尾:临时目录清理 + 汇总
await rm(tmpDir, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
