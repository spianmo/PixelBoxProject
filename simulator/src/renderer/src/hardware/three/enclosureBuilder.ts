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
 *   base(name:'base'):底板(圆角矩形) + 四面侧壁(各自带侧开孔,竖直平面挤出,
 *                       cornerR>0 时两端各缩短 cornerR) + 四角圆角柱(补齐壁圈缺口,
 *                       外轮廓沿底板圆角 —— 方角壁不再悬伸出圆角底板) + 四角环形支撑柱
 *   lid (name:'lid') :顶板(可开屏幕窗) + 外裙边(与盒壁同截面) + 内唇(伸入底盒定位)
 *   display(name:'display',可选):前置显示模组 —— 近黑亮面薄块,顶面 = 顶盖外表面
 *                       − 0.2mm 微沉,从内侧正好填住顶盖屏幕窗(实物堆叠:前玻璃/AMOLED
 *                       贴顶盖、FPC 连回板卡,而非沉在板顶);**非打印部件**
 *   battery(name:'battery',可选):params.batteryMM 电池占位 —— 底盒内腔地面居中的
 *                       圆角扁块,足印避让四角支撑柱、厚度钳制不越过板底面;**非打印部件**
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
  /** 前置显示模组(screenWindow 且检出屏幕时;非打印部件,userData.dims.screenFaceY 为顶面世界高度) */
  display: THREE.Group | null
  /** 电池占位(params.batteryMM 合法时;非打印部件) */
  battery: THREE.Group | null
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
/** 显示模组厚度 mm(前玻璃 + AMOLED 面板的简化堆叠) */
const DISPLAY_THICKNESS_MM = 2.2
/** 显示模组顶面相对顶盖外表面的微沉 mm(防 z-fighting,亦即实物玻璃略低于壳面) */
const DISPLAY_RECESS_MM = 0.2
/** 显示模组面板色(近黑亮面) */
const DISPLAY_COLOR = '#0d0f13'
/** 电池占位色(哑光钢青,'3.7V Li-Po' 观感) */
const BATTERY_COLOR = '#5a6b7a'

/** 内置回退色(params.colorHex 缺省/非法时) */
const BASE_COLOR = '#98a2ad'
const LID_COLOR = '#aeb7c2'
/** EnclosureParams.colorHex 合法格式:'#rrggbb' */
const COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * 外壳部件材质色:优先 params.colorHex(base 原色、lid 略提亮以区分部件),
 * 缺省或非法时回退内置灰(保持旧档案/旧工程观感不变)
 */
function enclosureColors(params: EnclosureParams): { base: THREE.Color; lid: THREE.Color } {
  if (params.colorHex && COLOR_HEX_RE.test(params.colorHex)) {
    const base = new THREE.Color(params.colorHex)
    const lid = base.clone().offsetHSL(0, 0, 0.03)
    return { base, lid }
  }
  return { base: new THREE.Color(BASE_COLOR), lid: new THREE.Color(LID_COLOR) }
}

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
 * 底盒四角柱截面(plan 坐标):外侧 1/4 圆弧(半径 rc,弧心 (cx,cy),起始角 a0)
 * 沿底板圆角轮廓;内侧在 rc ≤ 壁厚时收到弧心的方角(退化为 1/4 圆饼),
 * rc > 壁厚时为 1/4 内弧(半径 rc-壁厚,innerR),避免侵入内腔与顶盖内唇圆角干涉。
 * 两条径向直边与缩短后的直壁端面精确对接;轮廓闭合可打印。
 */
function cornerColumnShape(cx: number, cy: number, rc: number, innerR: number, a0: number): THREE.Shape {
  const a1 = a0 + Math.PI / 2
  const s = new THREE.Shape()
  if (innerR > 0.01) {
    // 1/4 圆环扇:内弧起点 → 外弧起点 → 外弧 → 内弧终点 → 内弧(反向)
    s.moveTo(cx + innerR * Math.cos(a0), cy + innerR * Math.sin(a0))
    s.lineTo(cx + rc * Math.cos(a0), cy + rc * Math.sin(a0))
    s.absarc(cx, cy, rc, a0, a1, false)
    s.lineTo(cx + innerR * Math.cos(a1), cy + innerR * Math.sin(a1))
    s.absarc(cx, cy, innerR, a1, a0, true)
  } else {
    // 1/4 圆饼:弧心方角 → 外弧起点 → 外弧
    s.moveTo(cx, cy)
    s.lineTo(cx + rc * Math.cos(a0), cy + rc * Math.sin(a0))
    s.absarc(cx, cy, rc, a0, a1, false)
  }
  s.closePath()
  return s
}

/**
 * 电池占位部件(非打印):底盒内腔地面居中的圆角扁块。足印钳制收进四角支撑柱
 * 内缘与内腔;厚度钳制顶面不越过板底面。独立导出:OpenSCAD 外壳路径(几何来自
 * scad STL)也复用它 —— 电池是成品部件,不属于打印壳体。
 */
