import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { sandboxRuntimePlugin } from './src/renderer/src/device-sim/sandbox/esbuildRuntimePlugin'

/**
 * electron-vite 三段构建配置:main / preload / renderer
 * - main/preload:外部化 node 依赖(esbuild/chokidar/ws/bonjour-service 运行时 require)
 * - renderer:React + Tailwind + Monaco;允许访问仓库根以便 ?raw 导入 sdk/types/pixelbox.d.ts
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // node-pty 为原生模块(devDependencies,externalizeDepsPlugin 只处理 dependencies),
        // 必须显式外部化:运行期从 node_modules require,失败时 PtyService 回退 pipe 模式
        external: ['node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [
      react(),
      // device-sim:沙箱运行时经 esbuild 固化为字符串(虚拟模块)
      sandboxRuntimePlugin(
        resolve(__dirname, 'src/renderer/src/device-sim/sandbox/runtime/index.ts')
      )
    ],
    server: {
      fs: {
        // 开发模式下允许读取仓库根(pixelbox.d.ts 在 simulator/ 之外)
        allow: [resolve(__dirname, '..')]
      }
    },
    build: {
      // monaco-editor 单 chunk 较大,放宽警告阈值
      chunkSizeWarningLimit: 8000
    }
  }
})
