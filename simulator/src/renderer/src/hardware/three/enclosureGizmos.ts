/**
 * enclosureGizmos —— 3D 视图「编辑外壳」交互手柄:几何派生 + 纯数学拖拽映射 + 手柄网格
 *
 * 分层(拖拽机制本身在 HardwareViewer,本文件不持有任何 viewer 状态):
 *   1. 纯数学(可脱离 WebGL 单测):
 *      - deriveEnclosureDims:从 BoardSpec+EnclosureParams 派生外壳世界尺寸,
 *        公式与 enclosureBuilder 严格一致(wall 下限 0.8、圆角壁跨度缩短、开孔夹取);
 *      - listHandleSpecs / listHandleIds:枚举手柄(4 个外壳参数手柄 + 每开孔 2 个);
 *      - computeDragPatch:手柄 id + 拖拽轴向位移 → Partial<EnclosureParams>,
 *        **全部钳制逻辑集中于此**(表单可有更宽区间,拖拽区间以本文件为准);
 *      - formatHandleReadout:拖拽中的数值悬浮读数文本(技术参数名,不走 i18n)。
 *   2. 网格构建:buildHandleGroup —— accent 色小球/小方块,depthTest 关闭 + 高 renderOrder
 *      (典型 gizmo 行为:始终可见、命中测试只对手柄网格做,不受模型遮挡)。
 *
 * 手柄一览(位置均为世界坐标,合拢态;爆炸与编辑模式由面板互斥):
 *   - lidHeight  :顶盖顶面中心,沿 Y 拖 → lidHeightMM(1..30)
 *   - clearance  :东墙外侧中点,沿 X 拖 → clearanceMM(0..10;外墙 x = 板半宽+间隙+壁厚,1:1)
 *   - baseHeight :东南角底盒壁顶沿,沿 Y 拖 → baseHeightMM(3..60;壁顶 y = wall+baseH,1:1)
 *   - cornerR    :东北角顶盖圆角弧 45° 点,沿水平对角线向内拖 → cornerR
 *                  (0..min(outerW,outerD)/2−0.1;弧点随 r 的位移增益 √2−1,
 *                   拖拽换算乘 CORNER_DRAG_GAIN=√2+1 使手柄精确跟手)
 *   - port-move-N:开孔中心(墙外表面微抬),墙面内二维拖 → port.x/y(夹在墙跨度内)
 *   - port-size-N:开孔右上角,墙面内二维拖 → port.w/h(中心不动,尺寸 ±2×位移;≥1)
 */
import * as THREE from 'three'
import type { BoardSpec, EnclosureParams, EnclosurePort } from '../types'

// ---------------------------------------------------------------
// 类型
// ---------------------------------------------------------------

export type EnclosureHandleId =
  | 'lidHeight'
  | 'clearance'
  | 'baseHeight'
  | 'cornerR'
  | `port-move-${number}`
  | `port-size-${number}`

export type EnclosureHandleKind = 'lid' | 'clearance' | 'base' | 'corner' | 'portMove' | 'portSize'

/** 纯数据三维向量(计算层不依赖 THREE 实例,便于单测直接断言) */
export interface Vec3Like {
  x: number
  y: number
  z: number
}

export interface EnclosureHandleSpec {
  id: EnclosureHandleId
  kind: EnclosureHandleKind
  /** 开孔手柄对应 params.ports 下标 */
  portIndex?: number
  /** 手柄世界坐标(合拢态) */
  position: Vec3Like
  /** 主拖拽轴(单位向量;computeDragPatch 的 delta.u 即沿此轴位移 mm) */
  axisU: Vec3Like
  /** 副轴(墙面内第二自由度,delta.v;单轴手柄为 null) */
  axisV: Vec3Like | null
  /** 拖拽约束平面法线;null = 运行时取「含 axisU 且最面向相机」的平面 */
  planeNormal: Vec3Like | null
}

/** 拖拽位移(沿 spec.axisU / axisV 的投影,mm) */
export interface DragDelta {
  u: number
  v?: number
}

/** 外壳派生尺寸(与 enclosureBuilder 同源公式;world 坐标 mm、Y 向上) */
export interface EnclosureDerivedDims {
  /** 有效壁厚 = max(wallMM, 0.8) */
  wall: number
  innerW: number
  innerD: number
  outerW: number
  outerD: number
  /** 底盒壁顶 y = wall + baseHeightMM */
  baseTopY: number
  /** 顶盖外表面 y = baseTopY + lidHeightMM + wall */
  lidOuterY: number
  /** 侧壁几何高度 = max(baseHeightMM, 1)(开孔 v 的夹取域) */
  wallH: number
  /** 有效圆角半径(traceRoundedRect 同款夹取) */
  rc: number
  /** rc > 0.05 时直壁两端各缩短 rc */
  rounded: boolean
  /** 南北墙跨度(开孔 u 的夹取域) */
  spanNS: number
  /** 东西墙跨度 */
  spanEW: number
}

