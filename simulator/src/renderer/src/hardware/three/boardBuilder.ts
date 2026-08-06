/**
 * boardBuilder —— Circuit JSON → 板卡简化 3D(BoardSpec 提炼 + THREE.Group 构建)
 *
 * 坐标约定(docs/plans/ide-v3-project-types.md §2.4):
 *   - 世界单位 = mm,Y 轴向上(three 默认)
 *   - Circuit JSON 为板平面 2D(X 右、Y 上);映射 circuit (x, y) → three (x, -z),
 *     即板卡平躺在 XZ 平面,circuit +Y(板"北")指向 three -Z
 *   - BoardSpec 内所有坐标已归一化为「板中心 = 原点」(减去 pcb_board.center)
 *   - buildBoardGroup 返回的组:板**顶面**位于组局部 y=0(板体在 y∈[-thickness, 0]),
 *     由 HardwareViewer 把组抬到 y = wallMM + standoffHeightMM(板顶面世界高度)
 *
 * 仅使用 @tscircuit/circuit-json-util 的 su()(纯工具,无 React/core 依赖,渲染进程安全)。
 */
import * as THREE from 'three'
import { su } from '@tscircuit/circuit-json-util'
import type { AnyCircuitElement } from 'circuit-json'
import type { BoardSpec, BoardComponentBox, ScreenPlacement } from '../types'

/** 元件盒默认挤出高度 mm(契约默认值) */
const DEFAULT_COMPONENT_HEIGHT_MM = 2.5
/** pcb_board.thickness 缺省时的板厚 mm */
const DEFAULT_BOARD_THICKNESS_MM = 1.4
/** 默认阻焊色(muted 绿) */
const DEFAULT_BOARD_COLOR = '#1a7f37'
/** 无 outline 时矩形板的圆角 mm */
const BOARD_CORNER_R = 1
/** 元件名匹配此正则时视为屏幕(契约约定) */
const SCREEN_NAME_RE = /^(screen|display|lcd|amoled|oled)/i

/** 取第一块 pcb_board;无则抛 hw:noBoard */
function firstBoard(db: ReturnType<typeof su>): {
  centerX: number
  centerY: number
  widthMM: number
  heightMM: number
  thicknessMM: number
  outline?: { x: number; y: number }[]
  color?: string
} {
  const board = db.pcb_board.list()[0]
  if (!board) throw new Error('hw:noBoard')
  const centerX = board.center?.x ?? 0
  const centerY = board.center?.y ?? 0
  let widthMM = Number(board.width) || 0
  let heightMM = Number(board.height) || 0
  let outline: { x: number; y: number }[] | undefined
  if (Array.isArray(board.outline) && board.outline.length >= 3) {
    // 归一化:板中心移到原点
    outline = board.outline.map((p) => ({ x: p.x - centerX, y: p.y - centerY }))
    const xs = outline.map((p) => p.x)
    const ys = outline.map((p) => p.y)
    widthMM = Math.max(...xs) - Math.min(...xs)
    heightMM = Math.max(...ys) - Math.min(...ys)
  }
  if (!(widthMM > 0) || !(heightMM > 0)) throw new Error('hw:noBoard')
  const rawColor = board.solder_mask_color
  return {
    centerX,
    centerY,
    widthMM,
    heightMM,
    thicknessMM: Number(board.thickness) || DEFAULT_BOARD_THICKNESS_MM,
    outline,
    color: typeof rawColor === 'string' && rawColor.length > 0 ? rawColor : undefined
  }
}

/**
 * 从 Circuit JSON 提炼板卡简化 3D 规格(自包含,档案脱离工程也能渲染)。
 * 无 pcb_board(或板尺寸不可用)时 throw Error('hw:noBoard')。
 */
export function buildBoardSpec(circuitJson: AnyCircuitElement[]): BoardSpec {
  const db = su(circuitJson)
  const board = firstBoard(db)

  const components: BoardComponentBox[] = []
  for (const pc of db.pcb_component.list()) {
    const w = Number(pc.width) || 0
    const h = Number(pc.height) || 0
    if (w <= 0 || h <= 0) continue // 无外形的占位元件(如纯电气元素)不参与 3D
    const src = db.source_component.get(pc.source_component_id)
    components.push({
      id: pc.pcb_component_id,
      name: src?.name,
      x: pc.center.x - board.centerX,
      y: pc.center.y - board.centerY,
      w,
      h,
      heightMM: DEFAULT_COMPONENT_HEIGHT_MM,
      layer: pc.layer === 'bottom' ? 'bottom' : 'top'
    })
  }

  return {
    widthMM: board.widthMM,
    heightMM: board.heightMM,
    thicknessMM: board.thicknessMM,
    outline: board.outline,
    components,
    color: board.color ?? DEFAULT_BOARD_COLOR
  }
}

