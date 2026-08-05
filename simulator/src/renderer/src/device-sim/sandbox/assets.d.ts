/**
 * device-sim 资源与虚拟模块类型声明
 * - *.woff2 由 sandbox/esbuildRuntimePlugin.ts 以 base64 loader 打入 runtime bundle
 * - virtual:pixelbox-sandbox-runtime 是 Vite 虚拟模块,内容为 esbuild 打包后的沙箱运行时源码字符串
 */
declare module '*.woff2' {
  const base64: string
  export default base64
}

declare module 'virtual:pixelbox-sandbox-runtime' {
  /** 沙箱运行时(IIFE 单文件)完整源码 */
  const code: string
  export default code
}
