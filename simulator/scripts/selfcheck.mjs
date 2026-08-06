#!/usr/bin/env node
/**
 * device-sim 自检脚本(无 GUI 环境下验证 demo → load 链路的静态部分)
 *
 * 覆盖:
 *   1. demo 工程按 builder.ts 同参数 esbuild 打包(dist/main.js,ES2020 单文件)
 *   2. 沙箱运行时按 scripts/sandboxRuntimeLoader.cjs 同参数打包(IIFE + woff2 base64 内嵌)
 *   3. px shim 表面静态核对:16 个命名空间 + 13 个标准全局逐一在 bundle 中存在
 *      (运行期还有 verifySurface() 二次守卫,缺失即拒绝启动应用)
 *   4. srcdoc 组装:按 engine.ts 同逻辑做 </script 逃逸并核对
 *   5. 两个产物均通过 esbuild 语法解析
 *   6.【阶段 2】芯片能力表(shared/chipCapabilities.ts)与 d.ts PxDeviceInfo.capabilities
 *      字段一致性(单一数据源不漂移)
 *   7.【阶段 2】运行时初始化断言(Node vm + 最小 DOM 桩,真实实例化 ScreenImpl /
 *      createSystem / createWifi):内置档案 368×448(esp32s3)与 240×240(esp32c6)
 *      两档案下帧缓冲尺寸 / info().chip·screen·capabilities / psramFree / P4 wifi ENOTSUP
 *
 * 用法:cd simulator && npm run selfcheck
 */
import * as esbuild from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simRoot = resolve(__dirname, '..')

let failed = 0
function ok(label, extra = '') {
  console.log(`  ✓ ${label}${extra ? `(${extra})` : ''}`)
}
function fail(label, message) {
  failed++
  console.error(`  ✗ ${label}: ${message}`)
}

// ----------------------------------------------------------------
// 1) demo 构建(与 src/main/builder.ts 的 esbuildOptions 对齐)
// ----------------------------------------------------------------
console.log('[1/7] 构建 demo 工程(esbuild,与 builder.ts 同参数)')
const demoRoot = resolve(simRoot, 'demo')
const manifest = JSON.parse(readFileSync(resolve(demoRoot, 'pixelbox.json'), 'utf8'))
let demoCode = ''
try {
  const r = await esbuild.build({
    entryPoints: [resolve(demoRoot, 'src/main.ts')],
    outfile: resolve(demoRoot, 'dist', manifest.entry),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
    absWorkingDir: demoRoot
  })
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.text).join('; '))
  demoCode = readFileSync(resolve(demoRoot, 'dist', manifest.entry), 'utf8')
  ok('demo dist/main.js 生成', `${(demoCode.length / 1024).toFixed(1)} KB`)
} catch (err) {
  fail('demo 构建', err.message)
}

// ----------------------------------------------------------------
// 2) 沙箱运行时打包(与 scripts/sandboxRuntimeLoader.cjs 同参数)
// ----------------------------------------------------------------
console.log('[2/7] 打包沙箱运行时(IIFE + 像素字体内嵌)')
const runtimeEntry = resolve(simRoot, 'src/renderer/src/device-sim/sandbox/runtime/index.ts')
let runtimeCode = ''
try {
  const r = await esbuild.build({
    entryPoints: [runtimeEntry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',
    minify: false,
    sourcemap: false,
    loader: { '.woff2': 'base64' },
    logLevel: 'silent'
  })
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.text).join('; '))
  runtimeCode = r.outputFiles[0].text
  ok('runtime bundle 生成', `${(runtimeCode.length / 1024 / 1024).toFixed(2)} MB`)
  if (runtimeCode.length < 500 * 1024) {
    fail('runtime 体积', '异常偏小,像素字体可能未内嵌')
  } else {
    ok('像素字体已内嵌(体积符合预期)')
  }
} catch (err) {
  fail('runtime 打包', err.message)
}

