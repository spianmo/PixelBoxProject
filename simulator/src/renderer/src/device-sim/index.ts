/**
 * 设备模拟引擎入口
 *
 * 外壳(DevicePanel)在挂载时调用 setupDeviceSim(container):
 * - 创建 SimEngine(沙箱 iframe + px shim + 特权 RPC 分发)
 * - 在 container 内渲染 React 外设面板(像素屏 + 虚拟外设控件)
 * - 把 PixelboxSimApi 挂到 window.__pixelboxSim,并派发 'pixelbox-sim:ready'
 *
 * 约定细节见同目录 README.md 与 types.ts
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PixelboxSimApi } from './types'
import { SimEngine } from './engine'
import { SimPanel } from './panel/SimPanel'

let engine: SimEngine | null = null
/** 容器 → React root(StrictMode 双执行 / 外壳重复挂载时复用) */
const roots = new WeakMap<HTMLElement, Root>()

/**
 * 初始化设备模拟引擎
 * @param container 右侧设备面板提供的挂载容器(已铺满可用区域)
 * @returns 引擎 API(与 window.__pixelboxSim 相同)
 */
export function setupDeviceSim(container: HTMLElement): PixelboxSimApi | null {
  // 幂等:引擎全局单例;同一容器复用同一 React root
  if (!engine) {
    engine = new SimEngine()
  }
  let root = roots.get(container)
  if (!root) {
    root = createRoot(container)
    roots.set(container, root)
  }
  root.render(React.createElement(SimPanel, { engine }))

  window.__pixelboxSim = engine.api
  window.dispatchEvent(new Event('pixelbox-sim:ready'))
  return engine.api
}