export function buildBatteryPart(spec: BoardSpec, params: EnclosureParams): THREE.Group | null {
  const bat = params.batteryMM
  if (!bat || bat.w <= 0 || bat.h <= 0 || bat.t <= 0) return null
  const wall = Math.max(params.wallMM, 0.8)
  const innerW = spec.widthMM + 2 * params.clearanceMM
  const innerD = spec.heightMM + 2 * params.clearanceMM
  const boardTopY = wall + params.standoffHeightMM
  const outerR = Math.max(params.standoffOuterR, params.standoffInnerR + 0.6)
  const sx = Math.max(spec.widthMM / 2 - outerR, outerR)
  const sy = Math.max(spec.heightMM / 2 - outerR, outerR)
  const halfW = Math.min(bat.w / 2, innerW / 2 - 0.5, Math.max(2, sx - outerR))
  const halfH = Math.min(bat.h / 2, innerD / 2 - 0.5, Math.max(2, sy - outerR))
  const boardBottomY = boardTopY - spec.thicknessMM
  const t = Math.min(bat.t, Math.max(1, boardBottomY - wall - 0.2))
  const battery = new THREE.Group()
  battery.name = 'battery'
  const batMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(BATTERY_COLOR),
    roughness: 0.55,
    metalness: 0.2
  })
  battery.add(
    extrudePlan(roundedRectShape(halfW * 2, halfH * 2, Math.min(2, halfW / 2, halfH / 2)), t, wall, batMat)
  )
  return battery
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

  const colors = enclosureColors(params)
  const baseMat = new THREE.MeshStandardMaterial({ color: colors.base, roughness: 0.85, metalness: 0.05 })
  const lidMat = new THREE.MeshStandardMaterial({ color: colors.lid, roughness: 0.85, metalness: 0.05 })

  // ================= base =================
  const base = new THREE.Group()
  base.name = 'base'

  // 底板:外轮廓圆角矩形,y∈[0, wall]
  base.add(extrudePlan(roundedRectShape(outerW, outerD, cornerR), wall, 0, baseMat))

  // 四面侧壁:y∈[wall, baseTopY]。cornerR>0 时直壁两端各缩短 rc(圆角占位,开孔随
  // buildWallMesh 按缩短后的跨度自动夹取),缺口由四角圆角柱补齐 —— 壁圈外轮廓与底板/
  // 顶盖的圆角矩形一致,方角壁不再悬伸出圆角底板;rc≈0 时退回通长布局
  // (north/south 通长 outerW,east/west 夹在两者之间避免共面)
  const portsOf = (w: EnclosurePort['wall']): EnclosurePort[] => params.ports.filter((p) => p.wall === w)
  const wallH = Math.max(params.baseHeightMM, 1)
  const rc = Math.min(cornerR, outerW / 2 - 1e-4, outerD / 2 - 1e-4) // 与 traceRoundedRect 同款半径夹取
  const rounded = rc > 0.05
  const spanNS = rounded ? outerW - 2 * rc : outerW
  const spanEW = rounded ? outerD - 2 * rc : outerD - 2 * wall
  const north = buildWallMesh(spanNS, wallH, wall, portsOf('north'), baseMat)
  north.position.set(0, wall, -outerD / 2) // 局部 +u = +X,厚度朝 +Z(向内)
  const south = buildWallMesh(spanNS, wallH, wall, portsOf('south'), baseMat)
  south.position.set(0, wall, outerD / 2 - wall)
  const east = buildWallMesh(spanEW, wallH, wall, portsOf('east'), baseMat)
  east.rotation.y = -Math.PI / 2 // 局部 (x,y,z) → 世界 (-z, y, x):+u = +Z,厚度朝 -X(向内)
  east.position.set(outerW / 2, wall, 0)
  const west = buildWallMesh(spanEW, wallH, wall, portsOf('west'), baseMat)
  west.rotation.y = -Math.PI / 2
  west.position.set(-outerW / 2 + wall, wall, 0)
  base.add(north, south, east, west)

  // 四角圆角柱:与直壁同高同层,各自闭合防水,径向边与壁端面对接
  if (rounded) {
    const ccx = outerW / 2 - rc
    const ccy = outerD / 2 - rc
    const cornerInnerR = Math.max(0, rc - wall)
    const cornerDefs: Array<[number, number, number]> = [
      [ccx, ccy, 0], // 东北(plan +x,+y;plan y = 板"北" = world -z)
      [-ccx, ccy, Math.PI / 2], // 西北
      [-ccx, -ccy, Math.PI], // 西南
      [ccx, -ccy, Math.PI * 1.5] // 东南
    ]
    for (const [cx, cy, a0] of cornerDefs) {
      base.add(extrudePlan(cornerColumnShape(cx, cy, rc, cornerInnerR, a0), wallH, wall, baseMat))
    }
  }

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

  // ================= display 显示模组(非打印部件) =================
  // 实物堆叠修正:前玻璃/AMOLED 贴着顶盖窗口(FPC 连回板卡),而非沉在板顶 ——
  // 顶面 = 顶盖外表面 − DISPLAY_RECESS_MM,足印 = 屏幕可视区 AABB(与顶盖开窗同源,
  // 正好从内侧填住窗口);屏幕 CanvasTexture 贴片由 HardwareViewer 挂到本组顶面
  const lidOuterY = lidPlateBottomY + wall
  let display: THREE.Group | null = null
  if (params.screenWindow && screen) {
    display = new THREE.Group()
    display.name = 'display'
    const panelMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(DISPLAY_COLOR),
      roughness: 0.25,
      metalness: 0.2
    })
    const faceY = lidOuterY - DISPLAY_RECESS_MM
    const panel = new THREE.Shape()
    traceRoundedRect(panel, screen.x, screen.y, screen.w, screen.h, SCREEN_WINDOW_CORNER_R_MM)
    display.add(extrudePlan(panel, DISPLAY_THICKNESS_MM, faceY - DISPLAY_THICKNESS_MM, panelMat))
    display.userData.dims = { screenFaceY: faceY }
  }

  // ================= battery 电池占位(非打印部件) =================
  const battery = buildBatteryPart(spec, params)

  // 记录派生尺寸,供查看器计算爆炸距离/相机取景(非契约,仅辅助)
  base.userData.dims = { outerW, outerD, baseTopY, boardTopY }
  lid.userData.dims = { outerW, outerD, lidTopY: lidOuterY }

  return { base, lid, display, battery }
}
