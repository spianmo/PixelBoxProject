#!/usr/bin/env node
/**
 * PtyService 真实执行自检(集成终端阶段 1/2,无 GUI)
 *
 * 参照 check:toolchain 的做法:esbuild 打包【生产代码】src/main/pty.ts
 * (electron 以最小桩替换:ipcMain.handle/on、BrowserWindow.getAllWindows),
 * 经与 renderer 完全相同的 IPC 通道语义驱动:
 *
 *   1. terminal:create —— 真建 PTY(node-pty login shell),断言 backend=pty、
 *      shell 进程存活;terminal:write 执行 printf,断言 PIXELBOX_PTY_OK 经
 *      terminal:data(16ms 批量)回流(printf 拼接输出,键入回显不含完整记号)
 *   2. terminal:resize 100x30 —— 写入 stty size,断言输出 "30 100"(真 pty 才有)
 *   3. 会话命名 —— Local / Local (2);关闭释放编号后新会话补位 Local (2)
 *   4. terminal:close —— 断言 terminal:exit 事件回流 + shell 进程被回收(kill 0 探测)
 *   5. pipe 兜底模式(PIXELBOX_FORCE_PIPE=1)—— backend=pipe、数据回流、
 *      terminal:backend 上报 pipe(UI 横幅提示数据源)、关闭后进程回收
 *   6. disposeTerminal —— 兜底杀净,无孤儿进程
 *
 * 用法:cd simulator && npm run check:terminal
 */
import * as esbuild from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simRoot = resolve(__dirname, '..')
const require = createRequire(import.meta.url)

let failed = 0
const ok = (label, extra = '') => console.log(`  ✓ ${label}${extra ? `(${extra})` : ''}`)
const fail = (label, message) => {
  failed++
  console.error(`  ✗ ${label}: ${message}`)
}

// ----------------------------------------------------------------
// 打包生产代码(electron → 全局桩;CJS 保证 __filename/createRequire 语义,
// node-pty 外部化 —— 打包产物放在 node_modules 下,require 沿目录树可解析)
// ----------------------------------------------------------------
console.log('[1/6] 打包 src/main/pty.ts(electron 桩替换)')
const tmpDir = mkdtempSync(join(simRoot, 'node_modules', '.pixelbox-terminal-check-'))
const bundlePath = join(tmpDir, 'pty.bundle.cjs')

