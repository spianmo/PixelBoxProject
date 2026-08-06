/**
 * 硬件设计默认参数(main / renderer 共享的运行时常量)
 *
 * ipc-types.ts 保持纯类型零运行时代码的约定,常量单独放本文件:
 * - DEFAULT_ENCLOSURE:参数化外壳默认值(hardware 脚手架 design/enclosure.json
 *   初始内容;renderer hardware/store.ts 载入失败时的回退基线)
 */
import type { EnclosureParams } from './ipc-types'

/** 参数化外壳默认值(单位 mm;适配 M2 自攻螺丝支撑柱) */
export const DEFAULT_ENCLOSURE: EnclosureParams = {
  wallMM: 2,
  clearanceMM: 1,
  baseHeightMM: 12,
  lidHeightMM: 3,
  standoffHeightMM: 4,
  standoffOuterR: 3,
  standoffInnerR: 1.1,
  cornerR: 2,
  screenWindow: true,
  ports: []
}
