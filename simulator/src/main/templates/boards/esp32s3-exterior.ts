/** 原始 2.16 英寸外观约束：功能 PCB 和官方资料模板共用，内部改板不得改变外形。 */
import type { EnclosureParams } from "../../../shared/ipc-types"

export const centers = [-17, 17].flatMap((x) => [-18.5, 18.5].map((y) => ({ x, y })))
// 8.6/8.3 是从屏幕侧面量到接口中心的距离，z 从背壳底面起算。
// USB/SD 孔宽高与透声孔大小按图形比例重建，未标注公差；需要实物试装。
export const ports: EnclosureParams['ports'] = [
  ...[-10, 0, 10].map((x) => ({ wall: 'east' as const, x, y: 22.5 - 9.6 - 2, w: 5.3, h: 5.3, r: 2.65 })),
  { wall: 'west', x: 0, y: 22.5 - 8.6 - 2, w: 9.2, h: 3.6, r: 1.6 },
  { wall: 'north', x: 0, y: 22.5 - 8.3 - 2, w: 12, h: 2.4, r: 1 },
  ...[2, 5.4, 3.6, 7.4, 4.6, 2].map((h, i) => ({ wall: 'south' as const, x: -5 + i * 2, y: 5, w: 1, h, r: 0.5 }))
]
export const enclosure: EnclosureParams = {
  outerSizeMM: { w: 46, d: 46 }, wallMM: 2, clearanceMM: 0.4,
  baseHeightMM: 15, lidHeightMM: 3.5, standoffHeightMM: 9.5,
  standoffOuterR: 2, standoffInnerR: 1.1, standoffCenters: centers,
  cornerR: 5.8, screenWindow: true, screenMarginMM: 0, screenCornerRMM: 4.7,
  // OD 台阶深度/配合余量是重建参数；43.3 mm 是玻璃标注外尺寸。
  screenSeat: { w: 43.3, h: 43.3, depth: 1, clearance: 0.15, cornerR: 5.8 },
  colorHex: '#f2f2f4', batteryMM: { w: 28, h: 28, t: 5 }, ports
}
export const screenRect = { x: 0, y: 0, w: 38.99, h: 38.99 }
