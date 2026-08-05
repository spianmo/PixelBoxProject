/**
 * renderer 侧的 window.api 类型声明(来源于 preload 实际暴露的对象)
 */
import type { SimulatorApi } from './index'

declare global {
  interface Window {
    api: SimulatorApi
  }
}

export {}
