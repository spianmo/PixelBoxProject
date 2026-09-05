/**
 * device-sim 资源与虚拟模块类型声明
 * - *.woff2 两种口径都是字符串:沙箱侧由 scripts/sandboxRuntimeLoader.cjs 以 esbuild
 *   base64 loader 打入 runtime bundle;外壳侧(errorCard.ts)走 Rsbuild 默认资源规则
 *   得到 URL / data URI,两者都能喂给 FontFace
 * - virtual:pixelbox-sandbox-runtime 是虚拟模块(rsbuild.config.ts 别名 →
 *   sandboxRuntime.virtual 桩 → loader 构建期生成),内容为 esbuild 打包后的
 *   沙箱运行时源码字符串
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
