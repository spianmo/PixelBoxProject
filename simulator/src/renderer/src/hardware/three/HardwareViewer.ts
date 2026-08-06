/**
 * HardwareViewer —— 命令式 three.js 硬件查看器(hardware 面板与 Sim 3D 共用)
 *
 * 职责(docs/plans/ide-v3-project-types.md §2.4):
 *   - WebGLRenderer + PerspectiveCamera + OrbitControls(enableDamping)+ 三点布光 + 淡网格地面
 *   - setHardware:重建 board/base/lid 三个部件组,userData.explode 存
 *     { home: 合拢位置, dir: 单位方向, dist: 距离 };lid +Y、base -Y、board 原位
 *   - setExplode:THREE.MathUtils.damp 在 rAF 里把爆炸标量逼近目标(帧率无关、可中途反转)
 *   - attachScreenCanvas:CanvasTexture 贴到板顶屏幕薄面;markScreenDirty 脏标记驱动纹理上传
 *   - onScreenTouch:对屏幕面做指针 raycast,回调 UV(u∈[0,1] 左→右,v∈[0,1] 顶→底);
 *     rotationDeg 通过旋转屏幕网格本身实现,UV 空间随之旋转,无需二次换算
 *   - exportSTL:立即归零爆炸 → updateMatrixWorld(true) → STLExporter binary → 还原爆炸
 *     (屏幕贴片挂在 scene 而非 root,'assembly'=root 导出天然不含贴片/灯光/网格)
 *
 * 渲染循环选择:**常开 rAF**(简单可靠;controls 阻尼、爆炸动画、贴图更新统一驱动),
 * 页面隐藏时浏览器本身暂停 rAF,循环内再加 visibilityState 守卫兜底;dispose 取消。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { buildBoardGroup } from './boardBuilder'
import { buildEnclosure } from './enclosureBuilder'
import type { Hardware3D, ScreenPlacement, ExplodeTarget, HardwarePartId } from '../types'

export interface HardwareViewerOptions {
  /** OrbitControls,默认 true */
  interactive?: boolean
  /** 背景色;null = 透明,默认 null */
  background?: string | null
  /** 屏幕面 raycast UV(0..1;v=0 为屏幕顶) */
  onScreenTouch?: (type: 'down' | 'move' | 'up', u: number, v: number) => void
}

/** 部件爆炸元数据(存于 Group.userData.explode) */
interface ExplodeMeta {
  home: THREE.Vector3
  dir: THREE.Vector3
  dist: number
}

