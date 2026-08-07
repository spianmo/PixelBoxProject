/**
 * boardBuilder —— Circuit JSON → 板卡简化 3D(BoardSpec 提炼 + THREE.Group 构建)
 *
 * 元件按 BoardComponentBox.kind(名前缀 + 焊盘数推断)走形状工厂:
 * ESP32 模组(基板/屏蔽罩/天线区,罩体带 subExplode 内部爆炸)、USB-C 金属壳、
 * 按键、SD 卡座、麦克风、LED、贴片阻容、连接器,其余为深灰芯片盒 + pin1 点。
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
/** module 判定的最小焊盘数(真模组封装焊盘数远高于普通芯片;模板 U1 实测 73) */
const MODULE_MIN_PADS = 40
/** 模组屏蔽罩内部爆炸抬升距离 mm(HardwareViewer 按爆炸因子应用,见 userData.subExplode) */
const MODULE_SHIELD_EXPLODE_MM = 4

/** 元件类别(契约 BoardComponentBox.kind;缺省按 'chip' 渲染) */
type ComponentKind = NonNullable<BoardComponentBox['kind']>

/**
 * 按 source_component 名前缀 + 焊盘数推断元件类别(C2 契约):
 * U 前缀/含 ESP32 且焊盘 ≥40 → module(QFN 大芯片焊盘远达不到 40),
 * USB→usb,SW→button,SD→sd,MIC→mic,LED→led,R/C→passive,J→connector,其余 chip。
 */
function inferComponentKind(name: string | undefined, padCount: number): ComponentKind {
  const n = (name ?? '').toUpperCase()
  if (padCount >= MODULE_MIN_PADS && (/^U\d/.test(n) || n.includes('ESP32'))) return 'module'
  if (n.startsWith('USB')) return 'usb'
  if (n.startsWith('SW')) return 'button'
  if (n.startsWith('SD')) return 'sd'
  if (n.startsWith('MIC')) return 'mic'
  if (n.startsWith('LED')) return 'led'
  if (/^[RC]\d/.test(n)) return 'passive'
  if (/^J\d/.test(n)) return 'connector'
  return 'chip'
}

