/**
 * OpenSCAD 编译产物(二进制 STL)→ three 部件组
 *
 * scad 坐标 Z-up、底面 z=0(打印床面);three 场景 Y-up —— 统一 rotateX(-90°)
 * 烘焙到几何(不用组旋转:exportSTL 的克隆/落床逻辑按几何包围盒工作)。
 * 材质与参数化路径同款(enclosureColors 的 base 原色 / lid 提亮),部件组
 * name 'base'/'lid' 与既有爆炸/导出/冒烟契约一致。
 *
 * display(屏幕贴图承载面)在 scad 模式下由 meta.screenFaceZ + 屏幕放置生成
 * (scad 只描述打印件;显示模组是成品部件,与参数化路径同样由 TS 侧补齐)。
 */
import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import type { EnclosureScadPayload, ScreenPlacement } from '../types'

/** 与 enclosureBuilder 的 DISPLAY_* 常量同值(scad 路径不引入其内部依赖) */
const DISPLAY_THICKNESS_MM = 2.2
const DISPLAY_COLOR = '#0d0f13'
const SCREEN_WINDOW_CORNER_R_MM = 1

const loader = new STLLoader()

export function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

export function arrayBufferToB64(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000 // 分块:大缓冲一次性 apply 会爆调用栈
  for (let i = 0; i < view.length; i += CHUNK) {
    bin += String.fromCharCode(...view.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function stlGroup(name: string, stlB64: string, color: THREE.Color): THREE.Group {
  const geo = loader.parse(b64ToArrayBuffer(stlB64))
  geo.rotateX(-Math.PI / 2) // scad Z-up → three Y-up(烘焙进几何)
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 })
  const group = new THREE.Group()
  group.name = name
  group.add(new THREE.Mesh(geo, mat))
  return group
}

export interface ScadEnclosureParts {
  base: THREE.Group
  lid: THREE.Group
  display: THREE.Group | null
  /** 电池占位(PB_META battery/batteryZ;scad 侧已钳制,此处只画盒) */
  battery: THREE.Group | null
}

/** 电池占位色(与旧参数化路径 BATTERY_COLOR 同值) */
const BATTERY_COLOR = '#5a6b7a'

/** 圆角盒(plan 足印 w×d,y ∈ [y0, y0+t];圆角半径 r) */
function roundedBox(w: number, d: number, t: number, y0: number, r: number, color: string): THREE.Mesh {
  const shape = new THREE.Shape()
  const rr = Math.min(r, w / 2 - 0.01, d / 2 - 0.01)
  shape.moveTo(-w / 2 + rr, -d / 2)
  shape.lineTo(w / 2 - rr, -d / 2)
  shape.absarc(w / 2 - rr, -d / 2 + rr, rr, -Math.PI / 2, 0, false)
  shape.lineTo(w / 2, d / 2 - rr)
  shape.absarc(w / 2 - rr, d / 2 - rr, rr, 0, Math.PI / 2, false)
  shape.lineTo(-w / 2 + rr, d / 2)
  shape.absarc(-w / 2 + rr, d / 2 - rr, rr, Math.PI / 2, Math.PI, false)
  shape.lineTo(-w / 2, -d / 2 + rr)
  shape.absarc(-w / 2 + rr, -d / 2 + rr, rr, Math.PI, Math.PI * 1.5, false)
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false })
  geo.rotateX(-Math.PI / 2) // plan → Y-up(挤出沿 +Y)
  geo.translate(0, y0, 0)
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.55,
    metalness: 0.2
  })
  return new THREE.Mesh(geo, mat)
}

/**
 * 由 scad 编译产物构建 base/lid(+display)。
 * colorHex 优先取 meta(scad 内 color_hex 变量),lid 自动提亮(与参数化路径一致)。
 */
export function buildScadEnclosureParts(
  scad: EnclosureScadPayload,
  screen: ScreenPlacement | null
): ScadEnclosureParts {
  const baseColor = new THREE.Color(scad.meta?.colorHex ?? '#98a2ad')
  const lidColor = baseColor.clone().offsetHSL(0, 0, 0.03)
  const base = stlGroup('base', scad.baseStlB64, baseColor)
  const lid = stlGroup('lid', scad.lidStlB64, lidColor)

  let display: THREE.Group | null = null
  const faceZ = scad.meta?.screenFaceZ
  if (scad.meta?.screenWindow && screen && typeof faceZ === 'number') {
    display = new THREE.Group()
    display.name = 'display'
    const shape = new THREE.Shape()
    const r = Math.min(SCREEN_WINDOW_CORNER_R_MM, screen.w / 2, screen.h / 2)
    const x0 = screen.x - screen.w / 2
    const y0 = screen.y - screen.h / 2
    shape.moveTo(x0 + r, y0)
    shape.lineTo(x0 + screen.w - r, y0)
    shape.absarc(x0 + screen.w - r, y0 + r, r, -Math.PI / 2, 0, false)
    shape.lineTo(x0 + screen.w, y0 + screen.h - r)
    shape.absarc(x0 + screen.w - r, y0 + screen.h - r, r, 0, Math.PI / 2, false)
    shape.lineTo(x0 + r, y0 + screen.h)
    shape.absarc(x0 + r, y0 + screen.h - r, r, Math.PI / 2, Math.PI, false)
    shape.lineTo(x0, y0 + r)
    shape.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: DISPLAY_THICKNESS_MM, bevelEnabled: false })
    // 挤出沿 +Z(plan 平面)→ 转到 Y-up:plan y → world -z(与 extrudePlan 同款映射)
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, faceZ - DISPLAY_THICKNESS_MM, 0)
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(DISPLAY_COLOR),
      roughness: 0.25,
      metalness: 0.2
    })
    display.add(new THREE.Mesh(geo, mat))
    display.userData.dims = { screenFaceY: faceZ }
  }

  let battery: THREE.Group | null = null
  const bat = scad.meta?.battery
  if (bat && typeof scad.meta?.batteryZ === 'number') {
    battery = new THREE.Group()
    battery.name = 'battery'
    battery.add(
      roundedBox(bat[0], bat[1], bat[2], scad.meta.batteryZ, Math.min(2, bat[0] / 4, bat[1] / 4), BATTERY_COLOR)
    )
  }
  return { base, lid, display, battery }
}
