/**
 * HardwareViewer —— 命令式 three.js 硬件查看器(hardware 面板与 Sim 3D 共用)
 *
 * 职责(docs/plans/ide-v3-project-types.md §2.4):
 *   - WebGLRenderer + PerspectiveCamera + OrbitControls(enableDamping)+ 三点布光 + 淡网格地面
 *   - setHardware:重建 board/base/lid(+ 可选 display 显示模组 / battery 电池占位)部件组,
 *     userData.explode 存 { home: 合拢位置, dir: 单位方向, dist: 距离 };
 *     爆炸阅读顺序:lid 最高 +Y、display 其下(0.55×lid)、board 原位、battery 小幅 -Y、base -Y 最低
 *   - setExplode:THREE.MathUtils.damp 在 rAF 里把爆炸标量逼近目标(帧率无关、可中途反转);
 *     除部件级位移外,携带 userData.subExplode 的子网格(如 ESP32 模组屏蔽罩,
 *     boardBuilder 形状工厂烘焙)随同一因子在父组局部系抬离 —— 封装内部也炸开
 *   - attachScreenCanvas:CanvasTexture 贴到显示模组顶面(实物堆叠:屏幕贴顶盖窗口;
 *     无顶盖开窗时回退板顶薄面);markScreenDirty 脏标记驱动纹理上传
 *   - onScreenTouch:对屏幕面做指针 raycast,回调 UV(u∈[0,1] 左→右,v∈[0,1] 顶→底);
 *     rotationDeg 通过旋转屏幕网格本身实现,UV 空间随之旋转,无需二次换算
 *   - exportSTL:在克隆体上导出(不动活跃场景/爆炸态)→ 归零爆炸 → 绕 X +90°
 *     (three Y-up → 切片器 Z-up)→ 单部件落床(minZ=0)并 XY 居中 → STLExporter binary
 *     (display/battery 为**非打印部件**,'assembly' 导出时从克隆体剔除;
 *     屏幕贴片挂 display 组内亦随之剔除,无 display 时挂 scene 天然不导出)
 *   - setEnclosureEditMode:「编辑外壳」交互 —— 在场景上叠加可拖拽手柄
 *     (enclosureGizmos;挂 scene 而非 root:不随爆炸位移、不进 STL 导出),
 *     pointerdown 命中手柄 → 暂停 OrbitControls → 指针 raycast 到约束平面、
 *     位移投影到手柄轴 → computeDragPatch(快照+累计位移,**本地权威**,
 *     store 回声不参与拖拽计算)→ onPatch 按 rAF 节流(≥33ms 合并冲刷,
 *     pointerup 立即冲刷末次);setHardware 重建后手柄组随当前参数再生。
 *     编辑模式期间屏幕触摸(onScreenTouch)整体挂起,未命中手柄时仍可轨道旋转。
 *
 * 渲染循环选择:**常开 rAF**(简单可靠;controls 阻尼、爆炸动画、贴图更新统一驱动),
 * 页面隐藏时浏览器本身暂停 rAF,循环内再加 visibilityState 守卫兜底;dispose 取消。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { buildBoardGroup } from './boardBuilder'
import { buildEnclosure } from './enclosureBuilder'
import {
  ENCLOSURE_HANDLE_COLOR,
  ENCLOSURE_HANDLE_HOVER_COLOR,
  buildHandleGroup,
  computeDragPatch,
  deriveEnclosureDims,
  formatHandleReadout,
  listHandleSpecs,
  type EnclosureHandleSpec
} from './enclosureGizmos'
import type { EnclosureParams, Hardware3D, ScreenPlacement, ExplodeTarget, HardwarePartId } from '../types'
import {
  createAxesOverlay,
  AXES_VIEWPORT_SIZE,
  AXES_VIEWPORT_PAD,
  AXES_ORIGIN,
  type AxesOverlay
} from './axesOverlay'
import { buildScadEnclosureParts } from './enclosureStl'

export interface HardwareViewerOptions {
  /** OrbitControls,默认 true */
  interactive?: boolean
  /** 背景色;null = 透明,默认 null */
  background?: string | null
  /** 屏幕面 raycast UV(0..1;v=0 为屏幕顶) */
  onScreenTouch?: (type: 'down' | 'move' | 'up', u: number, v: number) => void
  /** 左下角坐标轴指示器初值(settings appearance.show3dAxes;默认 false,离屏导出/冒烟不受影响) */
  axes?: boolean
}

/** 部件爆炸元数据(存于 Group.userData.explode) */
interface ExplodeMeta {
  home: THREE.Vector3
  dir: THREE.Vector3
  dist: number
}

/**
 * 封装内部爆炸元数据(存于子网格 userData.subExplode,由 boardBuilder 形状工厂
 * 烘焙 —— 如 ESP32 模组屏蔽罩):爆炸时子网格在**父组局部系**沿 dir 抬离 home,
 * 底面元件的组已绕 X 翻转,局部 +Y 天然指向"离板"一侧,无需方向换算。
 */
interface SubExplodeMeta {
  home: THREE.Vector3
  dir: THREE.Vector3
  dist: number
}