// ---------------------------------------------------------------
// 常量(拖拽钳制区间;手柄观感)
// ---------------------------------------------------------------

const LID_HEIGHT_MIN = 1
const LID_HEIGHT_MAX = 30
const CLEARANCE_MIN = 0
const CLEARANCE_MAX = 10
const BASE_HEIGHT_MIN = 3
const BASE_HEIGHT_MAX = 60
/** cornerR 上限相对 min(outerW,outerD)/2 的退让 */
const CORNER_R_MARGIN = 0.1
/** 开孔最小边长 mm(拖拽下限;builder 自身兜底 0.5) */
const PORT_MIN_SIZE = 1
/**
 * 圆角弧 45° 点随 r 的位移增益:d|pos|/dr = √2·(1−√2/2) = √2−1,
 * 拖拽换算乘其倒数 √2+1,手柄沿对角线精确跟手
 */
export const CORNER_DRAG_GAIN = Math.SQRT2 + 1

/** 手柄基色(与 UI accent #3574F0 一致)与悬停提亮色 */
export const ENCLOSURE_HANDLE_COLOR = 0x3574f0
export const ENCLOSURE_HANDLE_HOVER_COLOR = 0x82b1ff

/** 手柄离开外壳表面的微抬 mm(防 z-fighting、观感悬浮) */
const HANDLE_SURFACE_OFFSET_MM = 0.6

const SQ2H = Math.SQRT2 / 2

// ---------------------------------------------------------------
// 纯数学:尺寸派生与拖拽映射
// ---------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
/** 数值落盘取 0.1mm 粒度(避免拖拽产生长尾浮点写入 enclosure.json) */
const round1 = (n: number): number => Math.round(n * 10) / 10

/** 与 enclosureBuilder.buildEnclosure 同源的尺寸推导(修改需两处同步) */
export function deriveEnclosureDims(spec: BoardSpec, params: EnclosureParams): EnclosureDerivedDims {
  const wall = Math.max(params.wallMM, 0.8)
  const innerW = spec.widthMM + 2 * params.clearanceMM
  const innerD = spec.heightMM + 2 * params.clearanceMM
  const outerW = innerW + 2 * wall
  const outerD = innerD + 2 * wall
  const baseTopY = wall + params.baseHeightMM
  const lidOuterY = baseTopY + params.lidHeightMM + wall
  const wallH = Math.max(params.baseHeightMM, 1)
  const rc = Math.min(Math.max(0, params.cornerR), outerW / 2 - 1e-4, outerD / 2 - 1e-4)
  const rounded = rc > 0.05
  return {
    wall,
    innerW,
    innerD,
    outerW,
    outerD,
    baseTopY,
    lidOuterY,
    wallH,
    rc,
    rounded,
    spanNS: rounded ? outerW - 2 * rc : outerW,
    spanEW: rounded ? outerD - 2 * rc : outerD - 2 * wall
  }
}

/** 墙面局部系 → 世界系:u 轴(沿墙正方向,enclosureBuilder 约定)与外法线 */
const WALL_AXES: Record<EnclosurePort['wall'], { u: Vec3Like; normal: Vec3Like }> = {
  north: { u: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: -1 } },
  south: { u: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
  east: { u: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 } },
  west: { u: { x: 0, y: 0, z: 1 }, normal: { x: -1, y: 0, z: 0 } }
}

function wallSpan(wall: EnclosurePort['wall'], d: EnclosureDerivedDims): number {
  return wall === 'north' || wall === 'south' ? d.spanNS : d.spanEW
}

/** 开孔有效尺寸/位置(与 enclosureBuilder.buildWallMesh 的收边夹取一致,手柄贴住实际孔位) */
function clampedHole(
  port: EnclosurePort,
  span: number,
  wallH: number
): { u: number; v: number; w: number; h: number } {
  const w = Math.min(Math.max(port.w, 0.5), span - 1)
  const h = Math.min(Math.max(port.h, 0.5), wallH - 1)
  const u = clamp(port.x, -span / 2 + w / 2 + 0.5, span / 2 - w / 2 - 0.5)
  const v = clamp(port.y, h / 2 + 0.5, wallH - h / 2 - 0.5)
  return { u, v, w, h }
}

/** 墙面局部 (u, v) → 世界坐标(墙外表面 + 微抬;v 基准为内腔地面 y=wall) */
function wallPoint(
  wall: EnclosurePort['wall'],
  u: number,
  v: number,
  d: EnclosureDerivedDims
): Vec3Like {
  const off = HANDLE_SURFACE_OFFSET_MM
  const y = d.wall + v
  switch (wall) {
    case 'north':
      return { x: u, y, z: -d.outerD / 2 - off }
    case 'south':
      return { x: u, y, z: d.outerD / 2 + off }
    case 'east':
      return { x: d.outerW / 2 + off, y, z: u }
    case 'west':
      return { x: -d.outerW / 2 - off, y, z: u }
  }
}

