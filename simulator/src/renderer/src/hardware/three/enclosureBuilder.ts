/**
 * enclosureBuilder —— 参数化 3D 打印外壳(底盒 base + 顶盖 lid),棱柱分解、零 CSG
 *
 * 几何策略(docs/plans/ide-v3-project-types.md §1/§2.4):
 *   - 每个部件由若干「闭合防水」的 2.5D 挤出实体拼合(THREE.Shape + holes + ExtrudeGeometry);
 *     同一 STL 内允许实体重叠,切片器(Prusa/Cura/Bambu)会自动 union。
 *   - 世界坐标:mm,Y 向上;板中心 = 外壳中心 = 原点;circuit +Y(板"北")→ three -Z。
 *   - 板顶面高度 boardTopY = wallMM + standoffHeightMM(底板厚 = wallMM);
 *     支撑柱从底板顶(y=wallMM)长到板底面(boardTopY - 板厚)。
 *
 * 部件构成:
 *   base(name:'base'):底板(圆角矩形) + 四面侧壁(各自带侧开孔,竖直平面挤出) + 四角环形支撑柱
 *   lid (name:'lid') :顶板(可开屏幕窗) + 外裙边(与盒壁同截面) + 内唇(伸入底盒定位)
 *
 * EnclosurePort 坐标约定(本文件为准,EnclosureForm 需一致):
 *   - port.x:沿所在壁、从壁中心起算的偏移 mm;north/south 壁正方向 = 世界 +X,
 *     east/west 壁正方向 = 世界 +Z(即板"南")
 *   - port.y:开孔中心距底盒**内腔地面**(底板顶面)的高度 mm
 */
import * as THREE from 'three'
import type { BoardSpec, EnclosureParams, EnclosurePort, ScreenPlacement } from '../types'

export interface EnclosureParts {
  base: THREE.Group
  lid: THREE.Group
}

/** 顶盖内唇与底盒内壁的单边装配间隙 mm */
const LID_FIT_CLEARANCE_MM = 0.25
/** 内唇伸入底盒的深度 mm */
const LID_LIP_DEPTH_MM = 2.5
/** 内唇壁厚 mm */
const LID_LIP_THICKNESS_MM = 1.2
/** 屏幕窗相对屏幕可视区的单边外扩 mm */
const SCREEN_WINDOW_MARGIN_MM = 0.8
/** 屏幕窗圆角 mm */
const SCREEN_WINDOW_CORNER_R_MM = 1
/** 支撑柱最小几何高度 mm(参数异常时兜底) */
const MIN_STANDOFF_GEO_MM = 0.5

const BASE_COLOR = '#98a2ad'
const LID_COLOR = '#aeb7c2'

/** 圆角矩形轮廓写入 path(plan 坐标:x 右、y 北(=world -z);cx/cy 为中心) */
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

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  traceRoundedRect(s, 0, 0, w, h, r)
  return s
}

function roundedRectHole(cx: number, cy: number, w: number, h: number, r: number): THREE.Path {
  const p = new THREE.Path()
  traceRoundedRect(p, cx, cy, w, h, r)
  return p
}

/**
 * plan 形状(x 右、y 北)竖直挤出为水平放置的实体:
 * rotateX(-90°) 把挤出方向转到 +Y,实体占据 y∈[bottomY, bottomY+height],plan y → world -z。
 */
function extrudePlan(shape: THREE.Shape, height: number, bottomY: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 24 })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, bottomY, 0)
  return new THREE.Mesh(geo, mat)
}

/**
 * 一面侧壁:局部 2D 平面(u = 沿壁方向,v = 距内腔地面高度)带圆角矩形开孔,
 * 挤出壁厚后由调用方旋转/平移到位。局部坐标:x=u(壁中心为 0)、y=v(0..height)、z=0..thickness。
 */
function buildWallMesh(
  length: number,
  height: number,
  thickness: number,
  holes: EnclosurePort[],
  mat: THREE.Material
): THREE.Mesh {
  const shape = new THREE.Shape()
  shape.moveTo(-length / 2, 0)
  shape.lineTo(length / 2, 0)
  shape.lineTo(length / 2, height)
  shape.lineTo(-length / 2, height)
  shape.closePath()
  for (const port of holes) {
    // 收进壁板边界内,保证孔洞闭合可打印
    const w = Math.min(Math.max(port.w, 0.5), length - 1)
    const h = Math.min(Math.max(port.h, 0.5), height - 1)
    const u = THREE.MathUtils.clamp(port.x, -length / 2 + w / 2 + 0.5, length / 2 - w / 2 - 0.5)
    const v = THREE.MathUtils.clamp(port.y, h / 2 + 0.5, height - h / 2 - 0.5)
    shape.holes.push(roundedRectHole(u, v, w, h, port.r ?? 0))
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 16 })
  return new THREE.Mesh(geo, mat)
}

/**
 * 构建参数化外壳。内腔尺寸 = 板尺寸 + 2×clearanceMM;所有几何均由参数推导。
 * 返回组 name:'base' / 'lid';均处于合拢位置(爆炸位移由 HardwareViewer 负责)。
 */