/**
 * 取第一块 pcb_board;无则抛 hw:noBoard。
 *
 * centerX/centerY 为**有效板心**(BoardSpec/ScreenPlacement 统一的归一化基准):
 * tscircuit 对带 outline 的板仍报 center=(0,0),而 outline 原始坐标可以不对称
 * (bbox 中心 ≠ center)—— 此时若按 center 归一化,板体在组内偏心,而外壳/顶盖
 * 开窗均围绕原点构建,屏幕与元件整体错位(实测复现,见 /tmp/hw-screen-check.mts)。
 * 故 outline 存在时以 outline bbox 中心为有效板心,元件/屏幕减同一基准。
 */
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
  let centerX = board.center?.x ?? 0
  let centerY = board.center?.y ?? 0
  let widthMM = Number(board.width) || 0
  let heightMM = Number(board.height) || 0
  let outline: { x: number; y: number }[] | undefined
  if (Array.isArray(board.outline) && board.outline.length >= 3) {
    // 有效板心 = 原始 outline bbox 中心(非 board.center,见函数头)
    const rxs = board.outline.map((p) => p.x)
    const rys = board.outline.map((p) => p.y)
    centerX = (Math.min(...rxs) + Math.max(...rxs)) / 2
    centerY = (Math.min(...rys) + Math.max(...rys)) / 2
    widthMM = Math.max(...rxs) - Math.min(...rxs)
    heightMM = Math.max(...rys) - Math.min(...rys)
    // 归一化:有效板心移到原点(outline bbox 对称于原点)
    outline = board.outline.map((p) => ({ x: p.x - centerX, y: p.y - centerY }))
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

  // smtpad 数按 pcb_component 聚合:kind 推断的 module 判据(≥40 焊盘)
  const padCount = new Map<string, number>()
  for (const pad of db.pcb_smtpad.list()) {
    if (!pad.pcb_component_id) continue
    padCount.set(pad.pcb_component_id, (padCount.get(pad.pcb_component_id) ?? 0) + 1)
  }

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
      layer: pc.layer === 'bottom' ? 'bottom' : 'top',
      kind: inferComponentKind(src?.name, padCount.get(pc.pcb_component_id) ?? 0)
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
 * 第一个 pcb_component,用其外形做屏幕可视区。无则返回 null。
 *
 * 坐标与 buildBoardSpec 共用 firstBoard 的**有效板心**归一化(outline 板取 bbox 中心),
 * 保证屏幕面与元件盒/外壳开窗落在同一坐标系;w/h 为板面 AABB(tscircuit 实测:
 * pcb_component.width/height 已含旋转),rotationDeg 仅指示贴图朝向。
 */
export function detectScreenPlacement(circuitJson: AnyCircuitElement[]): ScreenPlacement | null {
  const db = su(circuitJson)
  let board: ReturnType<typeof firstBoard>
  try {
    board = firstBoard(db)
  } catch {
    return null // 无板/板尺寸无效:视为无屏幕(buildBoardSpec 会另行抛错)
  }
  for (const pc of db.pcb_component.list()) {
    const src = db.source_component.get(pc.source_component_id)
    if (!src || !SCREEN_NAME_RE.test(src.name)) continue
    const w = Number(pc.width) || 0
    const h = Number(pc.height) || 0
    if (w <= 0 || h <= 0) continue
    return {
      x: pc.center.x - board.centerX,
      y: pc.center.y - board.centerY,
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

// ------------------------------------------------------------------
// 元件形状工厂(C3):按 kind 生成低多边形写实外形(全部参数化到 w/d/h)
// ------------------------------------------------------------------

/** 元件 3D 调色板(muted;所有形状工厂共用,禁止散落魔法色值) */
const COMP_PALETTE = {
  /** 塑封体深灰(原元件盒色) */
  body: '#2b3138',
  /** 连接器/浅色塑体 */
  bodyLight: '#454c55',
  /** 金属屏蔽罩/USB 壳(银) */
  metal: '#b8bfc6',
  /** 金属托盘(SD 卡座,略暗) */
  metalDark: '#99a0a8',
  /** 引脚/贴片端帽 */
  pin: '#ccd1d7',
  /** 模组基板绿(比板体略深) */
  substrate: '#12592b',
  /** 天线区底色(近黑) */
  antenna: '#171c22',
  /** 按键帽浅灰 */
  actuator: '#d6d9dd',
  /** LED 半球(暖白,自发光) */
  led: '#ffd27f',
  /** USB 口内腔/SD 插槽/麦克风孔(近黑) */
  dark: '#101318',
  /** pin1 标记点(淡金) */
  pin1: '#d9b25a'
} as const

/** 形状工厂共享材质组(每次 buildBoardGroup 建一份;dispose 由 viewer 遍历完成,重复 dispose 无害) */
interface ComponentMaterials {
  body: THREE.MeshStandardMaterial
  bodyLight: THREE.MeshStandardMaterial
  metal: THREE.MeshStandardMaterial
  metalDark: THREE.MeshStandardMaterial
  pin: THREE.MeshStandardMaterial
  substrate: THREE.MeshStandardMaterial
  antenna: THREE.MeshStandardMaterial
  actuator: THREE.MeshStandardMaterial
  led: THREE.MeshStandardMaterial
  dark: THREE.MeshStandardMaterial
  pin1: THREE.MeshStandardMaterial
}

function createComponentMaterials(): ComponentMaterials {
  const std = (color: string, roughness: number, metalness: number): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness })
  const led = new THREE.MeshStandardMaterial({
    color: COMP_PALETTE.led,
    emissive: COMP_PALETTE.led,
    emissiveIntensity: 0.55,
    roughness: 0.3,
    metalness: 0,
    transparent: true,
    opacity: 0.8
  })
  return {
    body: std(COMP_PALETTE.body, 0.7, 0.25),
    bodyLight: std(COMP_PALETTE.bodyLight, 0.75, 0.1),
    metal: std(COMP_PALETTE.metal, 0.4, 0.85),
    metalDark: std(COMP_PALETTE.metalDark, 0.45, 0.8),
    pin: std(COMP_PALETTE.pin, 0.35, 0.9),
    substrate: std(COMP_PALETTE.substrate, 0.6, 0.1),
    antenna: std(COMP_PALETTE.antenna, 0.8, 0.1),
    actuator: std(COMP_PALETTE.actuator, 0.5, 0.1),
    led,
    dark: std(COMP_PALETTE.dark, 0.9, 0),
    pin1: std(COMP_PALETTE.pin1, 0.5, 0.4)
  }
}

/** 圆角平面矩形挤出体:plan w×d,向上挤出 h,几何 y∈[0,h](plan 北 → -z) */
function roundedSlabGeo(w: number, d: number, h: number, r: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape()
  traceRoundedRect(shape, 0, 0, w, d, r)
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 5 })
  geo.rotateX(-Math.PI / 2) // 挤出 +z → +y,plan y → -z
  return geo
}