/** 把任意角度归一化到 0|90|180|270(就近取整) */
function normalizeRotation(deg: number | undefined): 0 | 90 | 180 | 270 {
  const r = ((Math.round((Number(deg) || 0) / 90) * 90) % 360 + 360) % 360
  return r as 0 | 90 | 180 | 270
}

/**
 * 检测屏幕元件:source_component.name 匹配 /^(screen|display|lcd|amoled|oled)/i 的
 * 第一个 pcb_component,用其外形做屏幕可视区(坐标相对板中心)。无则返回 null。
 */
export function detectScreenPlacement(circuitJson: AnyCircuitElement[]): ScreenPlacement | null {
  const db = su(circuitJson)
  const boardEl = db.pcb_board.list()[0]
  if (!boardEl) return null
  const centerX = boardEl.center?.x ?? 0
  const centerY = boardEl.center?.y ?? 0
  for (const pc of db.pcb_component.list()) {
    const src = db.source_component.get(pc.source_component_id)
    if (!src || !SCREEN_NAME_RE.test(src.name)) continue
    const w = Number(pc.width) || 0
    const h = Number(pc.height) || 0
    if (w <= 0 || h <= 0) continue
    return {
      x: pc.center.x - centerX,
      y: pc.center.y - centerY,
      w,
      h,
      rotationDeg: normalizeRotation(pc.rotation)
    }
  }
  return null
}

/** 圆角矩形路径(plan 坐标:x 右、y 北;cx/cy 为中心) */
function traceRoundedRect(path: THREE.Path, cx: number, cy: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4))
  const x0 = cx - w / 2
  const y0 = cy - h / 2
  const x1 = cx + w / 2
  const y1 = cy + h / 2
  path.moveTo(x0 + rr, y0)
  path.lineTo(x1 - rr, y0)
  if (rr > 0) path.absarc(x1 - rr, y0 + rr, rr, -Math.PI / 2, 0, false)
  path.lineTo(x1, y1 - rr)
  if (rr > 0) path.absarc(x1 - rr, y1 - rr, rr, 0, Math.PI / 2, false)
  path.lineTo(x0 + rr, y1)
  if (rr > 0) path.absarc(x0 + rr, y1 - rr, rr, Math.PI / 2, Math.PI, false)
  path.lineTo(x0, y0 + rr)
  if (rr > 0) path.absarc(x0 + rr, y0 + rr, rr, Math.PI, Math.PI * 1.5, false)
  path.closePath()
}

/**
 * 构建板卡 THREE.Group(name:'board'):
 *   - 板体:outline 多边形或圆角矩形,ExtrudeGeometry 挤出板厚
 *   - 元件盒:BoxGeometry,顶层坐在板顶面上、底层挂在板底面下
 * 组局部坐标:板顶面 y=0(见文件头坐标约定)。
 */
export function buildBoardGroup(spec: BoardSpec): THREE.Group {
  const group = new THREE.Group()
  group.name = 'board'
  const t = spec.thicknessMM

  // ---- 板体(plan 形状挤出,rotateX(-90°) 放平:plan y → world -z) ----
  const shape = new THREE.Shape()
  if (spec.outline && spec.outline.length >= 3) {
    shape.moveTo(spec.outline[0].x, spec.outline[0].y)
    for (let i = 1; i < spec.outline.length; i++) shape.lineTo(spec.outline[i].x, spec.outline[i].y)
    shape.closePath()
  } else {
    traceRoundedRect(shape, 0, 0, spec.widthMM, spec.heightMM, BOARD_CORNER_R)
  }
  const pcbGeo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 16 })
  pcbGeo.rotateX(-Math.PI / 2) // (x, y, z) → (x, z, -y):挤出方向落到 +Y
  pcbGeo.translate(0, -t, 0) // 板体 y∈[-t, 0],顶面在局部 y=0
  const pcbMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(spec.color ?? DEFAULT_BOARD_COLOR),
    roughness: 0.55,
    metalness: 0.15
  })
  const pcbMesh = new THREE.Mesh(pcbGeo, pcbMat)
  pcbMesh.name = 'pcb'
  group.add(pcbMesh)

  // ---- 元件盒(共享一份深灰材质) ----
  const compMat = new THREE.MeshStandardMaterial({ color: '#2b3138', roughness: 0.7, metalness: 0.25 })
  for (const c of spec.components) {
    const hMM = c.heightMM > 0 ? c.heightMM : DEFAULT_COMPONENT_HEIGHT_MM
    const geo = new THREE.BoxGeometry(Math.max(c.w, 0.2), hMM, Math.max(c.h, 0.2))
    const mesh = new THREE.Mesh(geo, compMat)
    mesh.name = c.name ?? c.id
    const y = c.layer === 'bottom' ? -t - hMM / 2 : hMM / 2
    mesh.position.set(c.x, y, -c.y) // circuit (x, y) → three (x, -z)
    group.add(mesh)
  }
  return group
}
