/**
 * 设备模拟引擎入口(阶段 2:多实例会话)
 *
 * 外壳(RunningDevicesPanel)在挂载时调用 setupDeviceSim(container, opts?):
 * - 在 container 内渲染 SimHost(激活会话的像素屏 + 工具条 + 虚拟外设控件)
 * - 把 facade 形态的 PixelboxSimApi 挂到 window.__pixelboxSim 并派发 'pixelbox-sim:ready'
 *
 * facade 语义(§1–§3 契约不变,多实例增量见 README §8):
 * - load(code, manifest):按 window.__pixelboxSimContext.device 选择/创建会话
 *   (每档案一个 tab、一个 SimEngine、一个沙箱 iframe),对该会话热重载
 * - stop():停止全部会话(逐 tab 的 ✕ 走 sessions.closeSession)
 * - running:任一会话运行中即 true
 */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PixelboxSimApi, SimManifest } from './types'
import type { SimEngine } from './engine'
import { BUILTIN_DEVICE_PROFILE } from '../../../shared/chipCapabilities'
import { SimHost } from './panel/SimHost'
import { anySessionRunning, ensureSession, getActiveEngine, stopAllSessions } from './sessions'

export {
  simSessionsStore,
  useSimSessions,
  useAnySimRunning,
  ensureSession,
  setActiveSession,
  closeSession,
  stopAllSessions,
  reloadRunningSessions,
  simDeviceKey,
  isSimDeviceKey,
  SIM_KEY_PREFIX,
  type SimSession
} from './sessions'

/** 容器 → React root(StrictMode 双执行 / 外壳重复挂载时复用) */
const roots = new WeakMap<HTMLElement, Root>()

/** facade 单例(会话为多实例,对外 API 保持单一入口) */
let facadeApi: PixelboxSimApi | null = null

/** setupDeviceSim 可选项(兼容保留;多实例后屏幕尺寸由会话档案决定) */
export interface SetupDeviceSimOptions {
  /** 兼容字段:未通过运行上下文提供档案时的缺省分辨率(当前仅内置档案路径使用) */
  screen?: { width: number; height: number }
}

function buildFacade(): PixelboxSimApi {
  return {
    async load(bundleCode: string, manifest: SimManifest): Promise<void> {
      // 目标档案:外壳在运行前写入 __pixelboxSimContext.device;缺省回退内置档案
      const profile = window.__pixelboxSimContext?.device ?? BUILTIN_DEVICE_PROFILE
      const session = ensureSession(profile)
      await session.engine.api.load(bundleCode, manifest)
    },
    stop(): void {
      stopAllSessions()
    },
    get running(): boolean {
      return anySessionRunning()
    }
  }
}

/**
 * 初始化设备模拟宿主
 * @param container 右侧「运行的设备」面板提供的挂载容器(已铺满可用区域)
 * @param _opts     兼容参数(阶段 2 起分辨率由设备档案驱动)
 * @returns facade API(与 window.__pixelboxSim 相同)
 */
export function setupDeviceSim(
  container: HTMLElement,
  _opts?: SetupDeviceSimOptions
): PixelboxSimApi | null {
  let root = roots.get(container)
  if (!root) {
    root = createRoot(container)
    roots.set(container, root)
  }
  root.render(React.createElement(SimHost))

  facadeApi ??= buildFacade()
  window.__pixelboxSim = facadeApi
  window.dispatchEvent(new Event('pixelbox-sim:ready'))
  return facadeApi
}

/**
 * 引擎实例访问器(兼容保留):返回激活 tab 的引擎;
 * 无会话时为 null。多实例场景请改用 sessions.ts 的会话 API。
 */
export function getSimEngine(): SimEngine | null {
  return getActiveEngine()
}