/** 圆角截面挤出体(USB 壳):截面 w×h(y∈[0,h]),沿插拔轴 z 挤出 depth(z 居中) */
function roundedShellGeo(w: number, h: number, depth: number, r: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape()
  traceRoundedRect(shape, 0, h / 2, w, h, r)
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 5 })
  geo.translate(0, 0, -depth / 2)
  return geo
}

/**
 * ESP32 模组:基板(绿)+ 金属屏蔽罩(圆角,盖住 ~70%)+ 北端天线区(深色薄层
 * + 金属蛇形条纹)。屏蔽罩烘焙 userData.subExplode —— HardwareViewer 爆炸时
 * 罩体沿局部 +Y 抬离基板(封装内部也炸开),基板/天线留在原位。
 */
function buildModuleShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const subT = Math.min(1, h * 0.4)
  const substrate = new THREE.Mesh(new THREE.BoxGeometry(w, subT, d), m.substrate)
  substrate.name = 'substrate'
  substrate.position.y = subT / 2
  g.add(substrate)

  // 天线区:北端(-z)深色薄层 + 3 条金属蛇形走线条纹
  const antD = d * 0.24
  const antenna = new THREE.Group()
  antenna.name = 'antenna'
  const antBase = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.22, antD), m.antenna)
  antBase.position.set(0, subT + 0.11, -(d / 2 - antD / 2))
  antenna.add(antBase)
  for (let i = 0; i < 3; i++) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.08, antD * 0.14), m.pin)
    stripe.position.set(0, subT + 0.26, -(d / 2 - antD * (0.22 + i * 0.28)))
    antenna.add(stripe)
  }
  g.add(antenna)

  // 屏蔽罩:圆角金属盒,盖住天线区之外的基板(~70% 进深)
  const gap = 0.3
  const shield = new THREE.Mesh(
    roundedSlabGeo(w * 0.94, d - antD - gap, Math.max(h - subT, 0.8), Math.min(0.9, w * 0.1)),
    m.metal
  )
  shield.name = 'shield'
  shield.position.set(0, subT, (antD + gap) / 2)
  shield.userData.subExplode = {
    home: shield.position.clone(),
    dir: new THREE.Vector3(0, 1, 0),
    dist: MODULE_SHIELD_EXPLODE_MM
  }
  g.add(shield)
  return g
}

/** USB-C:银色圆角金属壳(截面近胶囊)+ 外侧面(+z)凹陷的深色椭圆插口 */
function buildUsbShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const shell = new THREE.Mesh(roundedShellGeo(w, h, d, Math.min(h * 0.42, w * 0.3)), m.metal)
  shell.name = 'shell'
  g.add(shell)
  const mouth = new THREE.Mesh(roundedShellGeo(w * 0.72, h * 0.5, 0.16, h * 0.22), m.dark)
  mouth.position.set(0, h * 0.25, d / 2) // 微凸出壳面 0.08,读作插口
  g.add(mouth)
  return g
}

