import { MathUtils, Quaternion, Vector3 } from 'three'
import type { PeriphSnapshot } from './protocol'
import type { Store } from './store'

type ImuSample = PeriphSnapshot['imu']
const UP = new Vector3(0, 1, 0)

/** 板卡坐标:IMU (x,y,z) = Three (x,-z,y),平放时加速度计测得 +1g。 */
export function sampleImuPose(pose: Quaternion, previous: Quaternion, seconds: number): ImuSample {
  const gravity = UP.clone().applyQuaternion(pose.clone().invert())
  const angular = new Vector3()
  if (seconds > 0) {
    // 相邻姿态之差转到设备局部系;选择最短旋转,避免四元数符号翻转产生角速度尖峰。
    const delta = previous.clone().invert().multiply(pose).normalize()
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w)
    angular.set(delta.x, delta.y, delta.z)
    const sinHalf = angular.length()
    if (sinHalf > 1e-10) {
      angular.multiplyScalar(MathUtils.radToDeg(2 * Math.atan2(sinHalf, delta.w)) / (sinHalf * seconds))
    }
  }
  return { ax: gravity.x, ay: -gravity.z, az: gravity.y, gx: angular.x, gy: -angular.z, gz: angular.y }
}

/** 手动滑条只提供重力方向,不能确定航向;恢复最短倾转,零重力时保留上一姿态。 */
export function poseFromImu(imu: ImuSample, previous = new Quaternion()): Quaternion {
  const gravity = new Vector3(imu.ax, imu.az, -imu.ay)
  return gravity.lengthSq() > 1e-10
    ? new Quaternion().setFromUnitVectors(gravity.normalize(), UP)
    : previous.clone()
}

// 按引擎的外设 store 保留姿态(含航向),2D/3D 与设备 tab 切换后恢复;销毁后可自动回收。
const poses = new WeakMap<Store<PeriphSnapshot>, { pose: Quaternion; imu: ImuSample }>()

export function bindImuPose(store: Store<PeriphSnapshot>, setPose: (pose: Quaternion) => void): {
  update(pose: Quaternion, seconds: number): void
  dispose(): void
} {
  const imu = store.get().imu
  const state = poses.get(store) ?? { pose: poseFromImu(imu), imu }
  poses.set(store, state)
  const sync = (): void => {
    const next = store.get().imu
    if (next === state.imu) return
    state.pose.copy(poseFromImu(next, state.pose))
    state.imu = next
    setPose(state.pose)
  }
  sync()
  setPose(state.pose)
  const unsubscribe = store.subscribe(sync)
  const update = (pose: Quaternion, seconds: number): void => {
    const next = sampleImuPose(pose, state.pose, seconds)
    state.pose.copy(pose)
    // 先记录本次写入的对象,订阅回声不再反算姿态,避免拖动时丢失航向或形成循环。
    state.imu = next
    store.set({ imu: next })
  }
  return {
    update,
    dispose: () => {
      unsubscribe()
      const current = store.get().imu
      if (current.gx !== 0 || current.gy !== 0 || current.gz !== 0) update(state.pose, 0)
    }
  }
}
