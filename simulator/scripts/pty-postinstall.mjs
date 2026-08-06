#!/usr/bin/env node
/**
 * node-pty 安装后修复与可用性验证(集成终端阶段 1)
 *
 * 1. npm 解包不保留可执行位:prebuilds/darwin-*/spawn-helper 丢失 +x 会导致
 *    pty.fork 报 "posix_spawnp failed",这里统一补回执行权限
 * 2. 验证 node-pty 能在当前平台加载(N-API 预编译产物对 Node/Electron 通用);
 *    加载失败时尝试 @electron/rebuild 针对 electron ABI 从源码重建
 * 3. 重建仍失败仅告警不阻断安装 —— 运行期 PtyService 会自动回退
 *    child_process pipe 模式(TERM=dumb,体验受限但可用)
 */
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const simRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(simRoot, 'package.json'))

// ---- 1) 补回 spawn-helper 可执行位(macOS 必需;不存在则跳过) ----
const prebuilds = join(simRoot, 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) {
      chmodSync(helper, 0o755)
      console.log(`[pty-postinstall] chmod +x ${join('prebuilds', dir, 'spawn-helper')}`)
    }
  }
}

// ---- 2) 加载验证;失败时 electron-rebuild 兜底 ----
function canLoad() {
  try {
    require('node-pty')
    return true
  } catch (err) {
    console.warn(`[pty-postinstall] node-pty 加载失败: ${err.message}`)
    return false
  }
}

if (canLoad()) {
  console.log('[pty-postinstall] node-pty 可用(N-API 预编译产物)')
} else {
  console.log('[pty-postinstall] 尝试 @electron/rebuild 针对 electron ABI 重建 node-pty…')
  try {
    execSync('npx electron-rebuild -f -w node-pty', { cwd: simRoot, stdio: 'inherit' })
    console.log(canLoad() ? '[pty-postinstall] 重建成功' : '[pty-postinstall] 重建后仍无法加载')
  } catch {
    console.warn('[pty-postinstall] electron-rebuild 失败;终端将回退 pipe 模式(TERM=dumb,体验受限)')
  }
}