// ----------------------------------------------------------------
// 3) px shim 表面静态核对(与 sdk/types/pixelbox.d.ts 契约对齐)
// ----------------------------------------------------------------
console.log('[3/7] px shim 表面核对(16 命名空间 + 13 标准全局)')
const NAMESPACES = [
  'system', 'app', 'storage', 'screen', 'input', 'audio', 'voice', 'wifi',
  'net', 'ble', 'camera', 'gps', 'sensors', 'led', 'util', 'color'
]
const GLOBALS = [
  'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'queueMicrotask', 'fetch', 'WebSocket', 'TextEncoder', 'TextDecoder',
  'atob', 'btoa', 'performance'
]
if (runtimeCode) {
  const missNs = NAMESPACES.filter((ns) => !new RegExp(`["']?${ns}["']?\\s*[:,]`).test(runtimeCode))
  if (missNs.length > 0) fail('命名空间', `bundle 中未找到: ${missNs.join(', ')}`)
  else ok(`16 个 px 命名空间全部在 bundle 中`)
  const missG = GLOBALS.filter((g) => !runtimeCode.includes(g))
  if (missG.length > 0) fail('标准全局', `bundle 中未找到: ${missG.join(', ')}`)
  else ok('13 个标准全局全部在 bundle 中')
  if (runtimeCode.includes('px shim')/* verifySurface 错误文案 */) {
    ok('运行期 verifySurface 守卫已打入')
  } else {
    fail('verifySurface', '运行期表面守卫缺失')
  }
}

