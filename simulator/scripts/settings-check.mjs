#!/usr/bin/env node
/**
 * SettingsService 真实执行自检(settings-window 阶段 1/2,无 GUI)
 *
 * 参照 check:toolchain / check:terminal 的做法:esbuild 打包【生产代码】
 * src/main/settings.ts(electron 以最小桩替换:app.getPath、ipcMain.handle、
 * BrowserWindow.getAllWindows),经与 renderer 完全相同的 IPC 通道语义驱动:
 *
 *   1. settings:get-all —— 全新 userData 下返回完整默认值(schema 单一数据源)
 *   2. settings:set-many —— dot-path 补丁落盘 userData/pixelbox-sim/settings.json;
 *      settings:changed 广播(changedKeys 精确);坏值/未知键静默丢弃不广播
 *   3. getAll 回读 —— 以 fresh module 实例(冷启动语义)重读磁盘,值与写入一致
 *   4. toolchain.json 迁移 —— 旧文件三字段进 settings.json,旧文件标记 deprecated,
 *      二次启动不重复迁移(用户后续修改不被旧值覆盖)
 *   5. settings:reset —— 回默认值 + 广播
 *
 * 用法:cd simulator && npm run check:settings
 */
import * as esbuild from 'esbuild'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simRoot = resolve(__dirname, '..')

let failed = 0
const ok = (label, extra = '') => console.log(`  ✓ ${label}${extra ? `(${extra})` : ''}`)
const fail = (label, message) => {
  failed++
  console.error(`  ✗ ${label}: ${message}`)
}

// ----------------------------------------------------------------
// 打包生产代码(electron → 全局桩)
// ----------------------------------------------------------------
console.log('[1/5] 打包 src/main/settings.ts(electron 桩替换)')
const tmpRoot = mkdtempSync(join(tmpdir(), 'pixelbox-settings-check-'))
const bundlePath = join(tmpRoot, 'settings.bundle.mjs')

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
  entryPoints: [resolve(simRoot, 'src/main/settings.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  plugins: [electronStubPlugin],
  logLevel: 'silent'
})
ok('settings.ts 打包完成')

// ----------------------------------------------------------------
// electron 最小桩:userData 可切换 + settings:changed 事件流捕获
// ----------------------------------------------------------------
let userDataDir = join(tmpRoot, 'phase-defaults')
mkdirSync(userDataDir, { recursive: true })
let handlers = new Map()
/** settings:changed 广播捕获(两个「窗口」各收一份,断言全窗口广播) */
const changedEvents = []

const makeWindow = () => ({
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => {
      if (channel === 'settings:changed') changedEvents.push(payload)
    }
  }
})

globalThis.__electronStub = {
  app: { getPath: () => userDataDir },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  BrowserWindow: { getAllWindows: () => [makeWindow(), makeWindow()] }
}

/** 导入 fresh module 实例(查询串击穿 ESM 缓存 = 冷启动语义)并注册 IPC */
let importSeq = 0
async function freshService() {
  handlers = new Map()
  const mod = await import(`${pathToFileURL(bundlePath).href}?v=${++importSeq}`)
  mod.registerSettingsIpc()
  return mod
}
const invoke = (channel, ...a) => handlers.get(channel)(null, ...a)
const settingsFile = () => join(userDataDir, 'pixelbox-sim', 'settings.json')

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ----------------------------------------------------------------
// 2) 默认值(全新 userData)
// ----------------------------------------------------------------
console.log('[2/5] settings:get-all 默认值')
const mod1 = await freshService()
const defaults = mod1.SETTINGS_DEFAULTS
const all0 = await invoke('settings:get-all')
if (deepEq(all0, defaults)) ok('get-all 返回完整默认值', 'schema 单一数据源')
else fail('默认值', JSON.stringify(all0))
if (
  all0.editor.minimap === true &&
  all0.editor.fontSize === 13 &&
  all0.appearance.language === 'zh-CN' &&
  all0.toolchain.baudRate === 460800 &&
  all0.system.restoreSession === true
) {
  ok('关键默认值抽查', 'minimap=on fontSize=13 lang=zh-CN baud=460800 restore=on')
} else {
  fail('关键默认值抽查', JSON.stringify(all0))
}
if (existsSync(settingsFile())) ok('首启即落盘初始 settings.json', settingsFile())
else fail('首启落盘', 'settings.json 未生成')

// ----------------------------------------------------------------
// 3) set-many 落盘 + changed 广播 + 坏值拒绝 + 冷启动回读
// ----------------------------------------------------------------
console.log('[3/5] settings:set-many 落盘 / settings:changed 广播 / 坏值拒绝')
changedEvents.length = 0
const afterSet = await invoke('settings:set-many', {
  'editor.fontSize': 16,
  'editor.minimap': false,
  'appearance.language': 'en',
  'toolchain.baudRate': 921600,
  'terminal.fontSize': 14
})
if (
  afterSet.editor.fontSize === 16 &&
  afterSet.editor.minimap === false &&
  afterSet.appearance.language === 'en' &&
  afterSet.toolchain.baudRate === 921600 &&
  afterSet.terminal.fontSize === 14
) {
  ok('set-many 返回最新全量设置')
} else {
  fail('set-many 返回值', JSON.stringify(afterSet))
}