export function buildEnclosure(
  spec: BoardSpec,
  params: EnclosureParams,
  screen: ScreenPlacement | null
): EnclosureParts {
  const wall = Math.max(params.wallMM, 0.8)
  const innerW = spec.widthMM + 2 * params.clearanceMM
  const innerD = spec.heightMM + 2 * params.clearanceMM
  const outerW = innerW + 2 * wall
  const outerD = innerD + 2 * wall
  const baseTopY = wall + params.baseHeightMM // 底盒壁顶
  const boardTopY = wall + params.standoffHeightMM // 板顶面(契约)
  const cornerR = Math.max(0, params.cornerR)
  const innerCornerR = Math.max(0, cornerR - wall)

  const baseMat = new THREE.MeshStandardMaterial({ color: BASE_COLOR, roughness: 0.85, metalness: 0.05 })
  const lidMat = new THREE.MeshStandardMaterial({ color: LID_COLOR, roughness: 0.85, metalness: 0.05 })

  // ================= base =================
  const base = new THREE.Group()
  base.name = 'base'

  // 底板:外轮廓圆角矩形,y∈[0, wall]
  base.add(extrudePlan(roundedRectShape(outerW, outerD, cornerR), wall, 0, baseMat))

  // 四面侧壁:y∈[wall, baseTopY];north/south 通长 outerW,east/west 夹在两者之间避免共面
  const portsOf = (w: EnclosurePort['wall']): EnclosurePort[] => params.ports.filter((p) => p.wall === w)
  const wallH = Math.max(params.baseHeightMM, 1)
  const north = buildWallMesh(outerW, wallH, wall, portsOf('north'), baseMat)
  north.position.set(0, wall, -outerD / 2) // 局部 +u = +X,厚度朝 +Z(向内)
  const south = buildWallMesh(outerW, wallH, wall, portsOf('south'), baseMat)
  south.position.set(0, wall, outerD / 2 - wall)
  const east = buildWallMesh(outerD - 2 * wall, wallH, wall, portsOf('east'), baseMat)
  east.rotation.y = -Math.PI / 2 // 局部 (x,y,z) → 世界 (-z, y, x):+u = +Z,厚度朝 -X(向内)
  east.position.set(outerW / 2, wall, 0)
  const west = buildWallMesh(outerD - 2 * wall, wallH, wall, portsOf('west'), baseMat)
  west.rotation.y = -Math.PI / 2
  west.position.set(-outerW / 2 + wall, wall, 0)
  base.add(north, south, east, west)

  // 四角支撑柱:环形(螺孔贯通),底板顶 → 板底面
  const standoffH = Math.max(MIN_STANDOFF_GEO_MM, params.standoffHeightMM - spec.thicknessMM)
  const outerR = Math.max(params.standoffOuterR, params.standoffInnerR + 0.6)
  const inset = outerR // 柱边缘与板边对齐
  const sx = Math.max(spec.widthMM / 2 - inset, outerR)
  const sy = Math.max(spec.heightMM / 2 - inset, outerR)
  for (const [px, py] of [
    [sx, sy],
    [-sx, sy],
    [sx, -sy],
    [-sx, -sy]
  ] as const) {
    const ring = new THREE.Shape()
    ring.absarc(px, py, outerR, 0, Math.PI * 2, false)
    const hole = new THREE.Path()
    hole.absarc(px, py, Math.max(params.standoffInnerR, 0.2), 0, Math.PI * 2, true)
    ring.holes.push(hole)
    base.add(extrudePlan(ring, standoffH, wall, baseMat))
  }

  // ================= lid =================
  const lid = new THREE.Group()
  lid.name = 'lid'

  // 顶板:外轮廓 + 可选屏幕窗,y∈[baseTopY+lidHeightMM, +wall]
  const plate = roundedRectShape(outerW, outerD, cornerR)
  if (params.screenWindow && screen) {
    plate.holes.push(
      roundedRectHole(
        screen.x,
        screen.y, // plan 坐标即 circuit 坐标(extrudePlan 内部做 y→-z 映射)
        screen.w + 2 * SCREEN_WINDOW_MARGIN_MM,
        screen.h + 2 * SCREEN_WINDOW_MARGIN_MM,
        SCREEN_WINDOW_CORNER_R_MM
      )
    )
  }
  const lidPlateBottomY = baseTopY + params.lidHeightMM
  lid.add(extrudePlan(plate, wall, lidPlateBottomY, lidMat))

  // 外裙边:与盒壁同截面的环,盖住顶盖内腔侧面,y∈[baseTopY, lidPlateBottomY]
  if (params.lidHeightMM > 0.05) {
    const skirt = roundedRectShape(outerW, outerD, cornerR)
    skirt.holes.push(roundedRectHole(0, 0, innerW, innerD, innerCornerR))
    lid.add(extrudePlan(skirt, params.lidHeightMM, baseTopY, lidMat))
  }

  // 内唇:比内腔小一圈的环,伸入底盒定位,y∈[baseTopY-lipDepth, baseTopY]
  const lipOuterW = innerW - 2 * LID_FIT_CLEARANCE_MM
  const lipOuterD = innerD - 2 * LID_FIT_CLEARANCE_MM
  if (lipOuterW > 2 * LID_LIP_THICKNESS_MM + 1 && lipOuterD > 2 * LID_LIP_THICKNESS_MM + 1) {
    const lip = roundedRectShape(lipOuterW, lipOuterD, Math.max(0, innerCornerR - LID_FIT_CLEARANCE_MM))
    lip.holes.push(
      roundedRectHole(
        0,
        0,
        lipOuterW - 2 * LID_LIP_THICKNESS_MM,
        lipOuterD - 2 * LID_LIP_THICKNESS_MM,
        Math.max(0, innerCornerR - LID_FIT_CLEARANCE_MM - LID_LIP_THICKNESS_MM)
      )
    )
    lid.add(extrudePlan(lip, LID_LIP_DEPTH_MM, baseTopY - LID_LIP_DEPTH_MM, lidMat))
  }

  // 记录派生尺寸,供查看器计算爆炸距离/相机取景(非契约,仅辅助)
  base.userData.dims = { outerW, outerD, baseTopY, boardTopY }
  lid.userData.dims = { outerW, outerD, lidTopY: lidPlateBottomY + wall }

  return { base, lid }
}