// ----------------------------------------------------------------
// 4) srcdoc 组装(与 engine.ts 同逻辑)
// ----------------------------------------------------------------
console.log('[4/7] srcdoc 组装与 </script 逃逸')
if (runtimeCode) {
  const safe = runtimeCode.replace(/<\/script/gi, '<\\/script')
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${safe}</script></body></html>`
  const inner = srcdoc.slice(srcdoc.indexOf('<script>') + 8, srcdoc.lastIndexOf('</script>'))
  if (/<\/script/i.test(inner)) fail('srcdoc', '脚本体内仍残留 </script,会提前闭合')
  else ok('srcdoc 组装无 </script 逃逸残留')
}

// ----------------------------------------------------------------
// 5) 语法解析(两个产物均能被 es2020 解析)
// ----------------------------------------------------------------
console.log('[5/7] 产物语法解析')
try {
  if (demoCode) {
    await esbuild.transform(demoCode, { loader: 'js', target: 'es2020' })
    ok('demo bundle 语法有效')
  }
  if (runtimeCode) {
    await esbuild.transform(runtimeCode, { loader: 'js', target: 'es2020' })
    ok('runtime bundle 语法有效')
  }
} catch (err) {
  fail('语法解析', err.message)
}

// ----------------------------------------------------------------
// 6) 芯片能力表 ↔ d.ts capabilities 字段一致性(阶段 2)
// ----------------------------------------------------------------
console.log('[6/7] 芯片能力表与 d.ts capabilities 一致性')
try {
  // d.ts 侧:解析 PxDeviceInfo.capabilities 块的字段名
  const dts = readFileSync(resolve(simRoot, '../sdk/types/pixelbox.d.ts'), 'utf8')
  const capBlock = /capabilities:\s*\{([\s\S]*?)\}/.exec(dts)
  if (!capBlock) throw new Error('d.ts 中未找到 capabilities 块')
  const dtsKeys = [...capBlock[1].matchAll(/(\w+)\s*:\s*boolean/g)].map((m) => m[1]).sort()

  // 能力表侧:解析 CAPABILITY_KEYS 数组字面量(单一数据源 shared/chipCapabilities.ts)
  const capSrc = readFileSync(resolve(simRoot, 'src/shared/chipCapabilities.ts'), 'utf8')
  const keysBlock = /CAPABILITY_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(capSrc)
  if (!keysBlock) throw new Error('chipCapabilities.ts 中未找到 CAPABILITY_KEYS')
  const tableKeys = [...keysBlock[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()

  if (dtsKeys.length === tableKeys.length && dtsKeys.every((k, i) => k === tableKeys[i])) {
    ok('CAPABILITY_KEYS 与 d.ts capabilities 完全一致', dtsKeys.join(','))
  } else {
    fail('capabilities 一致性', `d.ts=[${dtsKeys.join(',')}] 能力表=[${tableKeys.join(',')}]`)
  }

  // 能力表关键行为抽查(与交付约定对齐)
  const mustHave = [
    [/chip:\s*'esp32c6'[\s\S]*?psram:\s*false/, 'esp32c6 无 PSRAM'],
    [/chip:\s*'esp32p4'[\s\S]*?wifi:\s*false/, 'esp32p4 无片上 WiFi'],
    [/chip:\s*'esp32c3'[\s\S]*?psram:\s*false/, 'esp32c3 无 PSRAM'],
    [/chip:\s*'esp32s3'[\s\S]*?dualCore:\s*true/, 'esp32s3 双核']
  ]
  const missBehavior = mustHave.filter(([re]) => !re.test(capSrc)).map(([, label]) => label)
  if (missBehavior.length > 0) fail('能力表行为', `缺失: ${missBehavior.join('; ')}`)
  else ok('能力表关键行为齐备(C6/C3 无 PSRAM · P4 无 WiFi · S3 双核)')
} catch (err) {
  fail('能力表一致性', err.message)
}

// ----------------------------------------------------------------
// 7) 运行时初始化断言(Node vm + 最小 DOM 桩;368×448 与 240×240 两档案)
// ----------------------------------------------------------------
console.log('[7/7] 运行时初始化断言(368×448 esp32s3 / 240×240 esp32c6 / P4 wifi ENOTSUP)')
try {
  // 与 runtime 同参数打包断言入口(真实引用 ScreenImpl/createSystem/createWifi/能力表)
  const r = await esbuild.build({
    entryPoints: [resolve(__dirname, 'checks/runtime-init.entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',
    minify: false,
    sourcemap: false,
    loader: { '.woff2': 'base64' },
    logLevel: 'silent'
  })
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.text).join('; '))
  const checkCode = r.outputFiles[0].text

  // 最小 DOM 桩:仅覆盖 ScreenImpl 构造/flush 所触达的 canvas 2D 表面
  const makeCanvasStub = () => {
    const canvas = { width: 0, height: 0 }
    canvas.getContext = () => ({
      canvas,
      imageSmoothingEnabled: false,
      fillStyle: '#000',
      font: '',
      textBaseline: 'top',
      fillRect() {},
      drawImage() {},
      fillText() {},
      measureText: () => ({ width: 0 }),
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData() {}
    })
    return canvas
  }
  const logs = []
  const sandbox = {
    console: { ...console, log: (...a) => logs.push(a.join(' ')) },
    document: {
      createElement: (tag) => {
        if (tag !== 'canvas') throw new Error(`DOM 桩仅支持 canvas,收到 ${tag}`)
        return makeCanvasStub()
      }
    },
    performance,
    navigator: { onLine: true },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    Uint8ClampedArray
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  let asyncFailure = null
  const onRejection = (reason) => {
    asyncFailure = reason instanceof Error ? reason.message : String(reason)
  }
  process.on('unhandledRejection', onRejection)
  try {
    vm.runInNewContext(checkCode, sandbox, { filename: 'runtime-init.check.js' })
    // 等待微任务/异步断言(P4 wifi.connect ENOTSUP)沉降
    await new Promise((res) => setTimeout(res, 50))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  if (asyncFailure) throw new Error(asyncFailure)
  if (!logs.includes('RUNTIME_INIT_OK')) throw new Error(`断言入口未输出成功标记(输出: ${logs.join(' | ')})`)
  ok('368×448(esp32s3):帧缓冲/chip/screen/capabilities/psramFree 全部通过')
  ok('240×240(esp32c6):帧缓冲 240×240×4 · psramFree === 0 通过')
  ok('esp32p4:wifi.connect ENOTSUP · ble/psram 能力表行为通过')
} catch (err) {
  fail('运行时初始化断言', err.message)
}

// 附:确认字体与许可文件在库中
const fontDir = resolve(simRoot, 'src/renderer/src/device-sim/sandbox/fonts')
if (existsSync(resolve(fontDir, 'OFL.txt'))) ok('字体 OFL 许可文件随库分发')
else fail('字体许可', 'fonts/OFL.txt 缺失')

console.log(failed === 0 ? '\n自检通过 ✔' : `\n自检失败 ✘(${failed} 项)`)
process.exit(failed === 0 ? 0 : 1)
