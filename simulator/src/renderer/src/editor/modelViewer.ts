import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createAxesOverlay } from '../hardware/three/axesOverlay'
import { modelFormatForPath } from './modelFile'
import { disposeModelObject, type LoadedModel } from './modelLoader'

/** 独立文件查看器:按需绘制,不携带硬件装配编辑逻辑,关闭标签即回收 WebGL。 */
export class ModelViewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000)
  private readonly controls: OrbitControls
  private readonly root = new THREE.Group()
  private readonly grid = new THREE.GridHelper(8, 32, 0x8a8f98, 0x8a8f98)
  private readonly axes = createAxesOverlay()
  private readonly environment: THREE.WebGLRenderTarget
  private readonly observer: ResizeObserver
  private readonly radius: number
  private disposed = false

  constructor(private readonly canvas: HTMLCanvasElement, private readonly model: LoadedModel, path: string) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.minDistance = 0.1
    this.controls.maxDistance = 150
    this.controls.addEventListener('change', this.render)

    // 打印模型通常 Z 向上,glTF 为 Y 向上。仅变换展示组,文件坐标与尺寸保持原值。
    this.root.add(model.object)
    const format = modelFormatForPath(path)
    if (format === 'stl' || format === '3mf') this.root.rotation.x = -Math.PI / 2
    this.axes.scene.rotation.copy(this.root.rotation) // 轴标签保留文件坐标方向,STL 的 Z 轴向上
    const box = new THREE.Box3().setFromObject(this.root, true)
    const scale = 2 / Math.max(...box.getSize(new THREE.Vector3()))
    this.root.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-scale)
    this.root.scale.setScalar(scale)
    this.scene.add(this.root)
    const normalized = new THREE.Box3().setFromObject(this.root, true)
    this.radius = normalized.getBoundingSphere(new THREE.Sphere()).radius
    this.grid.position.y = normalized.min.y - 0.01
    const gridMaterial = this.grid.material as THREE.Material
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.22
    gridMaterial.depthWrite = false
    this.scene.add(this.grid, new THREE.HemisphereLight(0xffffff, 0x8090b0, 2))
    const key = new THREE.DirectionalLight(0xffffff, 3)
    key.position.set(4, 6, 5)
    this.scene.add(key)
    const room = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.environment = pmrem.fromScene(room, 0.04)
    this.scene.environment = this.environment.texture
    room.dispose()
    pmrem.dispose()
    this.observer = new ResizeObserver(() => this.resize())
    if (canvas.parentElement) this.observer.observe(canvas.parentElement)
    this.resize()
  }

  private resize(): void {
    if (this.disposed) return
    const parent = this.canvas.parentElement
    const width = Math.max(1, parent?.clientWidth ?? 1)
    const height = Math.max(1, parent?.clientHeight ?? 1)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.fit(false)
  }

  /** 包围球同时约束水平/垂直视角,窄分屏也能看到完整模型。 */
  fit(resetDirection = true): void {
    if (this.disposed) return
    const vertical = THREE.MathUtils.degToRad(this.camera.fov) / 2
    const halfAngle = Math.min(vertical, Math.atan(Math.tan(vertical) * this.camera.aspect))
    const distance = this.radius / Math.sin(halfAngle) * 1.15
    const direction = resetDirection
      ? new THREE.Vector3(1, 0.75, 1)
      : this.camera.position.clone().sub(this.controls.target)
    if (direction.lengthSq() === 0) direction.set(1, 0.75, 1)
    this.controls.target.set(0, 0, 0)
    this.camera.position.copy(direction.normalize().multiplyScalar(distance))
    this.controls.update()
    this.render()
  }

  zoom(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target)
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance))
    this.camera.position.copy(this.controls.target).add(offset)
    this.controls.update()
    this.render()
  }

  setWireframe(enabled: boolean): void {
    this.root.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return
      const material = (node as THREE.Mesh).material
      for (const item of Array.isArray(material) ? material : [material]) {
        if ('wireframe' in item) item.wireframe = enabled
      }
    })
    this.render()
  }

  readonly render = (): void => {
    if (this.disposed) return
    const size = this.renderer.getSize(new THREE.Vector2())
    this.renderer.setViewport(0, 0, size.x, size.y)
    this.renderer.render(this.scene, this.camera)
    const side = Math.min(84, size.x, size.y)
    this.renderer.autoClear = false
    this.renderer.clearDepth()
    this.axes.syncTo(this.camera, this.controls.target)
    this.renderer.setViewport(8, 8, side, side)
    this.renderer.render(this.axes.scene, this.axes.camera)
    this.renderer.autoClear = true
    this.renderer.setViewport(0, 0, size.x, size.y)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.controls.dispose()
    this.root.remove(this.model.object)
    this.model.dispose()
    disposeModelObject(this.grid)
    this.axes.dispose()
    this.environment.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
