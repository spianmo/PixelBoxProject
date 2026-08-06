/**
 * 模拟器会话管理(阶段 2:多实例)
 *
 * 「运行的设备」面板每个 tab 对应一个 SimSession(一台虚拟设备 = 一个 SimEngine
 * = 一个沙箱 iframe)。SimEngine 已按实例隔离(消息按 iframe source 过滤),
 * 这里负责:会话创建/复用/关闭、激活 tab 切换、window.__pixelboxSim 指向激活会话。
 *
 * 外壳约定:
 *   - 运行前把目标档案写进 window.__pixelboxSimContext.device,
 *     facade(index.ts)据此 ensureSession 并 load;
 *   - watch 热重载调用 reloadRunningSessions(),对所有运行中的会话热重载;
 *   - 标题栏 ⏹ / facade stop() 停止全部会话(逐 tab 的 ✕ 只关自己)。
 */
import { useSyncExternalStore } from 'react'
import type { DeviceProfile } from '../../../shared/ipc-types'
import type { SimManifest } from './types'
import { SimEngine } from './engine'
import { createStore, type Store } from './store'

/** 虚拟设备 key 前缀(外壳 selectedKey / 日志路由共用) */
export const SIM_KEY_PREFIX = 'sim:'

/** 档案 → 外壳设备 key */
export function simDeviceKey(profileId: string): string {
  return SIM_KEY_PREFIX + profileId
}

/** key 是否指向虚拟设备(否则为真机 ip:port) */
export function isSimDeviceKey(key: string): boolean {
  return key.startsWith(SIM_KEY_PREFIX)
}

/** 一个运行中的(或空闲的)模拟器会话 */
export interface SimSession {
  /** = simDeviceKey(profile.id) */
  key: string
  profile: DeviceProfile
  engine: SimEngine
}

export interface SimSessionsState {
  sessions: SimSession[]
  /** 激活 tab 的会话 key(无会话时为 null) */
  activeKey: string | null
}

/** 会话状态(RunningDevicesPanel tab 条 / SimHost 内容区订阅) */
export const simSessionsStore: Store<SimSessionsState> = createStore<SimSessionsState>({
  sessions: [],
  activeKey: null
})

/** React hook:订阅会话列表与激活 key */
export function useSimSessions(): SimSessionsState {
  return useSyncExternalStore(simSessionsStore.subscribe, simSessionsStore.get)
}

/** 按档案取会话,不存在则创建(引擎实例化)并设为激活 */
export function ensureSession(profile: DeviceProfile): SimSession {
  const key = simDeviceKey(profile.id)
  const st = simSessionsStore.get()
  const found = st.sessions.find((s) => s.key === key)
  if (found) {
    // 档案可能被编辑过(分辨率等):档案对象有变化时重建引擎,保证屏幕与能力一致
    if (found.profile === profile || sameProfile(found.profile, profile)) {
      if (st.activeKey !== key) simSessionsStore.set({ activeKey: key })
      return found
    }
    void found.engine.dispose()
    const rebuilt: SimSession = { key, profile, engine: new SimEngine({ profile, deviceKey: key }) }
    simSessionsStore.set({
      sessions: st.sessions.map((s) => (s.key === key ? rebuilt : s)),
      activeKey: key
    })
    return rebuilt
  }
  const session: SimSession = { key, profile, engine: new SimEngine({ profile, deviceKey: key }) }
  simSessionsStore.set({ sessions: [...st.sessions, session], activeKey: key })
  return session
}

/** 影响运行行为的档案字段是否一致(名称/备注变化无需重建引擎) */
function sameProfile(a: DeviceProfile, b: DeviceProfile): boolean {
  return (
    a.chip === b.chip &&
    a.screenW === b.screenW &&
    a.screenH === b.screenH &&
    a.psramMB === b.psramMB &&
    a.flashMB === b.flashMB
  )
}

/** 切换激活 tab */
export function setActiveSession(key: string): void {
  const st = simSessionsStore.get()
  if (st.sessions.some((s) => s.key === key)) simSessionsStore.set({ activeKey: key })
}

/** 关闭一个会话(tab ✕):停止应用、销毁引擎、移出列表 */
export function closeSession(key: string): void {
  const st = simSessionsStore.get()
  const target = st.sessions.find((s) => s.key === key)
  if (!target) return
  void target.engine.dispose()
  const sessions = st.sessions.filter((s) => s.key !== key)
  const activeKey =
    st.activeKey === key ? (sessions.length > 0 ? sessions[sessions.length - 1].key : null) : st.activeKey
  simSessionsStore.set({ sessions, activeKey })
}

/** 激活会话的引擎(无会话时 null) */
export function getActiveEngine(): SimEngine | null {
  const st = simSessionsStore.get()
  return st.sessions.find((s) => s.key === st.activeKey)?.engine ?? null
}

/** 是否有任一会话在运行(标题栏 ⏹ / watch 生命周期用) */
export function anySessionRunning(): boolean {
  return simSessionsStore.get().sessions.some((s) => s.engine.uiStore.get().running)
}

/** 订阅「任一会话运行中」:会话列表 + 各引擎 uiStore(模块级稳定引用,避免重复订阅) */
function subscribeAnyRunning(onChange: () => void): () => void {
  let engineUnsubs: Array<() => void> = []
  const resub = (): void => {
    engineUnsubs.forEach((u) => u())
    engineUnsubs = simSessionsStore.get().sessions.map((s) => s.engine.uiStore.subscribe(onChange))
  }
  const storeUnsub = simSessionsStore.subscribe(() => {
    resub()
    onChange()
  })
  resub()
  return () => {
    storeUnsub()
    engineUnsubs.forEach((u) => u())
  }
}

/**
 * React hook:任一会话运行中(订阅会话列表 + 各引擎 uiStore)。
 * 标题栏运行/停止按钮与 watch 停止逻辑用。
 */
export function useAnySimRunning(): boolean {
  return useSyncExternalStore(subscribeAnyRunning, anySessionRunning)
}

/** 停止全部会话(标题栏 ⏹ / facade stop();保留 tab 供再次运行) */
export function stopAllSessions(): void {
  for (const s of simSessionsStore.get().sessions) s.engine.api.stop()
}

/** watch 重建成功:对所有运行中的会话热重载最新 bundle */
export async function reloadRunningSessions(bundleCode: string, manifest: SimManifest): Promise<void> {
  const running = simSessionsStore.get().sessions.filter((s) => s.engine.uiStore.get().running)
  // 逐个串行重载,避免并发 storageLoad/readTree 抖动
  for (const s of running) {
    await s.engine.api.load(bundleCode, manifest)
  }
}