/** 屏幕贴片抬离板顶面的高度 mm(无顶盖开窗的回退路径;元件盒高 2.5 之上再抬 0.1 防 z-fighting) */
const SCREEN_LIFT_MM = 2.6
/** 屏幕贴片抬离显示模组顶面的高度 mm(防 z-fighting) */
const SCREEN_FACE_LIFT_MM = 0.05
/** 未 setHardware 时屏幕贴片的板顶面兜底高度(默认壁厚 2 + 支撑柱高 4) */
const DEFAULT_BOARD_TOP_Y = 6
/** 电池占位爆炸下移距离 mm(小幅:阅读顺序介于原位的板与下移的底盒之间) */
const BATTERY_EXPLODE_MM = 6
/** 非打印部件(成品显示模组/锂电池,不进入 STL 装配导出,亦无单件导出 id) */
const NON_PRINTABLE_PARTS = new Set(['display', 'battery'])
/** 爆炸动画阻尼系数(damp 的 lambda,越大越快) */
const EXPLODE_DAMP_LAMBDA = 7
/** 爆炸标量收敛阈值 */
const EXPLODE_EPS = 0.0005
/** 拖拽 onPatch 节流最小间隔 ms(rAF 循环内冲刷,≈30Hz;几何重建为棱柱级,足够实时) */
const PATCH_MIN_INTERVAL_MS = 33

/** 外壳手柄拖拽会话(pointerdown 建立,pointerup/取消销毁) */
interface GizmoDragState {
  spec: EnclosureHandleSpec
  /** 拖拽约束平面(过手柄;墙面手柄 = 墙面,轴向手柄 = 含轴且最面向相机) */
  plane: THREE.Plane
  /** pointerdown 时指针与平面的交点(位移基准) */
  start: THREE.Vector3
  /** pointerdown 时的外壳参数快照(拖拽全程以快照+累计位移计算 → 防 store 回声反馈环) */
  startParams: EnclosureParams
  /** 本地权威参数(快照+最新补丁;重建/读数/手柄布局以此为准,直至 pointerup) */
  localParams: EnclosureParams
}

/** 释放对象树上的几何与材质(不含纹理 —— 屏幕纹理单独管理) */
function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose()
      const mats = Array.isArray(node.material) ? node.material : [node.material]
      for (const m of mats) m.dispose()
    }
  })
}

export class HardwareViewer {
  private readonly canvas: HTMLCanvasElement
  private readonly opts: HardwareViewerOptions
  private readonly interactive: boolean
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls | null
  /** 部件根组(name:'assembly',含 board/base/lid + 可选 display/battery) */
  private readonly root: THREE.Group
  private readonly grid: THREE.GridHelper
  private readonly exporter = new STLExporter()
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointerNdc = new THREE.Vector2()

  private hardware: Hardware3D | null = null
  private explodeTarget: ExplodeTarget = 0
  private explodeFactor = 0
  private framedRadius = 0

  private screenMesh: THREE.Mesh | null = null
  private screenTexture: THREE.CanvasTexture | null = null
  private screenPlacement: ScreenPlacement | null = null
  /** 前置显示模组(有顶盖屏幕窗时;屏幕贴片挂其内,爆炸随之抬升) */
  private displayPart: THREE.Group | null = null
  /** 显示模组顶面世界高度(= 顶盖外表面 − 微沉;displayPart 存在时有效) */
  private displayFaceY = 0
  private screenDirty = false
  /** 屏幕电源/亮度(Sim 3D 随 engine.uiStore;硬件面板预览恒为开/1) */
  private screenPower = true
  private screenBrightness = 1
  private touchActive = false
  private lastTouch: { u: number; v: number } | null = null

  // ---- 编辑外壳(手柄 gizmo)状态 ----
  private editMode = false
  private onPatchCb: ((patch: Partial<EnclosureParams>) => void) | null = null
  /** 手柄网格组(挂 scene:不随爆炸、不进 STL;编辑模式关闭时为 null) */
  private handleGroup: THREE.Group | null = null
  private hoverHandle: THREE.Mesh | null = null
  private gizmoDrag: GizmoDragState | null = null
  /** 待冲刷补丁(rAF 节流合并:只保留最新) */
  private pendingPatch: Partial<EnclosureParams> | null = null
  private lastPatchAt = 0
  /** 拖拽数值读数悬浮框(挂 canvas 父容器;懒创建) */
  private readoutEl: HTMLDivElement | null = null

  // ---- 左下角坐标轴指示器(第二渲染 pass,独立小场景;settings 可开关) ----
  private axesVisible = false
  private axesOverlay: AxesOverlay | null = null
  /** tick 内取渲染尺寸的临时向量(避免每帧分配) */
  private readonly tmpSize = new THREE.Vector2()

  private rafId = 0
  private lastTime = 0
  private disposed = false

  constructor(canvas: HTMLCanvasElement, opts: HardwareViewerOptions = {}) {
    this.canvas = canvas
    this.opts = opts
    this.interactive = opts.interactive !== false

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.scene = new THREE.Scene()
    const bg = opts.background ?? null
    if (bg) this.scene.background = new THREE.Color(bg)
    else this.renderer.setClearColor(0x000000, 0)

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 3000)
    this.camera.position.set(90, 85, 110)

    this.root = new THREE.Group()
    this.root.name = 'assembly'
    this.scene.add(this.root)