/** 轻触按键:深灰底座 + 圆柱触动帽(浅灰) */
function buildButtonShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const baseH = h * 0.45
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, baseH, d), m.body)
  base.position.y = baseH / 2
  g.add(base)
  const capR = Math.min(w, d) * 0.32
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(capR, capR, h - baseH, 20), m.actuator)
  cap.position.y = baseH + (h - baseH) / 2
  g.add(cap)
  return g
}

/** microSD 卡座:扁平金属托盘 + 外侧(+z)插卡口(深色开槽 + 上唇) */
function buildSdShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const trayH = Math.max(h * 0.55, 1)
  const tray = new THREE.Mesh(new THREE.BoxGeometry(w, trayH, d), m.metalDark)
  tray.position.y = trayH / 2
  g.add(tray)
  const slot = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, trayH * 0.45, 0.4), m.dark)
  slot.position.set(0, trayH * 0.35, d / 2 + 0.05)
  g.add(slot)
  const lip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, trayH * 0.22, 0.5), m.metalDark)
  lip.position.set(0, trayH * 0.78, d / 2 + 0.1)
  g.add(lip)
  return g
}

/** MEMS 麦克风:小盒体 + 顶面中心 Φ0.4 拾音孔(深色小圆柱) */
function buildMicShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const bodyH = h * 0.7
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyH, d), m.body)
  body.position.y = bodyH / 2
  g.add(body)
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12), m.dark)
  hole.position.y = bodyH + 0.05
  g.add(hole)
  return g
}

/** LED:浅色基片 + 半透明自发光半球罩 */
function buildLedShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const baseH = Math.min(0.3, h * 0.2)
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, baseH, d), m.bodyLight)
  base.position.y = baseH / 2
  g.add(base)
  const r = Math.min(Math.min(w, d) * 0.45, h - baseH)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.led)
  dome.position.y = baseH
  g.add(dome)
  return g
}

/** 贴片电阻/电容:深色本体 + 两端金属端帽(沿长轴),高度压到贴片量级 */
function buildPassiveShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const alongX = w >= d
  const len = Math.max(w, d)
  const across = Math.min(w, d)
  const bodyH = Math.min(h, Math.max(across * 0.9, 0.3))
  const capL = len * 0.22
  const dims = (l: number): [number, number, number] =>
    alongX ? [l, bodyH, across] : [across, bodyH, l]
  const body = new THREE.Mesh(new THREE.BoxGeometry(...dims(len * 0.6)), m.body)
  body.position.y = bodyH / 2
  g.add(body)
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(...dims(capL)), m.pin)
    cap.position.y = bodyH / 2
    if (alongX) cap.position.x = s * (len / 2 - capL / 2)
    else cap.position.z = s * (len / 2 - capL / 2)
    g.add(cap)
  }
  return g
}

/** 连接器:塑体偏后(-z)+ 前侧一排金属小引脚 */
function buildConnectorShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const bodyH = h * 0.75
  const bodyD = d * 0.68
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyH, bodyD), m.bodyLight)
  body.position.set(0, bodyH / 2, -(d / 2 - bodyD / 2))
  g.add(body)
  const pinN = Math.max(2, Math.min(8, Math.round(w / 1.2)))
  const pinH = Math.min(bodyH * 0.6, 1)
  for (let i = 0; i < pinN; i++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.3, pinH, 0.3), m.pin)
    pin.position.set(-w * 0.35 + (w * 0.7 * i) / (pinN - 1), pinH / 2, d / 2 - d * 0.16)
    g.add(pin)
  }
  return g
}

/** 默认芯片:深灰塑封盒 + 顶面西北角 pin1 标记点 */
function buildChipShape(w: number, d: number, h: number, m: ComponentMaterials): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m.body)
  body.position.y = h / 2
  g.add(body)
  const dotR = THREE.MathUtils.clamp(Math.min(w, d) * 0.08, 0.12, 0.3)
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(dotR, dotR, 0.06, 10), m.pin1)
  dot.position.set(-w / 2 + dotR * 2, h + 0.03, -d / 2 + dotR * 2)
  g.add(dot)
  return g
}