const electronStubPlugin = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        module.exports = {
          app: globalThis.__electronStub.app,
          ipcMain: globalThis.__electronStub.ipcMain,
          BrowserWindow: globalThis.__electronStub.BrowserWindow
        }
      `
    }))
  }
}

await esbuild.build({
  entryPoints: [resolve(simRoot, 'src/main/pty.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['node-pty'],
  plugins: [electronStubPlugin],
  logLevel: 'silent'
})
ok('pty.ts 打包完成')

// ----------------------------------------------------------------
// electron 最小桩:ipcMain 收集 + webContents.send 捕获事件流
// ----------------------------------------------------------------
const handlers = new Map()
/** 每会话累计输出(terminal:data 16ms 批量流) */
const dataById = new Map()
/** 退出事件(terminal:exit) */
const exitById = new Map()

globalThis.__electronStub = {
  // pty.ts → settings.ts(shell 覆盖设置)需要 userData 路径:指向临时目录,
  // SettingsService 走默认值(shellOverride 空 = $SHELL,原 19 项断言语义不变)
  app: {
    getPath: () => tmpDir
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn)
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel, payload) => {
            if (channel === 'terminal:data') {
              for (const c of payload) dataById.set(c.id, (dataById.get(c.id) ?? '') + c.data)
            } else if (channel === 'terminal:exit') {
              exitById.set(payload.id, payload)
            }
          }
        }
      }
    ]
  }
}

const mod = require(bundlePath)
mod.registerTerminalIpc()
const invoke = (channel, ...a) => handlers.get(channel)(null, ...a)

/** 轮询等待条件成立(超时返回 false) */
async function waitFor(cond, timeoutMs = 12000, stepMs = 50) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return cond()
}

/** 进程是否存活(kill 0 探测) */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 会话回流断言套餐:printf 拼接记号回流 + 关闭后进程回收 */
async function assertEchoAndClose(info, tag) {
  // printf 拼接输出:键入回显不含完整 PIXELBOX_*_OK,只有 shell 执行结果含
  invoke('terminal:write', info.id, `printf 'PIXELBOX_%s_OK\\n' ${tag}\n`)
  const token = `PIXELBOX_${tag}_OK`
  if (await waitFor(() => (dataById.get(info.id) ?? '').includes(token))) {
    ok(`${info.name} 输出回流`, `terminal:data 含 ${token}`)
  } else {
    fail(`${info.name} 输出回流`, `12s 未见 ${token};已收 ${JSON.stringify((dataById.get(info.id) ?? '').slice(-200))}`)
  }

  await invoke('terminal:close', info.id)
  if (await waitFor(() => exitById.has(info.id))) ok(`${info.name} 退出事件`, 'terminal:exit 回流')
  else fail(`${info.name} 退出事件`, '12s 未收到 terminal:exit')
  // pipe 模式 SIGHUP 未生效时 1.5s 后补 SIGKILL,放宽等待
  if (await waitFor(() => !alive(info.pid), 8000)) ok(`${info.name} 进程回收`, `pid ${info.pid} 已不存在`)
  else fail(`${info.name} 进程回收`, `pid ${info.pid} 仍存活`)
}

try {
  // ----------------------------------------------------------------
  // 2) 真 PTY:创建 → echo 回流 → resize 生效(stty size)
  // ----------------------------------------------------------------
  console.log('[2/6] terminal:create 真 PTY + 输出回流断言')
  const s1 = await invoke('terminal:create', { cwd: simRoot, cols: 80, rows: 24 })
  if (s1.backend === 'pty') ok('backend=pty', `${s1.shell} pid=${s1.pid}`)
  else fail('backend=pty', `实际 ${s1.backend}(node-pty 加载失败?)`)
  if (s1.name === 'Local') ok('首会话命名', 'Local')
  else fail('首会话命名', s1.name)
  if (alive(s1.pid)) ok('shell 进程存活', `pid ${s1.pid}`)
  else fail('shell 进程存活', `pid ${s1.pid} 不存在`)

  invoke('terminal:write', s1.id, "printf 'PIXELBOX_%s_OK\\n' PTY\n")
  if (await waitFor(() => (dataById.get(s1.id) ?? '').includes('PIXELBOX_PTY_OK'))) {
    ok('echo PIXELBOX_PTY_OK 回流', 'terminal:data(16ms 批量)')
  } else {
    fail('echo 回流', `12s 未见 PIXELBOX_PTY_OK;已收 ${JSON.stringify((dataById.get(s1.id) ?? '').slice(-200))}`)
  }

  console.log('[3/6] terminal:resize → stty size 断言')
  await invoke('terminal:resize', s1.id, 100, 30)
  dataById.set(s1.id, '') // 清掉此前输出,只看 resize 后的 stty
  invoke('terminal:write', s1.id, 'stty size\n')
  if (await waitFor(() => /\b30 100\b/.test(dataById.get(s1.id) ?? ''))) {
    ok('resize 生效', 'stty size = 30 100(真 pty 窗口尺寸)')
  } else {
    fail('resize', `stty size 未报 30 100;已收 ${JSON.stringify((dataById.get(s1.id) ?? '').slice(-200))}`)
  }

  // ----------------------------------------------------------------
  // 4) 会话命名与编号补位 + 关闭/进程回收
  // ----------------------------------------------------------------
  console.log('[4/6] 会话命名(Local (2) 补位)+ terminal:close 进程回收')
  const s2 = await invoke('terminal:create', { cwd: simRoot })
  if (s2.name === 'Local (2)') ok('次会话命名', 'Local (2)')
  else fail('次会话命名', s2.name)

  await invoke('terminal:close', s2.id)
  await waitFor(() => exitById.has(s2.id))
  const s3 = await invoke('terminal:create', { cwd: simRoot })
  if (s3.name === 'Local (2)') ok('编号补位', '关闭释放后新会话复用 Local (2)')
  else fail('编号补位', s3.name)
  await invoke('terminal:close', s3.id)
  await waitFor(() => exitById.has(s3.id))

  const list = await invoke('terminal:list')
  if (list.length === 1 && list[0].id === s1.id) ok('terminal:list', '仅剩首会话')
  else fail('terminal:list', JSON.stringify(list.map((x) => x.name)))

  await assertEchoAndClose(s1, 'CLOSE')

  // ----------------------------------------------------------------
  // 5) pipe 兜底模式(PIXELBOX_FORCE_PIPE=1;loadPty 每次先查该环境变量)
  // ----------------------------------------------------------------
  console.log('[5/6] pipe 兜底模式(PIXELBOX_FORCE_PIPE=1)')
  process.env.PIXELBOX_FORCE_PIPE = '1'
  const be = await invoke('terminal:backend')
  if (be.backend === 'pipe') ok('terminal:backend 上报 pipe', 'UI 横幅「体验受限」数据源')
  else fail('terminal:backend', JSON.stringify(be))

  const p1 = await invoke('terminal:create', { cwd: simRoot })
  if (p1.backend === 'pipe') ok('backend=pipe', `${p1.shell} pid=${p1.pid}`)
  else fail('backend=pipe', p1.backend)
  await assertEchoAndClose(p1, 'PIPE')
  delete process.env.PIXELBOX_FORCE_PIPE

  // ----------------------------------------------------------------
  // 6) disposeTerminal 兜底杀净
  // ----------------------------------------------------------------
  console.log('[6/6] disposeTerminal 杀净')
  const d1 = await invoke('terminal:create', { cwd: simRoot })
  const d2 = await invoke('terminal:create', { cwd: simRoot })
  mod.disposeTerminal()
  if (await waitFor(() => !alive(d1.pid) && !alive(d2.pid), 8000)) {
    ok('全部会话进程回收', `pid ${d1.pid}, ${d2.pid} 已不存在`)
  } else {
    fail('disposeTerminal', `残留进程:${[d1.pid, d2.pid].filter(alive).join(', ')}`)
  }
  const listAfter = await invoke('terminal:list')
  if (listAfter.length === 0) ok('会话表清空', 'terminal:list = []')
  else fail('会话表清空', JSON.stringify(listAfter))
} finally {
  // 兜底:无论断言结果如何都杀净,不留孤儿 shell
  try {
    mod.disposeTerminal()
  } catch {
    /* 忽略 */
  }
  await rm(tmpDir, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