    // 三点布光:环境 + 主光 + 补光
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(60, 100, 80)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.8)
    fill.position.set(-70, 40, -60)
    this.scene.add(fill)

    // 淡网格地面(y=0)
    this.grid = new THREE.GridHelper(240, 24, 0x8a8f98, 0x8a8f98)
    const gridMat = this.grid.material as THREE.Material
    gridMat.transparent = true
    gridMat.opacity = 0.12
    gridMat.depthWrite = false
    this.scene.add(this.grid)

    if (this.interactive) {
      this.controls = new OrbitControls(this.camera, canvas)
      this.controls.enableDamping = true
      this.controls.dampingFactor = 0.08
      this.controls.minDistance = 5
      this.controls.maxDistance = 2000
    } else {
      this.controls = null
    }

    if (opts.axes) this.setAxesVisible(true)

    // 指针监听常驻:屏幕触摸(onScreenTouch)与外壳编辑手柄共用同一组入口,
    // 各自在处理器内部按模式分流(编辑模式优先且屏蔽屏幕触摸)
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerup', this.handlePointerUp)
    canvas.addEventListener('pointercancel', this.handlePointerUp)

    this.resize()
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  /** 重建 board/base/lid(+ display/battery)部件组 + 爆炸向量;多次调用会释放旧几何 */
  setHardware(hw: Hardware3D): void {
    this.hardware = hw
    this.clearParts() // 内部先把屏幕贴片撤回 scene,已 attach 的纹理在重建后原样复用

    const enc = hw.enclosure
    // 契约:板顶面世界高度。scad 外壳优先取 PB_META(用户改了 .scad 里的
    // standoff/wall 后参数化数值已失真);旧参数化档案回退推导,再兜底默认
    const boardTopY =
      hw.scad?.meta?.boardTopZ ??
      (enc ? enc.wallMM + enc.standoffHeightMM : DEFAULT_BOARD_TOP_Y)

    const board = buildBoardGroup(hw.board) // 组局部:板顶面 y=0
    board.userData.explode = {
      home: new THREE.Vector3(0, boardTopY, 0),
      dir: new THREE.Vector3(0, 1, 0),
      dist: 0 // 板原位不动
    } satisfies ExplodeMeta

    // 外壳几何:scad 编译产物(STL)优先;否则参数化构建。display/battery 为成品
    // 部件(非打印),scad 路径下分别由 meta+屏幕放置 / 参数化电池占位补齐
    let base: THREE.Group
    let lid: THREE.Group
    let display: THREE.Group | null
    let battery: THREE.Group | null
    let baseDist: number
    let lidDist: number
    if (hw.scad) {
      // 电池占位随 PB_META(scad 侧钳制),不再依赖参数化字段
      const parts = buildScadEnclosureParts(hw.scad, hw.screen ?? null)
      base = parts.base
      lid = parts.lid
      display = parts.display
      battery = parts.battery
      // 爆炸距离:优先 meta 尺寸,退化为部件包围盒高度
      const baseTop = hw.scad.meta?.baseTopZ ?? new THREE.Box3().setFromObject(base).max.y
      const lidTop = hw.scad.meta?.lidTopZ ?? new THREE.Box3().setFromObject(lid).max.y
      baseDist = baseTop + 12
      lidDist = Math.max(lidTop - baseTop, 2) + 20
    } else if (enc) {
      const parts = buildEnclosure(hw.board, enc, hw.screen ?? null)
      base = parts.base
      lid = parts.lid
      display = parts.display
      battery = parts.battery
      baseDist = enc.wallMM + enc.baseHeightMM + 12
      lidDist = enc.lidHeightMM + enc.wallMM + 20
    } else {
      // 无外壳数据(理论态:极旧档案损坏):只放板卡
      base = new THREE.Group()
      base.name = 'base'
      lid = new THREE.Group()
      lid.name = 'lid'
      display = null
      battery = null
      baseDist = 12
      lidDist = 20
    }
    base.userData.explode = {
      home: new THREE.Vector3(0, 0, 0),
      dir: new THREE.Vector3(0, -1, 0),
      dist: baseDist
    } satisfies ExplodeMeta
    lid.userData.explode = {
      home: new THREE.Vector3(0, 0, 0),
      dir: new THREE.Vector3(0, 1, 0),
      dist: lidDist
    } satisfies ExplodeMeta

    this.root.add(board, base, lid)

    if (display) {
      // 显示模组随爆炸抬到顶盖之下(0.55×lid),堆叠阅读:lid > display > board
      display.userData.explode = {
        home: new THREE.Vector3(0, 0, 0),
        dir: new THREE.Vector3(0, 1, 0),
        dist: lidDist * 0.55
      } satisfies ExplodeMeta
      this.displayPart = display
      this.displayFaceY = (display.userData.dims as { screenFaceY: number }).screenFaceY
      this.root.add(display)
    }
    if (battery) {
      battery.userData.explode = {
        home: new THREE.Vector3(0, 0, 0),
        dir: new THREE.Vector3(0, -1, 0),
        dist: BATTERY_EXPLODE_MM
      } satisfies ExplodeMeta
      this.root.add(battery)
    }

    this.applyExplode()
    this.updateScreenTransform() // 已 attach 的贴片重新挂到新 display 组(或回退板顶)
    this.frameIfNeeded()
    // 重建会清空部件组:编辑模式下按当前参数再生手柄(拖拽中以本地权威参数布局,
    // 迟到的 store 回声不会把手柄拽回旧位置)
    this.rebuildGizmos()
  }

  /** 爆炸视图目标(damp 动画,可中途反转) */
  setExplode(target: ExplodeTarget): void {
    this.explodeTarget = target
  }

  getExplode(): ExplodeTarget {
    return this.explodeTarget
  }

  /**
   * 把模拟器屏幕画布贴到屏幕面。src=null 时移除。
   * 有前置显示模组时贴片挂 display 组内(顶面微抬 0.05,爆炸随模组抬升;
   * STL 装配导出剔除 display 时一并排除);无顶盖开窗时回退挂 scene 的板顶薄面。
   */
  attachScreenCanvas(src: HTMLCanvasElement | null, placement: ScreenPlacement): void {
    this.removeScreenMesh()
    this.screenPlacement = placement
    if (!src) return

    const tex = new THREE.CanvasTexture(src)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    // flipY 默认 true:rotateX(-90°) 后平面局部 +y 指向世界 -Z(板"北"),画布首行朝北,方向正确

    // placement.w/h 是板面 AABB(tscircuit 的 pcb_component.width/height 已含旋转,
    // 顶盖开窗同样直接用 AABB)——几何需先还原为未旋转尺寸,再由 rotation.y 转回:
    // 90/270 时直接建 w×h 平面再旋转会二次旋转,可视区横竖颠倒且与开窗错位
    const rot = placement.rotationDeg ?? 0
    const geoW = rot % 180 === 0 ? placement.w : placement.h
    const geoH = rot % 180 === 0 ? placement.h : placement.w
    const geo = new THREE.PlaneGeometry(geoW, geoH)
    geo.rotateX(-Math.PI / 2) // 面朝 +Y
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'screen'

    this.screenMesh = mesh
    this.screenTexture = tex
    this.scene.add(mesh)
    this.updateScreenTransform()
    this.applyScreenState()
    this.screenDirty = true
  }

  /** 新帧到达时由外部调用;下一次渲染前置 texture.needsUpdate(每帧只上传一次) */
  markScreenDirty(): void {
    this.screenDirty = true
  }

  /**
   * 调试探针:屏幕贴片世界坐标中心(冒烟断言用)。
   * 契约:有前置显示模组时 = (placement.x, 顶盖外表面−微沉+贴片微抬, -placement.y)
   * (屏幕装在壳体最外侧,回归防线:埋底缺陷);无顶盖开窗时回退
   * (placement.x, 板顶面+抬离量, -placement.y);未挂贴片时 null。
   */
  getScreenWorldCenter(): { x: number; y: number; z: number } | null {
    if (!this.screenMesh) return null
    const p = this.screenMesh.getWorldPosition(new THREE.Vector3())
    return { x: p.x, y: p.y, z: p.z }
  }

  /** 调试探针:装配体部件名列表(冒烟断言 display/battery 部件存在性) */
  getPartNames(): string[] {
    return this.root.children.map((c) => c.name)
  }

  /**
   * 调试探针:模组封装内部爆炸间距(冒烟断言用)。取第一个携带
   * userData.subExplode 的子网格(模组屏蔽罩)与其同组基板(name 'substrate'),
   * 返回二者世界位置沿"离板方向"(父组局部 +Y 的世界向量;底面元件翻转后指向
   * 世界 -Y)的有符号间距 mm:合拢时 ≈ 罩底-板心固有差(< 2),
   * setExplode(1) 收敛后 ≈ 固有差 + MODULE_SHIELD_EXPLODE_MM(> 2)。
   * 场景无模组时 null。
   */
  getModuleExplodeDelta(): number | null {
    let delta: number | null = null
    this.root.traverse((node) => {
      if (delta !== null) return
      const sub = node.userData.subExplode as SubExplodeMeta | undefined
      const parent = node.parent
      if (!sub || !parent) return
      const substrate = parent.getObjectByName('substrate')
      if (!substrate) return
      const shieldPos = node.getWorldPosition(new THREE.Vector3())
      const basePos = substrate.getWorldPosition(new THREE.Vector3())
      const away = new THREE.Vector3(0, 1, 0).applyQuaternion(
        parent.getWorldQuaternion(new THREE.Quaternion())
      )
      delta = shieldPos.sub(basePos).dot(away)
    })
    return delta
  }

  /**
   * 屏幕电源/亮度 → 屏幕面材质(与 2D 的 CSS 熄屏遮罩/brightness filter 语义对齐):
   * 熄屏置黑(材质颜色 ×0,保留贴片形状),亮度(0..1)乘到材质颜色上。
   */
  setScreenState(power: boolean, brightness: number): void {
    this.screenPower = power
    this.screenBrightness = THREE.MathUtils.clamp(brightness, 0, 1)
    this.applyScreenState()
  }

  /**
   * 「编辑外壳」模式开关。开启后在场景上叠加可拖拽手柄
   * (顶盖高/板边间隙/底盒高/圆角 + 每个侧壁开孔的移动/尺寸手柄),
   * 拖拽产生的参数补丁经 onPatch 回调(rAF 节流 ≈30Hz,pointerup 冲刷末次);
   * 调用方(面板)负责把补丁写回 store,几何经 setHardware 实时重建。
   * 编辑模式期间屏幕触摸回调整体挂起(不产生幽灵触摸);与爆炸视图的互斥由面板保证。
   */
  setEnclosureEditMode(enabled: boolean, onPatch?: (patch: Partial<EnclosureParams>) => void): void {
    // 先结清进行中的拖拽(末次补丁走**旧**回调冲刷),再切换模式/回调
    this.finishGizmoDrag(null)
    this.editMode = enabled
    this.onPatchCb = enabled ? (onPatch ?? null) : null
    // 切换瞬间终止进行中的屏幕触摸,恢复控制器与光标
    this.touchActive = false
    if (this.controls) this.controls.enabled = this.interactive
    this.canvas.style.cursor = ''
    this.rebuildGizmos()
  }

  /** 调试探针:当前手柄数(冒烟断言用;编辑模式关闭或未 setHardware 时恒 0) */
  getEnclosureHandleCount(): number {
    return this.handleGroup?.children.length ?? 0
  }

  /**
   * 导出二进制 STL。'assembly' = 整个部件根组。在克隆体上操作(几何/材质共享引用,
   * 只改克隆的变换,活跃场景与爆炸态不受影响):
   *   1) 爆炸归零 —— 部件放回 explode.home 合拢位;
   *   2) 绕 X +90° —— three Y-up → 切片器 Z-up(Prusa/Cura/Bambu),板/底盒平躺打印床;
   *   3) 单部件再去装配偏移 —— 包围盒 min 落到 z=0(贴床)、XY 居中到原点
   *      (否则 lid 悬浮在装配高度、board 悬浮在 boardTopY);
   *   4) updateMatrixWorld(true) bake 后 STLExporter binary。
   * 返回独立 ArrayBuffer(按 DataView 的 byteOffset/byteLength 切片)。
   */
  exportSTL(part: HardwarePartId | 'assembly'): ArrayBuffer {
    const target = part === 'assembly' ? this.root : this.root.getObjectByName(part)
    if (!target || this.root.children.length === 0) throw new Error('hw:noHardware')

    const clone = target.clone(true)
    // 封装内部爆炸归零:克隆树上把 subExplode 子网格放回 home(元数据从**原始**
    // 树读 —— 克隆的 userData 经 JSON 克隆,Vector3 已退化;clone(true) 保持
    // 子节点顺序,可按下标平行遍历对位)。必须先于非打印部件剔除,否则下标错位
    const resetSubExplode = (orig: THREE.Object3D, cl: THREE.Object3D): void => {
      const sub = orig.userData.subExplode as SubExplodeMeta | undefined
      if (sub) cl.position.copy(sub.home)
      orig.children.forEach((oc, i) => resetSubExplode(oc, cl.children[i]))
    }
    resetSubExplode(target, clone)
    // 爆炸归零:从**原始**部件的 userData 读 home(clone 的 userData 经 JSON 克隆,
    // Vector3 已退化为普通对象;克隆保持子节点顺序,可按下标对位)
    if (part === 'assembly') {
      target.children.forEach((orig, i) => {
        const ex = orig.userData.explode as ExplodeMeta | undefined
        if (ex) clone.children[i].position.copy(ex.home)
      })
      // 非打印部件剔除:display(成品屏模组,含挂在其内的屏幕贴片克隆)与
      // battery(锂电池占位)不随外壳打印,不进入装配 STL
      for (const child of [...clone.children]) {
        if (NON_PRINTABLE_PARTS.has(child.name)) clone.remove(child)
      }
    } else {
      const ex = target.userData.explode as ExplodeMeta | undefined
      if (ex) clone.position.copy(ex.home)
    }

    const wrap = new THREE.Group()
    wrap.add(clone)
    wrap.rotation.x = Math.PI / 2 // Y-up → Z-up
    wrap.updateMatrixWorld(true)

    if (part !== 'assembly') {
      // 单部件:落床 + XY 居中(装配体本身底面即 y=0、XZ 居中,旋转后天然贴床)
      const box = new THREE.Box3().setFromObject(wrap)
      const center = box.getCenter(new THREE.Vector3())
      wrap.position.set(-center.x, -center.y, -box.min.z)
      wrap.updateMatrixWorld(true)
    }

    const dv = this.exporter.parse(wrap, { binary: true })
    return dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)
  }

  /** 按画布 CSS 尺寸 × devicePixelRatio 更新渲染尺寸与相机纵横比 */
  /** 左下角坐标轴指示器开关(settings appearance.show3dAxes;overlay 懒建,关闭仅停渲染) */
  setAxesVisible(visible: boolean): void {
    this.axesVisible = visible
    if (visible && !this.axesOverlay) this.axesOverlay = createAxesOverlay()
  }

  resize(): void {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w <= 0 || h <= 0) return
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** 释放渲染器/几何/材质/纹理/控制器,取消 rAF;幂等 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp)
    this.controls?.dispose()
    this.removeGizmos()
    this.readoutEl?.remove()
    this.readoutEl = null
    this.clearParts()
    this.removeScreenMesh()
    this.scene.remove(this.grid)
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()
    this.axesOverlay?.dispose()
    this.axesOverlay = null
    this.renderer.dispose()
    this.hardware = null
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  private readonly tick = (): void => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.tick)
    const now = performance.now()
    const dt = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now
    if (document.visibilityState === 'hidden') return

    this.controls?.update()

    if (Math.abs(this.explodeTarget - this.explodeFactor) > EXPLODE_EPS) {
      this.explodeFactor = THREE.MathUtils.damp(this.explodeFactor, this.explodeTarget, EXPLODE_DAMP_LAMBDA, dt)
      if (Math.abs(this.explodeTarget - this.explodeFactor) <= EXPLODE_EPS) {
        this.explodeFactor = this.explodeTarget
      }
      this.applyExplode()
    }

    if (this.screenDirty && this.screenTexture) {
      this.screenTexture.needsUpdate = true // 上传后由 three 自动清位
      this.screenDirty = false
    }

    // 手柄拖拽补丁节流:rAF 内合并冲刷(≥33ms ≈30Hz;pointerup 由 finishGizmoDrag 直冲)
    if (this.pendingPatch && this.onPatchCb && this.gizmoDrag && now - this.lastPatchAt >= PATCH_MIN_INTERVAL_MS) {
      const patch = this.pendingPatch
      this.pendingPatch = null
      this.lastPatchAt = now
      this.onPatchCb(patch)
    }

    this.renderer.render(this.scene, this.camera)

    // 左下角坐标轴指示器:第二 pass(朝向同步主相机;不清色只清深度,主画面保留)
    if (this.axesVisible && this.axesOverlay) {
      const size = this.renderer.getSize(this.tmpSize) // CSS 逻辑像素(setSize 同单位)
      const s = AXES_VIEWPORT_SIZE
      if (size.x > s + AXES_VIEWPORT_PAD * 2 && size.y > s + AXES_VIEWPORT_PAD * 2) {
        this.axesOverlay.syncTo(this.camera, this.controls?.target ?? AXES_ORIGIN)
        this.renderer.autoClear = false
        this.renderer.clearDepth()
        this.renderer.setViewport(AXES_VIEWPORT_PAD, AXES_VIEWPORT_PAD, s, s) // 视口原点在左下
        this.renderer.render(this.axesOverlay.scene, this.axesOverlay.camera)
        this.renderer.setViewport(0, 0, size.x, size.y)
        this.renderer.autoClear = true
      }
    }
  }

  /** 按当前爆炸标量摆放所有部件:position = home + dir × dist × factor */
  private applyExplode(): void {
    for (const part of this.root.children) {
      const ex = part.userData.explode as ExplodeMeta | undefined
      if (!ex) continue
      part.position.copy(ex.home).addScaledVector(ex.dir, ex.dist * this.explodeFactor)
    }
    // 封装内部爆炸:任何携带 userData.subExplode 的子网格随同一因子沿基向量
    // 抬离 home(形状工厂烘焙,如 ESP32 模组屏蔽罩 —— 封装也炸开露出基板)
    this.root.traverse((node) => {
      const sub = node.userData.subExplode as SubExplodeMeta | undefined
      if (sub) node.position.copy(sub.home).addScaledVector(sub.dir, sub.dist * this.explodeFactor)
    })
  }

  private clearParts(): void {
    // 屏幕贴片可能挂在 display 组内:先撤回 scene,防止随部件几何一并被 dispose
    // (setHardware 在 attachScreenCanvas 之后调用时,既有纹理/网格原样保留待重挂)
    if (this.screenMesh && this.screenMesh.parent !== this.scene) this.scene.add(this.screenMesh)
    this.displayPart = null
    this.displayFaceY = 0
    for (const child of [...this.root.children]) {
      this.root.remove(child)
      disposeObject3D(child)
    }
  }

  private removeScreenMesh(): void {
    if (this.screenMesh) {
      this.screenMesh.removeFromParent() // 可能挂 scene(回退)或 display 组(前置)
      this.screenMesh.geometry.dispose()
      ;(this.screenMesh.material as THREE.Material).dispose()
    }
    this.screenTexture?.dispose()
    this.screenMesh = null
    this.screenTexture = null
    this.screenDirty = false
    this.touchActive = false
    this.lastTouch = null
  }

  /** 把电源/亮度烙到屏幕面材质颜色(MeshBasicMaterial:color × map) */
  private applyScreenState(): void {
    if (!this.screenMesh) return
    const mat = this.screenMesh.material as THREE.MeshBasicMaterial
    mat.color.setScalar(this.screenPower ? this.screenBrightness : 0)
  }

  /**
   * 屏幕贴片位姿与挂点(rotationDeg 直接旋转网格,UV 随几何旋转,触摸无需换算):
   * - 有前置显示模组:挂 display 组内、贴模组顶面微抬(组 home 为原点,合拢时局部
   *   坐标即世界坐标;爆炸时贴片随模组抬升,与实物 FPC 连接的成品屏一致)
   * - 无顶盖开窗:回退挂 scene,板顶面 + 抬离量(设计态仍可预览屏幕内容)
   */
  private updateScreenTransform(): void {
    const p = this.screenPlacement
    if (!p || !this.screenMesh) return
    if (this.displayPart) {
      if (this.screenMesh.parent !== this.displayPart) this.displayPart.add(this.screenMesh)
      this.screenMesh.position.set(p.x, this.displayFaceY + SCREEN_FACE_LIFT_MM, -p.y)
    } else {
      if (this.screenMesh.parent !== this.scene) this.scene.add(this.screenMesh)
      const enc = this.hardware?.enclosure
      // 板顶面:scad meta 优先(同 setHardware 的契约取法),再参数推导,再兜底
      const topY =
        this.hardware?.scad?.meta?.boardTopZ ??
        (enc ? enc.wallMM + enc.standoffHeightMM : DEFAULT_BOARD_TOP_Y)
      this.screenMesh.position.set(p.x, topY + SCREEN_LIFT_MM, -p.y) // circuit (x,y) → three (x,-z)
    }
    this.screenMesh.rotation.y = THREE.MathUtils.degToRad(p.rotationDeg ?? 0)
  }

  /** 首次(或包围球变化 >50%)时取景:相机对准包围球中心并拉开合适距离 */
  private frameIfNeeded(): void {
    const box = new THREE.Box3().setFromObject(this.root)
    if (box.isEmpty()) return
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const r = Math.max(sphere.radius, 1)
    if (this.framedRadius > 0 && Math.abs(r - this.framedRadius) / this.framedRadius < 0.5) return
    this.framedRadius = r
    const dir = new THREE.Vector3(1, 0.85, 1).normalize()
    this.camera.position.copy(sphere.center).addScaledVector(dir, r * 2.7)
    this.camera.near = Math.max(r / 100, 0.1)
    this.camera.far = Math.max(r * 50, 500)
    this.camera.updateProjectionMatrix()
    if (this.controls) {
      this.controls.target.copy(sphere.center)
      this.controls.update()
    } else {
      this.camera.lookAt(sphere.center)
    }
  }

  /**
   * 指针 → NDC → 对整个装配体 + 屏幕面递归 raycast,**首个命中必须是屏幕面**
   * (遮挡测试:合拢的顶盖/侧壁挡住屏幕时点击不得穿透产生幽灵触摸);
   * 无屏幕贴片时恒不触发。返回 UV(v=0 为屏幕顶)。
   */
  private pickScreen(e: PointerEvent): { u: number; v: number } | null {
    if (!this.screenMesh) return null
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    this.pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(this.pointerNdc, this.camera)
    // 贴片挂 display 组内(root 之下)时 root 已覆盖;回退挂 scene 时需单独并入求交
    const targets: THREE.Object3D[] =
      this.screenMesh.parent === this.scene ? [this.root, this.screenMesh] : [this.root]
    const hit = this.raycaster.intersectObjects(targets, true)[0]
    if (!hit || hit.object !== this.screenMesh || !hit.uv) return null
    // PlaneGeometry v=1 一侧位于板"北"(屏幕顶);回调约定 v=0 为顶 → 取 1-uv.y
    return { u: hit.uv.x, v: 1 - hit.uv.y }
  }

  private readonly handlePointerDown = (e: PointerEvent): void => {
    if (this.editMode) {
      // 编辑模式:手柄命中优先于一切(未命中时交给 OrbitControls 旋转);
      // 屏幕触摸整体挂起 —— 编辑外壳时点击屏幕面不得产生幽灵触摸
      const mesh = this.pickHandle(e)
      if (mesh) this.beginGizmoDrag(mesh, e)
      return
    }
    const cb = this.opts.onScreenTouch
    if (!cb) return
    const hit = this.pickScreen(e)
    if (!hit) return
    this.touchActive = true
    this.lastTouch = hit
    if (this.controls) this.controls.enabled = false // 触摸屏幕期间暂停轨道旋转
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* 部分环境不支持指针捕获,忽略 */
    }
    cb('down', hit.u, hit.v)
  }

  private readonly handlePointerMove = (e: PointerEvent): void => {
    if (this.editMode) {
      if (this.gizmoDrag) this.applyGizmoDrag(e)
      else this.updateGizmoHover(e)
      return
    }
    const cb = this.opts.onScreenTouch
    if (!cb || !this.touchActive) return
    const hit = this.pickScreen(e)
    if (!hit) return // 移出屏幕面时不发事件,保持最后位置
    this.lastTouch = hit
    cb('move', hit.u, hit.v)
  }

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (this.editMode) {
      this.finishGizmoDrag(e)
      return
    }
    const cb = this.opts.onScreenTouch
    if (!cb || !this.touchActive) return
    this.touchActive = false
    if (this.controls) this.controls.enabled = this.interactive
    const hit = this.pickScreen(e) ?? this.lastTouch
    if (hit) cb('up', hit.u, hit.v)
  }

  // ------------------------------------------------------------------
  // 编辑外壳:手柄 gizmo(构建/命中/拖拽/读数)
  // ------------------------------------------------------------------

  /** 释放手柄网格组(悬停引用一并失效) */
  private removeGizmos(): void {
    if (!this.handleGroup) return
    this.scene.remove(this.handleGroup)
    disposeObject3D(this.handleGroup)
    this.handleGroup = null
    this.hoverHandle = null
  }

  /**
   * 按当前参数重建手柄组(setHardware 后/模式切换时)。
   * 拖拽进行中以本地权威参数布局 —— setHardware 的参数可能是节流回声(落后于本地),
   * 用它布局会让手柄向后跳;快照+累计位移的拖拽数学本身不受任何回声影响。
   */
  private rebuildGizmos(): void {
    this.removeGizmos()
    // 手柄编辑仅参数化外壳可用(旧档案);scad/无参数时无手柄
    if (!this.editMode || !this.hardware?.enclosure || this.hardware.scad) return
    const params = this.gizmoDrag?.localParams ?? this.hardware.enclosure
    const d = deriveEnclosureDims(this.hardware.board, params)
    // 手柄半径随外壳尺度缩放(小盒不挡视线,大盒不至于找不到)
    const radius = THREE.MathUtils.clamp(Math.max(d.outerW, d.outerD) * 0.03, 1.2, 3)
    this.handleGroup = buildHandleGroup(listHandleSpecs(this.hardware.board, params), radius)
    this.scene.add(this.handleGroup)
  }

  /** 按给定参数就地重摆既有手柄(拖拽中的高频路径,不重建网格) */
  private layoutGizmos(params: EnclosureParams): void {
    if (!this.handleGroup || !this.hardware) return
    const specs = new Map(
      listHandleSpecs(this.hardware.board, params).map((s) => [s.id, s] as const)
    )
    for (const child of this.handleGroup.children) {
      const prev = child.userData.handleSpec as EnclosureHandleSpec | undefined
      const next = prev && specs.get(prev.id)
      if (!next) continue
      child.position.set(next.position.x, next.position.y, next.position.z)
      child.userData.handleSpec = next
    }
  }

  /** 指针 → 仅对手柄网格 raycast(先于屏幕/轨道逻辑;不测模型遮挡,同 gizmo 惯例) */
  private pickHandle(e: PointerEvent): THREE.Mesh | null {
    if (!this.handleGroup) return null
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    this.pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(this.pointerNdc, this.camera)
    const hit = this.raycaster.intersectObjects(this.handleGroup.children, false)[0]
    return hit ? (hit.object as THREE.Mesh) : null
  }

  /** 指针 raycast 到约束平面的交点(平面近似平行视线时返回 null,该次采样丢弃) */
  private intersectDragPlane(e: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    this.pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(this.pointerNdc, this.camera)
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3())
  }

  /** 悬停反馈:手柄提亮 + grab 光标(仅编辑模式且未在拖拽时) */
  private updateGizmoHover(e: PointerEvent): void {
    const mesh = this.pickHandle(e)
    if (mesh === this.hoverHandle) return
    if (this.hoverHandle) {
      ;(this.hoverHandle.material as THREE.MeshBasicMaterial).color.setHex(ENCLOSURE_HANDLE_COLOR)
    }
    this.hoverHandle = mesh
    if (mesh) (mesh.material as THREE.MeshBasicMaterial).color.setHex(ENCLOSURE_HANDLE_HOVER_COLOR)
    this.canvas.style.cursor = mesh ? 'grab' : ''
  }

  /** 开始手柄拖拽:建约束平面、取基准交点、快照参数、暂停轨道控制 */
  private beginGizmoDrag(mesh: THREE.Mesh, e: PointerEvent): void {
    if (!this.hardware) return
    const spec = mesh.userData.handleSpec as EnclosureHandleSpec | undefined
    if (!spec) return
    const pos = new THREE.Vector3(spec.position.x, spec.position.y, spec.position.z)
    const axisU = new THREE.Vector3(spec.axisU.x, spec.axisU.y, spec.axisU.z)
    let normal: THREE.Vector3
    if (spec.planeNormal) {
      normal = new THREE.Vector3(spec.planeNormal.x, spec.planeNormal.y, spec.planeNormal.z)
    } else {
      // 含轴且最面向相机的平面:法线 = 视线方向剔除沿轴分量(视线与轴平行时退化 → 直接用视线)
      const camDir = this.camera.getWorldDirection(new THREE.Vector3())
      normal = camDir.clone().addScaledVector(axisU, -camDir.dot(axisU))
      if (normal.lengthSq() < 1e-6) normal.copy(camDir)
      normal.normalize()
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pos)
    const start = this.intersectDragPlane(e, plane)
    if (!start) return
    const enc = this.hardware?.enclosure
    if (!enc) return // scad/无参数外壳:无手柄可拖(rebuildGizmos 已挡,双保险)
    const startParams: EnclosureParams = { ...enc, ports: enc.ports.map((p) => ({ ...p })) }
    this.gizmoDrag = { spec, plane, start, startParams, localParams: startParams }
    if (this.controls) this.controls.enabled = false // 拖拽期间暂停轨道旋转
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* 部分环境不支持指针捕获,忽略 */
    }
    this.canvas.style.cursor = 'grabbing'
  }

  /** 拖拽采样:平面交点 → 轴向位移 → computeDragPatch → 手柄就地重摆 + 读数 + 排队补丁 */
  private applyGizmoDrag(e: PointerEvent): void {
    const drag = this.gizmoDrag
    if (!drag || !this.hardware) return
    const pt = this.intersectDragPlane(e, drag.plane)
    if (!pt) return
    const move = pt.sub(drag.start)
    const axisU = new THREE.Vector3(drag.spec.axisU.x, drag.spec.axisU.y, drag.spec.axisU.z)
    const u = move.dot(axisU)
    const v = drag.spec.axisV
      ? move.dot(new THREE.Vector3(drag.spec.axisV.x, drag.spec.axisV.y, drag.spec.axisV.z))
      : 0
    const patch = computeDragPatch(drag.spec.id, drag.startParams, this.hardware.board, { u, v })
    drag.localParams = { ...drag.startParams, ...patch }
    this.layoutGizmos(drag.localParams) // 手柄即时跟手(不等 store→setHardware 回路)
    this.updateReadout(e, drag)
    this.pendingPatch = patch // rAF 节流冲刷(合并:只留最新)
  }

  /** 结束拖拽:末次采样 + 立即冲刷补丁 + 恢复控制器/光标/读数(e=null 时为模式切换清理) */
  private finishGizmoDrag(e: PointerEvent | null): void {
    if (!this.gizmoDrag) return
    if (e) this.applyGizmoDrag(e)
    this.gizmoDrag = null
    if (this.pendingPatch && this.onPatchCb) {
      const patch = this.pendingPatch
      this.pendingPatch = null
      this.onPatchCb(patch) // 最终补丁绕过节流,保证落定值持久化
    }
    this.pendingPatch = null
    if (this.controls) this.controls.enabled = this.interactive
    this.canvas.style.cursor = this.hoverHandle ? 'grab' : ''
    if (this.readoutEl) this.readoutEl.style.display = 'none'
  }

  /** 拖拽读数悬浮框(挂 canvas 父容器 —— 3D tab 容器为 relative;无父容器时静默跳过) */
  private updateReadout(e: PointerEvent, drag: GizmoDragState): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    if (!this.readoutEl) {
      const el = document.createElement('div')
      el.style.cssText =
        'position:absolute;z-index:10;pointer-events:none;padding:2px 6px;border-radius:4px;' +
        'background:rgba(18,20,24,0.85);color:#dfe3ea;font:11px/16px ui-monospace,SFMono-Regular,monospace;' +
        'white-space:nowrap;display:none'
      parent.appendChild(el)
      this.readoutEl = el
    }
    const rect = parent.getBoundingClientRect()
    this.readoutEl.style.display = 'block'
    this.readoutEl.style.left = `${Math.round(e.clientX - rect.left + 14)}px`
    this.readoutEl.style.top = `${Math.round(e.clientY - rect.top + 14)}px`
    this.readoutEl.textContent = formatHandleReadout(drag.spec, drag.localParams)
  }
}