// 广播:两个窗口各一份,changedKeys 精确
if (changedEvents.length === 2) ok('settings:changed 广播到全部窗口', '2 个窗口各 1 份')
else fail('changed 广播', `收到 ${changedEvents.length} 份(应为 2)`)
const expectKeys = [
  'appearance.language',
  'editor.fontSize',
  'editor.minimap',
  'terminal.fontSize',
  'toolchain.baudRate'
]
const gotKeys = [...(changedEvents[0]?.changedKeys ?? [])].sort()
if (deepEq(gotKeys, expectKeys)) ok('changedKeys 精确', gotKeys.join(','))
else fail('changedKeys', gotKeys.join(','))
if (changedEvents[0]?.settings?.editor?.fontSize === 16) ok('广播携带全量最新设置')
else fail('广播 payload', JSON.stringify(changedEvents[0]))

// 落盘核对(磁盘文件即真值)
const onDisk = JSON.parse(readFileSync(settingsFile(), 'utf8'))
if (onDisk.editor.fontSize === 16 && onDisk.appearance.language === 'en') {
  ok('settings.json 落盘值正确')
} else {
  fail('落盘', JSON.stringify(onDisk))
}

// 坏值 / 未知键:静默丢弃,不落盘不广播
changedEvents.length = 0
const afterBad = await invoke('settings:set-many', {
  'editor.fontSize': 99, // 超出 12-20
  'appearance.theme': 'light', // 亮色规划中,schema 拒绝
  'evil.path': 'x', // 未知键
  'toolchain.defaultTarget': 'rm -rf /' // 非法芯片名
})
if (
  afterBad.editor.fontSize === 16 &&
  afterBad.appearance.theme === 'dark' &&
  afterBad.evil === undefined &&
  afterBad.toolchain.defaultTarget === 'esp32s3'
) {
  ok('坏值/未知键全部拒绝', 'fontSize=99 theme=light evil.path badTarget')
} else {
  fail('坏值拒绝', JSON.stringify(afterBad))
}
if (changedEvents.length === 0) ok('无实际变化不广播')
else fail('无变化广播', `收到 ${changedEvents.length} 份`)

// 冷启动回读:fresh module 实例重读磁盘
console.log('    —— 冷启动回读(fresh module 实例)')
await freshService()
const reRead = await invoke('settings:get-all')
if (
  reRead.editor.fontSize === 16 &&
  reRead.editor.minimap === false &&
  reRead.appearance.language === 'en' &&
  reRead.toolchain.baudRate === 921600
) {
  ok('getAll 冷启动回读与写入一致')
} else {
  fail('冷启动回读', JSON.stringify(reRead))
}

// ----------------------------------------------------------------
// 4) toolchain.json 迁移(首启)+ 不重复迁移
// ----------------------------------------------------------------
console.log('[4/5] toolchain.json 首启迁移 + deprecated 标记')
userDataDir = join(tmpRoot, 'phase-migrate')
mkdirSync(join(userDataDir, 'pixelbox-sim'), { recursive: true })
const legacyFile = join(userDataDir, 'pixelbox-sim', 'toolchain.json')
writeFileSync(
  legacyFile,
  JSON.stringify({ idfPathOverride: '/opt/esp-idf', defaultTarget: 'esp32c6', baudRate: 115200 }, null, 2)
)
await freshService()
const migrated = await invoke('settings:get-all')
if (
  migrated.toolchain.idfPathOverride === '/opt/esp-idf' &&
  migrated.toolchain.defaultTarget === 'esp32c6' &&
  migrated.toolchain.baudRate === 115200
) {
  ok('旧 toolchain.json 三字段迁入 settings.json')
} else {
  fail('迁移', JSON.stringify(migrated.toolchain))
}
if (migrated.editor.minimap === true && migrated.appearance.language === 'zh-CN') {
  ok('未迁移字段保持默认值')
} else {
  fail('未迁移字段', JSON.stringify(migrated))
}
const legacyAfter = JSON.parse(readFileSync(legacyFile, 'utf8'))
if (legacyAfter.deprecated === true && legacyAfter.migratedTo === 'settings.json') {
  ok('旧源标记弃用', 'deprecated: true, migratedTo: settings.json')
} else {
  fail('旧源标记', JSON.stringify(legacyAfter))
}
if (existsSync(settingsFile())) ok('迁移结果落盘 settings.json')
else fail('迁移落盘', 'settings.json 未生成')

// 用户改设置后再「冷启动」:deprecated 旧文件不得再次覆盖
await invoke('settings:set-many', { 'toolchain.defaultTarget': 'esp32p4' })
await freshService()
const second = await invoke('settings:get-all')
if (second.toolchain.defaultTarget === 'esp32p4') ok('二次启动不重复迁移(用户修改保留)')
else fail('重复迁移', JSON.stringify(second.toolchain))

// ----------------------------------------------------------------
// 5) settings:reset 回默认值 + 广播
// ----------------------------------------------------------------
console.log('[5/5] settings:reset')
changedEvents.length = 0
const afterReset = await invoke('settings:reset')
if (deepEq(afterReset, defaults)) ok('reset 后为完整默认值')
else fail('reset', JSON.stringify(afterReset))
if (changedEvents.length === 2 && changedEvents[0].changedKeys.includes('toolchain.defaultTarget')) {
  ok('reset 广播 changedKeys', changedEvents[0].changedKeys.join(','))
} else {
  fail('reset 广播', JSON.stringify(changedEvents.map((e) => e.changedKeys)))
}
const resetDisk = JSON.parse(readFileSync(settingsFile(), 'utf8'))
if (resetDisk.toolchain.defaultTarget === 'esp32s3') ok('reset 落盘')
else fail('reset 落盘', JSON.stringify(resetDisk.toolchain))

// 收尾:临时目录清理 + 汇总
await rm(tmpRoot, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
