/**
 * Rspack loader:把沙箱运行时(runtime/index.ts)用 esbuild 打成 IIFE 单文件,
 * 以 `virtual:pixelbox-sandbox-runtime` 虚拟模块(export default 源码字符串)
 * 提供给宿主 engine.ts 注入 iframe srcdoc。
 *
 * 接线方式(rsbuild.config.ts renderer 环境):
 *   resolve.alias 'virtual:pixelbox-sandbox-runtime$' → sandboxRuntime.virtual 桩文件
 *   module.rules  test /sandboxRuntime\.virtual$/ → 本 loader(桩文件内容被完全替换)
 *
 * 这样 dev 与打包产物行为完全一致:运行时代码(含 fast-png / jpeg-js / gifuct-js
 * 解码器与 base64 内嵌的缝合像素字体)在构建期就固化为字符串,不依赖任何运行期文件加载
 * (沙箱 opaque origin 无法 fetch 宿主资源)。
 *
 * 历史修复语义(自 vite 时代的 esbuildRuntimePlugin 完整保留):
 * 1. esbuild 参数与 scripts/selfcheck.mjs [2/7] 严格同参(IIFE / es2020 / woff2
 *    base64 内嵌),两处必须同步修改;
 * 2. 产物以 base64 形式输出,而非巨型 JS 字符串字面量:vite dev 的 import-analysis
 *    (es-module-lexer)曾在 ~1.7MB 字符串字面量上把打包产物内部的 `import(...)` /
 *    路径注释误判为真实导入导致解析失败。base64 字母表不含引号/括号/反斜杠,对任何
 *    词法分析器(含 SWC)都是惰性内容,dev 与 build 行为完全一致;
 * 3. dev watch:esbuild metafile 的 inputs 即运行时的真实依赖闭包,逐一登记为
 *    loader 依赖(this.addDependency 要求绝对路径,metafile key 是相对
 *    absWorkingDir 的路径,这里统一转绝对并过滤不存在项),改动任一依赖文件即
 *    触发虚拟模块重建 → renderer HMR。
 *
 * 注意:本文件运行于 Node(Rspack loader 进程),不要 require 渲染层代码。
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')
// 与 selfcheck.mjs / src/main/builder.ts 同一份 esbuild(simulator 依赖)
const esbuild = require('esbuild')

const SIM_ROOT = path.resolve(__dirname, '..')
/** runtime/index.ts 的绝对路径(桩文件内容无意义,入口在此固定) */
const RUNTIME_ENTRY = path.resolve(
  SIM_ROOT,
  'src/renderer/src/device-sim/sandbox/runtime/index.ts'
)

/** @this {import('@rspack/core').LoaderContext} */
module.exports = async function sandboxRuntimeLoader() {
  const callback = this.async()
  try {
    const result = await esbuild.build({
      entryPoints: [RUNTIME_ENTRY],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      charset: 'utf8',
      minify: false,
      sourcemap: false,
      metafile: true,
      // 像素字体 woff2 以 base64 字符串内嵌
      loader: { '.woff2': 'base64' },
      logLevel: 'silent',
      // metafile inputs key 相对本目录,与 loader 进程 cwd 解耦
      absWorkingDir: SIM_ROOT
    })
    if (result.errors.length > 0) {
      throw new Error('沙箱运行时打包失败:\n' + result.errors.map((e) => e.text).join('\n'))
    }
    // dev 模式:登记依赖文件,改动时触发虚拟模块重建(见头注释第 3 点)
    if (result.metafile) {
      for (const file of Object.keys(result.metafile.inputs)) {
        const abs = path.isAbsolute(file) ? file : path.resolve(SIM_ROOT, file)
        if (fs.existsSync(abs)) this.addDependency(abs)
      }
    }
    const code = result.outputFiles[0].text
    // base64 输出(见头注释第 2 点)
    const b64 = Buffer.from(code, 'utf8').toString('base64')
    callback(
      null,
      [
        `const b64 = "${b64}";`,
        'const bin = atob(b64);',
        'const bytes = new Uint8Array(bin.length);',
        'for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);',
        "export default new TextDecoder('utf-8').decode(bytes);"
      ].join('\n')
    )
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)))
  }
}