/**
 * 枚举当前参数下的全部手柄(位置为合拢态世界坐标)。
 * setHardware 重建后手柄组随之重建,位置始终由「参数 → 几何」单向派生。
 */
export function listHandleSpecs(spec: BoardSpec, params: EnclosureParams): EnclosureHandleSpec[] {
  const d = deriveEnclosureDims(spec, params)
  const off = HANDLE_SURFACE_OFFSET_MM
  const specs: EnclosureHandleSpec[] = []

  // 顶盖高:顶面中心,沿 Y
  specs.push({
    id: 'lidHeight',
    kind: 'lid',
    position: { x: 0, y: d.lidOuterY + off, z: 0 },
    axisU: { x: 0, y: 1, z: 0 },
    axisV: null,
    planeNormal: null
  })

  // 板边间隙:东墙外侧中点,沿 X(外墙 x = spec.w/2 + clearance + wall,对 clearance 1:1)
  specs.push({
    id: 'clearance',
    kind: 'clearance',
    position: { x: d.outerW / 2 + off, y: d.wall + d.wallH / 2, z: 0 },
    axisU: { x: 1, y: 0, z: 0 },
    axisV: null,
    planeNormal: null
  })

  // 底盒内腔高:东南角壁顶沿(圆角时取弧 45° 点),沿 Y
  const ccx = d.outerW / 2 - d.rc
  const ccz = d.outerD / 2 - d.rc // plan |y| → world |z|
  const cornerOut = d.rc * SQ2H + off * SQ2H
  specs.push({
    id: 'baseHeight',
    kind: 'base',
    position: { x: ccx + cornerOut, y: d.baseTopY, z: ccz + cornerOut },
    axisU: { x: 0, y: 1, z: 0 },
    axisV: null,
    planeNormal: null
  })

  // 外壳圆角:东北角顶盖圆角弧 45° 点,沿水平对角线向内(+dr = 更大圆角)
  specs.push({
    id: 'cornerR',
    kind: 'corner',
    position: { x: ccx + cornerOut, y: d.lidOuterY + off, z: -(ccz + cornerOut) },
    axisU: { x: -SQ2H, y: 0, z: SQ2H }, // 指向壳体中心(世界 -X/+Z 对角)
    axisV: null,
    planeNormal: null
  })

  // 开孔:中心移动手柄 + 右上角尺寸手柄(均在墙外表面平面内拖拽)
  params.ports.forEach((port, i) => {
    const axes = WALL_AXES[port.wall]
    const span = wallSpan(port.wall, d)
    const hole = clampedHole(port, span, d.wallH)
    specs.push({
      id: `port-move-${i}`,
      kind: 'portMove',
      portIndex: i,
      position: wallPoint(port.wall, hole.u, hole.v, d),
      axisU: axes.u,
      axisV: { x: 0, y: 1, z: 0 },
      planeNormal: axes.normal
    })
    specs.push({
      id: `port-size-${i}`,
      kind: 'portSize',
      portIndex: i,
      position: wallPoint(port.wall, hole.u + hole.w / 2, hole.v + hole.h / 2, d),
      axisU: axes.u,
      axisV: { x: 0, y: 1, z: 0 },
      planeNormal: axes.normal
    })
  })

  return specs
}

/** 手柄 id 清单(单测/冒烟枚举用;顺序与 listHandleSpecs 一致) */
export function listHandleIds(params: EnclosureParams): EnclosureHandleId[] {
  const ids: EnclosureHandleId[] = ['lidHeight', 'clearance', 'baseHeight', 'cornerR']
  params.ports.forEach((_, i) => {
    ids.push(`port-move-${i}`, `port-size-${i}`)
  })
  return ids
}

const PORT_HANDLE_RE = /^port-(move|size)-(\d+)$/

/**
 * 手柄拖拽 → 参数补丁(纯函数,**全部钳制集中在此**):
 *   - params 应为 pointerdown 时的快照(拖拽全程以快照+累计位移计算,
 *     store 回声不参与,天然防反馈环);
 *   - delta.u/v 为指针在约束平面上的位移沿 spec.axisU/axisV 的投影(mm);
 *   - 未知 id / 越界 portIndex 返回空补丁 {}。
 */
