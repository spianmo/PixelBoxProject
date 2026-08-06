#!/usr/bin/env node
/**
 * 硬件设计链路 E2E 检查(IDE v3)—— 生产产物 + 真实 renderer 全链路
 *
 * 链路:electron out/main + PIXELBOX_SMOKE_HW=1(main 侧钩子见 main/index.ts):
 * 1. main 在系统临时目录经 createProject 生成 hardware 工程(design/board.tsx 模板);
 * 2. renderer 探针(hardware/smoke.ts)真跑:fs IPC 读设计 → @tscircuit/eval blob
 *    worker 求值 → BoardSpec/屏幕占位提炼 → 外壳分件 → HardwareViewer 离屏 STL 导出;
 * 3. 本脚本断言 stdout 的 [hw-smoke] SMOKE PASS(缺 out/ 产物时先提示 build)。
 *
 * 运行:pnpm --filter pixelbox-simulator run check:hardware(前置:pnpm run build)
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 180_000

if (!existsSync(join(root, 'out/main/index.js'))) {
  console.error('[hw-check] ✗ 缺少 out/ 产物,先执行 pnpm run build')
  process.exit(1)
}

const electronBin = join(root, 'node_modules/.bin/electron')
const child = spawn(electronBin, ['.'], {
  cwd: root,
  env: { ...process.env, PIXELBOX_SMOKE_HW: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
let done = false
const finish = (code, reason) => {
  if (done) return
  done = true
  clearTimeout(timer)
  console.log(code === 0 ? `[hw-check] PASS(${reason})` : `[hw-check] FAIL(${reason})`)
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  process.exit(code)
}

const timer = setTimeout(() => finish(1, `超时 ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS)

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    out += chunk
    for (const line of chunk.split('\n')) {
      if (line.includes('[hw-smoke]')) console.log(line.trim())
    }
    if (out.includes('[hw-smoke] SMOKE PASS')) finish(0, 'renderer 全链路断言通过')
    if (out.includes('[hw-smoke] SMOKE FAIL')) finish(1, 'renderer 断言失败,见上方 [hw-smoke] 结果')
  })
}

child.on('exit', (code) => {
  // 正常路径由 SMOKE PASS/FAIL 提前 finish;走到这里说明 app 异常提前退出
  finish(code === 0 && out.includes('SMOKE PASS') ? 0 : 1, `electron 退出 code=${code}`)
})
