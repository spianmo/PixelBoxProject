import assert from 'node:assert/strict'
import { Quaternion, Vector3 } from 'three'
import { bindImuPose, poseFromImu, sampleImuPose } from '../../src/renderer/src/device-sim/imuPose'
import { createStore } from '../../src/renderer/src/device-sim/store'
import type { PeriphSnapshot } from '../../src/renderer/src/device-sim/protocol'

const identity = new Quaternion()
const near = (value: number, expected: number): void => { assert.ok(Math.abs(value - expected) < 1e-8, `${value} != ${expected}`) }
const rotate = (x: number, y: number, z: number, angle: number): Quaternion =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z), angle)

// 已知的物理方向与角速度:平放、翻面、左右/上下竖立、绕屏幕法线自转。
const cases = [
  { pose: identity, accel: [0, 0, 1], gyro: [0, 0, 0] },
  { pose: rotate(1, 0, 0, Math.PI), accel: [0, 0, -1], gyro: [180, 0, 0] },
  { pose: rotate(1, 0, 0, Math.PI / 2), accel: [0, 1, 0], gyro: [90, 0, 0] },
  { pose: rotate(1, 0, 0, -Math.PI / 2), accel: [0, -1, 0], gyro: [-90, 0, 0] },
  { pose: rotate(0, 0, 1, Math.PI / 2), accel: [1, 0, 0], gyro: [0, -90, 0] },
  { pose: rotate(0, 0, 1, -Math.PI / 2), accel: [-1, 0, 0], gyro: [0, 90, 0] },
  { pose: rotate(0, 1, 0, Math.PI / 2), accel: [0, 0, 1], gyro: [0, 0, 90] }
]
for (const { pose, accel, gyro } of cases) {
  const s = sampleImuPose(pose, identity, 1)
  ;[s.ax, s.ay, s.az].forEach((v, i) => near(v, accel[i]))
  ;[s.gx, s.gy, s.gz].forEach((v, i) => near(v, gyro[i]))
  near(Math.hypot(s.ax, s.ay, s.az), 1)
  const restored = sampleImuPose(poseFromImu(s), identity, 0)
  ;[restored.ax, restored.ay, restored.az].forEach((v, i) => near(v, accel[i]))
}
const negativeIdentity = new Quaternion(0, 0, 0, -1)
near(sampleImuPose(negativeIdentity, identity, 0.01).gx, 0)
const beforeWrap = rotate(0, 1, 0, Math.PI * 179 / 180)
const afterWrap = rotate(0, 1, 0, -Math.PI * 179 / 180)
near(sampleImuPose(afterWrap, beforeWrap, 0.1).gz, 20)
const localX = rotate(1, 0, 0, Math.PI / 2)
near(sampleImuPose(beforeWrap.clone().multiply(localX), beforeWrap, 1).gx, 90)
near(sampleImuPose(localX, identity, 0.5).gx, 180)
near(sampleImuPose(localX, identity, 0).gx, 0)

const initial: PeriphSnapshot = {
  imu: sampleImuPose(identity, identity, 0), battery: { level: 88, charging: false },
  gps: { lat: 0, lng: 0 }, led: { available: false, count: 8 }
}
const store = createStore(initial)
const other = createStore(initial)
let displayed = identity.clone()
let changes = 0
store.subscribe(() => { changes++ })
let binding = bindImuPose(store, (pose) => { displayed = pose.clone() })
binding.update(localX, 1)
near(store.get().imu.ay, 1)
near(store.get().imu.gx, 90)
assert.equal(changes, 1)
assert.equal(other.get(), initial)
binding.dispose()
near(store.get().imu.gx, 0)
binding = bindImuPose(store, (pose) => { displayed = pose.clone() })
near(displayed.angleTo(localX), 0)
store.set({ imu: { ax: -1, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 } })
near(sampleImuPose(displayed, identity, 0).ax, -1)
store.set({ imu: { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 } })
assert.ok(displayed.toArray().every(Number.isFinite))
store.set({ imu: initial.imu })
near(displayed.angleTo(identity), 0)
binding.dispose()
console.log('IMU_POSE_OK: 坐标、角速度、重置、切换恢复与设备隔离断言通过')
