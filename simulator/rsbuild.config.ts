import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { resolve } from 'node:path'

/**
 * Rsbuild 多 environments 三段构建配置:main / preload = node,renderer = web
 * (electron-vite → Rsbuild/Rspack 迁移;产物布局保持 out/{main,preload,renderer},
 *  electron-builder 配置零改动)
 *
 * - main/preload:外部化 node 依赖(esbuild/chokidar/ws/bonjour-service 运行时
 *   require;node-pty 为原生模块必须外部化,加载失败时 PtyService 回退 pipe 模式);
 *   zod 等 devDependencies 仍打进 bundle(与 electron-vite externalizeDepsPlugin
 *   只外部化 dependencies 的语义一致 —— electron-builder 不携带 devDependencies)
 * - renderer:React + Tailwind + Monaco;沙箱运行时经自定义 loader 固化为字符串
 *   (见 scripts/sandboxRuntimeLoader.cjs);?raw 导入走 Rsbuild 内置 JS_RAW 规则
 *   (asset/source,绕过 SWC,.d.ts 全文原样打入)
 * - dev 编排在 scripts/dev.mjs(renderer devServer + main/preload watch 写盘 +
 *   electron 启停,保持 ELECTRON_RENDERER_URL 语义)
 */

/** 沙箱运行时虚拟模块桩文件(内容由 sandboxRuntimeLoader.cjs 构建期生成) */
const SANDBOX_RUNTIME_STUB = resolve(
  __dirname,
  'src/renderer/src/device-sim/sandbox/sandboxRuntime.virtual'
)

export default defineConfig(({ command }) => {
  const isDev = command === 'dev'

  /** main/preload 共享:node 侧构建约定(CJS 输出、不压缩、sourcemap dev 开 prod 关) */
  const nodeOutput = (distRoot: string, externals: Record<string, string>) => ({
    target: 'node' as const,
    distPath: { root: distRoot },
    // Rsbuild 2 对 node target 默认输出 ESM(output.module=true);electron 以
    // CJS 语义加载 main(package.json 无 "type":"module")、preload 亦要求 CJS,
    // 必须显式关闭
    module: false,
    // 保持 out/ 产物可读可调试(electron-vite 时代同样不压缩 node 侧产物)
    minify: false,
    externals,
    // sourcemap:dev 开(主进程断点/堆栈定位)、prod 关(与 electron-vite 行为一致)
    sourceMap: { js: isDev ? ('source-map' as const) : (false as const) }
  })

  return {
    environments: {
      main: {
        source: { entry: { index: './src/main/index.ts' } },
        output: nodeOutput('out/main', {
          // electron 由运行时宿主提供
          electron: 'commonjs electron',
          // dependencies:运行期从 node_modules require(electron-builder 随包分发)
          esbuild: 'commonjs esbuild',
          chokidar: 'commonjs chokidar',
          ws: 'commonjs ws',
          'bonjour-service': 'commonjs bonjour-service',
          // node-pty 为原生模块(devDependencies):运行期 require 失败时回退 pipe 模式
          'node-pty': 'commonjs node-pty'
        }),
        // main 产物 dev 也写盘:electron 从 out/main/index.js 启动(见 scripts/dev.mjs)
        dev: { writeToDisk: true }
      },
      preload: {
        source: { entry: { index: './src/preload/index.ts' } },
        // preload 仅依赖 electron(contextBridge/ipcRenderer);node target → CJS 输出
        output: nodeOutput('out/preload', { electron: 'commonjs electron' }),
        dev: { writeToDisk: true }
      },
      renderer: {
        plugins: [pluginReact()],
        source: { entry: { index: './src/renderer/src/main.tsx' } },
        html: { template: './src/renderer/index.html' },
        output: {
          target: 'web' as const,
          distPath: { root: 'out/renderer' },
          // 打包产物经 file:// 加载(loadFile):publicPath 运行时自适应求相对根
          assetPrefix: 'auto',
          // @tscircuit/manifold-2d 等依赖的 emscripten 胶水含 Node 环境分支
          // (import('node:module') / require('node:fs')),由运行时
          // ENVIRONMENT_IS_NODE 守卫,浏览器中永不执行;但 `node:` scheme 请求
          // 会撞 Rspack 的 Unhandled scheme 报错(且 scheme 请求不走
          // NormalModuleReplacement/alias)→ 以 externals 在解析前替换为空对象
          externals: {
            'node:module': 'var {}',
            'node:fs': 'var {}',
            'node:path': 'var {}',
            'node:url': 'var {}'
          }
        },
        resolve: {
          alias: {
            '@renderer': resolve(__dirname, 'src/renderer/src')
          }
        },
        tools: {
          rspack: (config, { rspack, appendPlugins }) => {
            // device-sim:沙箱运行时虚拟模块(engine.ts 的导入名保持不变)。
            // `virtual:` 带 scheme 的请求会绕过 resolve.alias(被当作 URI 走
            // Unhandled scheme 报错),故在 beforeResolve 阶段整体改写请求到桩文件
            appendPlugins(
              new rspack.NormalModuleReplacementPlugin(
                /^virtual:pixelbox-sandbox-runtime$/,
                SANDBOX_RUNTIME_STUB
              )
            )
            config.module ??= {}
            config.module.rules ??= []
            config.module.rules.push({
              // 沙箱运行时:esbuild 打 IIFE → base64 字符串模块(历史修复语义
              // 与依赖 watch 见 scripts/sandboxRuntimeLoader.cjs 头注释)
              test: /sandboxRuntime\.virtual$/,
              type: 'javascript/auto',
              use: [{ loader: resolve(__dirname, 'scripts/sandboxRuntimeLoader.cjs') }]
            })
            // monaco esm 源码里残留 __filename/__dirname 引用:web 端默认行为即
            // mock,这里显式声明以消除 dev 每次编译的告警刷屏(行为不变)
            config.node = { ...config.node, __filename: 'mock', __dirname: 'mock' }
          }
        }
      }
    }
  }
})