export function computeDragPatch(
  handleId: EnclosureHandleId,
  params: EnclosureParams,
  spec: BoardSpec,
  delta: DragDelta
): Partial<EnclosureParams> {
  const du = delta.u
  const dv = delta.v ?? 0

  switch (handleId) {
    case 'lidHeight':
      return { lidHeightMM: round1(clamp(params.lidHeightMM + du, LID_HEIGHT_MIN, LID_HEIGHT_MAX)) }
    case 'clearance':
      return { clearanceMM: round1(clamp(params.clearanceMM + du, CLEARANCE_MIN, CLEARANCE_MAX)) }
    case 'baseHeight':
      return {
        baseHeightMM: round1(clamp(params.baseHeightMM + du, BASE_HEIGHT_MIN, BASE_HEIGHT_MAX))
      }
    case 'cornerR': {
      const d = deriveEnclosureDims(spec, params)
      const maxR = Math.max(0, Math.min(d.outerW, d.outerD) / 2 - CORNER_R_MARGIN)
      return { cornerR: round1(clamp(params.cornerR + du * CORNER_DRAG_GAIN, 0, maxR)) }
    }
  }

  const m = PORT_HANDLE_RE.exec(handleId)
  if (!m) return {}
  const index = Number(m[2])
  const port = params.ports[index]
  if (!port) return {}

  const d = deriveEnclosureDims(spec, params)
  const span = wallSpan(port.wall, d)
  const ports = params.ports.map((p) => ({ ...p }))

  if (m[1] === 'move') {
    // 以 builder 的有效开孔尺寸定夹取域(w ≤ span−1 时 min ≤ max 恒成立,不会反转)
    const w = Math.min(Math.max(port.w, 0.5), span - 1)
    const h = Math.min(Math.max(port.h, 0.5), d.wallH - 1)
    ports[index] = {
      ...port,
      x: round1(clamp(port.x + du, -span / 2 + w / 2 + 0.5, span / 2 - w / 2 - 0.5)),
      y: round1(clamp(port.y + dv, h / 2 + 0.5, d.wallH - h / 2 - 0.5))
    }
  } else {
    // 角点手柄:中心不动,w/h 各按 2×位移伸缩(角点位置 = 中心 + w/2,精确跟手)
    ports[index] = {
      ...port,
      w: round1(clamp(port.w + 2 * du, PORT_MIN_SIZE, Math.max(PORT_MIN_SIZE, span - 1))),
      h: round1(clamp(port.h + 2 * dv, PORT_MIN_SIZE, Math.max(PORT_MIN_SIZE, d.wallH - 1)))
    }
  }
  return { ports }
}

/** 拖拽读数文本(悬浮框;技术参数名 + mm 数值,不走 i18n) */
export function formatHandleReadout(spec: EnclosureHandleSpec, params: EnclosureParams): string {
  switch (spec.kind) {
    case 'lid':
      return `lidHeight = ${params.lidHeightMM} mm`
    case 'clearance':
      return `clearance = ${params.clearanceMM} mm`
    case 'base':
      return `baseHeight = ${params.baseHeightMM} mm`
    case 'corner':
      return `cornerR = ${params.cornerR} mm`
    case 'portMove': {
      const p = params.ports[spec.portIndex ?? -1]
      return p ? `x = ${p.x}  y = ${p.y} mm` : ''
    }
    case 'portSize': {
      const p = params.ports[spec.portIndex ?? -1]
      return p ? `w = ${p.w}  h = ${p.h} mm` : ''
    }
  }
}

// ---------------------------------------------------------------
// 手柄网格
// ---------------------------------------------------------------

/**
 * 构建手柄网格组(name:'enclosureGizmos';每个子网格 userData.handleSpec 存其 spec)。
 * depthTest 关闭 + renderOrder 1000:手柄不被模型遮挡(典型 gizmo 行为);
 * 命中测试由查看器只对本组子网格 raycast,与屏幕面/部件互不干扰。
 * 几何在组内网格间共享,disposeObject3D 重复 dispose 幂等无害。
 */
export function buildHandleGroup(specs: EnclosureHandleSpec[], radiusMM = 1.4): THREE.Group {
  const group = new THREE.Group()
  group.name = 'enclosureGizmos'
  const sphereGeo = new THREE.SphereGeometry(radiusMM, 20, 14)
  const boxGeo = new THREE.BoxGeometry(radiusMM * 1.5, radiusMM * 1.5, radiusMM * 1.5)
  for (const spec of specs) {
    const mat = new THREE.MeshBasicMaterial({
      color: ENCLOSURE_HANDLE_COLOR,
      depthTest: false,
      transparent: true,
      opacity: 0.95
    })
    // 尺寸手柄用小方块与移动手柄(小球)区分语义
    const mesh = new THREE.Mesh(spec.kind === 'portSize' ? boxGeo : sphereGeo, mat)
    mesh.name = `handle:${spec.id}`
    mesh.renderOrder = 1000
    mesh.position.set(spec.position.x, spec.position.y, spec.position.z)
    mesh.userData.handleSpec = spec
    group.add(mesh)
  }
  return group
}
