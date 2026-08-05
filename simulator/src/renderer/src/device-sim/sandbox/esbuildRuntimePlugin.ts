/**
 * Vite 插件:把沙箱运行时(runtime/index.ts)用 esbuild 打成 IIFE 单文件,
 * 以虚拟模块 `virtual:pixelbox-sandbox-runtime` 的形式(export default 源码字符串)
 * 提供给宿主 engine.ts 注入 iframe srcdoc。
 *
 * 这样 dev 与打包产物行为完全一致:运行时代码(含 fast-png / jpeg-js / gifuct-js
 * 解码器与 base64 内嵌的缝合像素字体)在构建期就固化为字符串,不依赖任何运行期文件加载
 * (沙箱 opaque origin 无法 fetch 宿主资源)。
 *
 * 注意:本文件运行于 Node(electron.vite.config.ts 引用),不要 import 渲染层代码。
 */
import type { Plugin } from 'vite'
import * as esbuild from 'esbuild'

export const SANDBOX_RUNTIME_ID = 'virtual:pixelbox-sandbox-runtime'
const RESOLVED_ID = '\0' + SANDBOX_RUNTIME_ID

/**
 * @param entryPath runtime/index.ts 的绝对路径(由 electron.vite.config.ts 传入,
 *                  避免依赖打包后配置文件的 __dirname 语义)
 */
export function sandboxRuntimePlugin(entryPath: string): Plugin {
  return {
    name: 'pixelbox-sandbox-runtime',
    resolveId(id) {
      if (id === SANDBOX_RUNTIME_ID) return RESOLVED_ID
      return null
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null
      const result = await esbuild.build({
        entryPoints: [entryPath],
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
        logLevel: 'silent'
      })
      if (result.errors.length > 0) {
        throw new Error(
          '沙箱运行时打包失败:\n' + result.errors.map((e) => e.text).join('\n')
        )
      }
      // dev 模式:登记依赖文件,改动时触发虚拟模块重建
      if (result.metafile) {
        for (const file of Object.keys(result.metafile.inputs)) {
          this.addWatchFile(file)
        }
      }
      const code = result.outputFiles[0].text
      return `export default ${JSON.stringify(code)}`
    }
  }
}