/**
 * 形状工厂分发:局部系约定 —— 元件坐在 y=0 平面、向 +y 生长,plan 北 = -z;
 * 有"开口方向"的类别(usb/sd/connector)开口面朝局部 +z,由调用方 yaw 对准板边。
 * 三角量级:全部为盒体/低分段圆柱/低分段圆角挤出,单元件 « 2k 三角。
 */
function buildComponentShape(
  kind: ComponentKind,
  w: number,
  d: number,
  h: number,
  m: ComponentMaterials
): THREE.Group {
  switch (kind) {
    case 'module':
      return buildModuleShape(w, d, h, m)
    case 'usb':
      return buildUsbShape(w, d, h, m)
    case 'button':
      return buildButtonShape(w, d, h, m)
    case 'sd':
      return buildSdShape(w, d, h, m)
    case 'mic':
      return buildMicShape(w, d, h, m)
    case 'led':
      return buildLedShape(w, d, h, m)
    case 'passive':
      return buildPassiveShape(w, d, h, m)
    case 'connector':
      return buildConnectorShape(w, d, h, m)
    default:
      return buildChipShape(w, d, h, m)
  }
}

/** 开口需朝最近板边的元件类别(USB 插口/SD 卡槽/连接器引出方向) */
const OUTWARD_KINDS = new Set<ComponentKind>(['usb', 'sd', 'connector'])

/**
 * 构建板卡 THREE.Group(name:'board'):
 *   - 板体:outline 多边形或圆角矩形,ExtrudeGeometry 挤出板厚
 *   - 元件:形状工厂按 kind 生成写实外形(见 buildComponentShape);
 *     顶层坐在板顶面上,底层元件组绕 X 翻转 180°(局部 +y → 世界 -y)挂在板底面下,
 *     故形状内烘焙的 subExplode 方向(局部 +Y)天然指向"离板"一侧
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

  // ---- 元件(形状工厂,共享材质组) ----
  const mats = createComponentMaterials()
  for (const c of spec.components) {
    const hMM = c.heightMM > 0 ? c.heightMM : DEFAULT_COMPONENT_HEIGHT_MM
    const w = Math.max(c.w, 0.2)
    const d = Math.max(c.h, 0.2)
    const kind = c.kind ?? 'chip'
    const flipped = c.layer === 'bottom'

    // 开口朝向:usb/sd/connector 朝最近板边(外向量圆整到 ±x/±z 主轴)。
    // tscircuit 的 w/h 已是含旋转的板面 AABB,±90° yaw 时建模宽/深互换,
    // 保证世界 AABB 仍与封装 courtyard 一致
    let yaw = 0
    let bw = w
    let bd = d
    if (OUTWARD_KINDS.has(kind)) {
      const rx = spec.widthMM > 0 ? c.x / (spec.widthMM / 2) : 0
      const ry = spec.heightMM > 0 ? c.y / (spec.heightMM / 2) : 0
      let ox = 0
      let oz = 0
      if (Math.abs(rx) >= Math.abs(ry)) ox = Math.sign(rx) || 1
      else oz = -(Math.sign(ry) || 1) // circuit +y → three -z
      // 底面元件组绕 X 翻转后局部 z 反号:外向量先换到翻转局部系再求 yaw
      const lz = flipped ? -oz : oz
      yaw = Math.atan2(ox, lz)
      if (Math.abs(Math.round(yaw / (Math.PI / 2))) % 2 === 1) {
        bw = d
        bd = w
      }
    }

    const shapeGroup = buildComponentShape(kind, bw, bd, hMM, mats)
    shapeGroup.rotation.y = yaw

    const comp = new THREE.Group()
    comp.name = c.name ?? c.id
    comp.add(shapeGroup)
    if (flipped) {
      comp.rotation.x = Math.PI // 翻面朝下:局部 +y → 世界 -y,局部 +z → 世界 -z
      comp.position.set(c.x, -t, -c.y)
    } else {
      comp.position.set(c.x, 0, -c.y)
    }
    group.add(comp)
  }
  return group
}