/** 屏幕贴片抬离板顶面的高度 mm(默认元件盒高 2.5 之上再抬 0.1 防 z-fighting) */
const SCREEN_LIFT_MM = 2.6
/** 未 setHardware 时屏幕贴片的板顶面兜底高度(默认壁厚 2 + 支撑柱高 4) */
const DEFAULT_BOARD_TOP_Y = 6
/** 爆炸动画阻尼系数(damp 的 lambda,越大越快) */
const EXPLODE_DAMP_LAMBDA = 7
/** 爆炸标量收敛阈值 */
const EXPLODE_EPS = 0.0005

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
  /** 部件根组(name:'assembly',仅含 board/base/lid) */
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
  private screenDirty = false
  private touchActive = false
  private lastTouch: { u: number; v: number } | null = null

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

    if (opts.onScreenTouch) {
      canvas.addEventListener('pointerdown', this.handlePointerDown)
      canvas.addEventListener('pointermove', this.handlePointerMove)
      canvas.addEventListener('pointerup', this.handlePointerUp)
      canvas.addEventListener('pointercancel', this.handlePointerUp)
    }

    this.resize()
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  /** 重建 board/base/lid 部件组 + 爆炸向量;多次调用会释放旧几何 */
  setHardware(hw: Hardware3D): void {
    this.hardware = hw
    this.clearParts()

    const enc = hw.enclosure
    const boardTopY = enc.wallMM + enc.standoffHeightMM // 契约:板顶面世界高度

    const board = buildBoardGroup(hw.board) // 组局部:板顶面 y=0
    board.userData.explode = {
      home: new THREE.Vector3(0, boardTopY, 0),
      dir: new THREE.Vector3(0, 1, 0),
      dist: 0 // 板原位不动
    } satisfies ExplodeMeta

    const { base, lid } = buildEnclosure(hw.board, enc, hw.screen ?? null)
    base.userData.explode = {
      home: new THREE.Vector3(0, 0, 0),
      dir: new THREE.Vector3(0, -1, 0),
      dist: enc.wallMM + enc.baseHeightMM + 12
    } satisfies ExplodeMeta
    lid.userData.explode = {
      home: new THREE.Vector3(0, 0, 0),
      dir: new THREE.Vector3(0, 1, 0),
      dist: enc.lidHeightMM + enc.wallMM + 20
    } satisfies ExplodeMeta

    this.root.add(board, base, lid)
    this.applyExplode()
    this.updateScreenTransform()
    this.frameIfNeeded()
  }

  /** 爆炸视图目标(damp 动画,可中途反转) */
  setExplode(target: ExplodeTarget): void {
    this.explodeTarget = target
  }

  getExplode(): ExplodeTarget {
    return this.explodeTarget
  }

  /**
   * 把模拟器屏幕画布贴到板顶屏幕面。src=null 时移除。
   * 贴片挂 scene(非 root):爆炸时板不动、贴片随之;STL 导出天然排除。
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

    const geo = new THREE.PlaneGeometry(placement.w, placement.h)
    geo.rotateX(-Math.PI / 2) // 面朝 +Y
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'screen'

    this.screenMesh = mesh
    this.screenTexture = tex
    this.scene.add(mesh)
    this.updateScreenTransform()
    this.screenDirty = true
  }

  /** 新帧到达时由外部调用;下一次渲染前置 texture.needsUpdate(每帧只上传一次) */
  markScreenDirty(): void {
    this.screenDirty = true
  }

  /**
   * 导出二进制 STL。'assembly' = 整个部件根组;导出前立即归零爆炸并 bake 世界矩阵,
   * 完成后还原爆炸状态。返回独立 ArrayBuffer(按 DataView 的 byteOffset/byteLength 切片)。
   */
  exportSTL(part: HardwarePartId | 'assembly'): ArrayBuffer {
    const target = part === 'assembly' ? this.root : this.root.getObjectByName(part)
    if (!target || this.root.children.length === 0) throw new Error('hw:noHardware')
    const savedFactor = this.explodeFactor
    this.explodeFactor = 0
    this.applyExplode()
    this.root.updateMatrixWorld(true)
    try {
      const dv = this.exporter.parse(target, { binary: true })
      return dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)
    } finally {
      this.explodeFactor = savedFactor
      this.applyExplode()
      this.root.updateMatrixWorld(true)
    }
  }

  /** 按画布 CSS 尺寸 × devicePixelRatio 更新渲染尺寸与相机纵横比 */
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
    this.clearParts()
    this.removeScreenMesh()
    this.scene.remove(this.grid)
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()
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

    this.renderer.render(this.scene, this.camera)
  }

  /** 按当前爆炸标量摆放所有部件:position = home + dir × dist × factor */
  private applyExplode(): void {
    for (const part of this.root.children) {
      const ex = part.userData.explode as ExplodeMeta | undefined
      if (!ex) continue
      part.position.copy(ex.home).addScaledVector(ex.dir, ex.dist * this.explodeFactor)
    }
  }

  private clearParts(): void {
    for (const child of [...this.root.children]) {
      this.root.remove(child)
      disposeObject3D(child)
    }
  }

  private removeScreenMesh(): void {
    if (this.screenMesh) {
      this.scene.remove(this.screenMesh)
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

  /** 屏幕贴片位姿:板顶面 + 抬离量;rotationDeg 直接旋转网格(UV 随几何旋转,触摸无需换算) */
  private updateScreenTransform(): void {
    const p = this.screenPlacement
    if (!p || !this.screenMesh) return
    const enc = this.hardware?.enclosure
    const topY = enc ? enc.wallMM + enc.standoffHeightMM : DEFAULT_BOARD_TOP_Y
    this.screenMesh.position.set(p.x, topY + SCREEN_LIFT_MM, -p.y) // circuit (x,y) → three (x,-z)
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

  /** 指针 → NDC → raycast 屏幕面;返回 UV(v=0 为屏幕顶) */
  private pickScreen(e: PointerEvent): { u: number; v: number } | null {
    if (!this.screenMesh) return null
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    this.pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(this.pointerNdc, this.camera)
    const hit = this.raycaster.intersectObject(this.screenMesh, false)[0]
    if (!hit || !hit.uv) return null
    // PlaneGeometry v=1 一侧位于板"北"(屏幕顶);回调约定 v=0 为顶 → 取 1-uv.y
    return { u: hit.uv.x, v: 1 - hit.uv.y }
  }

  private readonly handlePointerDown = (e: PointerEvent): void => {
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
    const cb = this.opts.onScreenTouch
    if (!cb || !this.touchActive) return
    const hit = this.pickScreen(e)
    if (!hit) return // 移出屏幕面时不发事件,保持最后位置
    this.lastTouch = hit
    cb('move', hit.u, hit.v)
  }

  private readonly handlePointerUp = (e: PointerEvent): void => {
    const cb = this.opts.onScreenTouch
    if (!cb || !this.touchActive) return
    this.touchActive = false
    if (this.controls) this.controls.enabled = this.interactive
    const hit = this.pickScreen(e) ?? this.lastTouch
    if (hit) cb('up', hit.u, hit.v)
  }
}
