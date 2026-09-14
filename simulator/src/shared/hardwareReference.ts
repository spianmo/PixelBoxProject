/** 官方对照资料和制造检查契约；尺寸来源必须区分标注、恢复和假设。 */
import type { EnclosurePort, ScreenPlacement } from './ipc-types'
export interface OfficialNetlist {
  source: string
  sha256: string
  components: Array<{ name: string; pins: string[]; value: string }>
  nets: Array<{ name: string; pins: string[] }>
}
export interface HardwareReference {
  schemaVersion: 1
  kind?: 'official' | 'functional'
  source: string
  board: { widthMM: number; heightMM: number; thicknessMM: number; status: string }
  enclosure: { widthMM: number; depthMM: number; heightMM: number; cornerRMM: number }
  screen: ScreenPlacement & { outerMM: number; visibleCornerRMM: number }
  mounting: { centers: Array<{ x: number; y: number }>; target: 'enclosure'; status: string }
  ports: Array<EnclosurePort & { name: string; status: string }>
  electrical: { components: number; nets: number; pins: number; sha256: string }
  fabrication: { footprints: 'unverified' | 'verified'; routing: 'unavailable' | 'reconstructed'; drills: 'unavailable' | 'verified' }
  unverified: string[]
  /** 相对焊盘包围盒的机械尺寸；用于实体包络与装配检查，不改变电路焊盘。 */
  componentBodies?: Record<string, { w?: number; h?: number; heightMM: number; offsetX?: number; offsetY?: number; oppositeHeightMM?: number; kind?: 'module' | 'connector' | 'chip' | 'passive' }>
  rules?: { minTraceMM: number; minDrillMM: number; minAnnularRingMM: number; copperKeepout?: { x: number; y: number; w: number; h: number } }
}
