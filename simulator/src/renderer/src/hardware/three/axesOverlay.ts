/**
 * 左下角坐标轴指示器(axes overlay)—— HardwareViewer 的第二渲染 pass
 *
 * 独立小场景 + 独立相机:每帧把相机放在「主相机相对 controls.target 的单位方向 ×
 * 定距」处看向原点,轴的朝向即与主视图实时同步(Blender/Fusion 风格)。
 * X 红 / Y 绿 / Z 蓝,轴端 Sprite 字母标签(canvas 纹理,恒面向相机)。
 *
 * 轴体用「圆柱 + 锥头」实体网格而非 AxesHelper:WebGL 线宽恒为 1px,细线在
 * 高分屏上几乎不可见(实测反馈);实体轴粗细可控且自带光照无关的纯色着色。
 * 相机距离按「标签最远端 + 呼吸边 < FOV 可视半径」校核 —— 距离不足会把
 * 轴端字母裁出视口(实测缺陷)。
 *
 * 刻意不挂主场景:不进 STL 导出、不影响自动取景(frameIfNeeded 只量 root)、
 * 不拦截屏幕触摸/手柄拾取(pick 只对 root/handleGroup 求交)。
 * 开关走 settings 的 appearance.show3dAxes(HardwareViewer.setAxesVisible)。
 */
import * as THREE from 'three'

/** 指示器视口边长(CSS 逻辑像素;three 内部自乘 pixelRatio) */
export const AXES_VIEWPORT_SIZE = 96
/** 指示器视口到画布左/下边缘的留白(CSS 逻辑像素) */
export const AXES_VIEWPORT_PAD = 8

/** 轴长(overlay 场景内部单位) */
const AXIS_LEN = 1
/** 轴杆半径(实体圆柱;线宽的替代) */
const AXIS_RADIUS = 0.055
/** 锥头尺寸 */
const TIP_RADIUS = 0.13
const TIP_LEN = 0.3
/** 标签中心到原点距离(轴长 + 锥头 + 间隙) */
const LABEL_DIST = AXIS_LEN + TIP_LEN + 0.28
/**
 * overlay 相机到原点的距离。裁切校核(FOV 40°):可视半径 = tan(20°)×dist;
 * 最远内容 = LABEL_DIST + 标签半宽 = 1.58 + 0.3 = 1.88 → dist ≥ 1.88/tan(20°) ≈ 5.17,
 * 取 5.2 —— 任意朝向下标签整字不出视口(视口同时从 76 加大到 96px 补偿显示尺寸)
 */
const CAM_DIST = 5.2
/** 轴颜色(柔和三原色,深浅主题下均可辨) */
const AXIS_COLOR_X = '#e5534b'
const AXIS_COLOR_Y = '#57ab5a'
const AXIS_COLOR_Z = '#539bf5'

const ORIGIN = new THREE.Vector3(0, 0, 0)

export interface AxesOverlay {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** 每帧同步朝向:overlay 相机 = 主相机相对 target 的方向 × 定距,看向原点 */
  syncTo(mainCamera: THREE.Camera, target: THREE.Vector3): void
  /** 释放几何/材质/标签纹理 */
  dispose(): void
}

/** 轴端字母标签:64×64 canvas 纹理 Sprite(恒面向相机) */
function labelSprite(text: string, color: string, pos: THREE.Vector3): THREE.Sprite {
  const size = 64
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')
  if (ctx) {
    ctx.font = 'bold 44px "JetBrains Mono", monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    ctx.fillText(text, size / 2, size / 2 + 3)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }))
  sprite.position.copy(pos)
  sprite.scale.setScalar(0.6)
  return sprite
}

/** 单根实体轴:圆柱杆 + 锥头,沿 dir 方向(几何默认沿 +Y,quaternion 对齐) */
function axisMesh(dir: THREE.Vector3, color: string): THREE.Group {
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) })
  const group = new THREE.Group()
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(AXIS_RADIUS, AXIS_RADIUS, AXIS_LEN, 12), mat)
  shaft.position.y = AXIS_LEN / 2
  const tip = new THREE.Mesh(new THREE.ConeGeometry(TIP_RADIUS, TIP_LEN, 16), mat)
  tip.position.y = AXIS_LEN + TIP_LEN / 2
  group.add(shaft, tip)
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  return group
}

export function createAxesOverlay(): AxesOverlay {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  camera.position.set(0, 0, CAM_DIST)

  const axes = [
    axisMesh(new THREE.Vector3(1, 0, 0), AXIS_COLOR_X),
    axisMesh(new THREE.Vector3(0, 1, 0), AXIS_COLOR_Y),
    axisMesh(new THREE.Vector3(0, 0, 1), AXIS_COLOR_Z)
  ]
  for (const a of axes) scene.add(a)
  // 原点小球:三轴根部视觉收口
  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(AXIS_RADIUS * 1.6, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x9aa0a6 })
  )
  scene.add(hub)

  const labels = [
    labelSprite('X', AXIS_COLOR_X, new THREE.Vector3(LABEL_DIST, 0, 0)),
    labelSprite('Y', AXIS_COLOR_Y, new THREE.Vector3(0, LABEL_DIST, 0)),
    labelSprite('Z', AXIS_COLOR_Z, new THREE.Vector3(0, 0, LABEL_DIST))
  ]
  for (const l of labels) scene.add(l)

  const dir = new THREE.Vector3()
  return {
    scene,
    camera,
    syncTo(mainCamera: THREE.Camera, target: THREE.Vector3): void {
      dir.copy(mainCamera.position).sub(target)
      const len = dir.length()
      if (len < 1e-6) return
      camera.position.copy(dir.multiplyScalar(CAM_DIST / len))
      camera.up.copy(mainCamera.up)
      camera.lookAt(ORIGIN)
    },
    dispose(): void {
      for (const a of axes) {
        for (const child of a.children) {
          const mesh = child as THREE.Mesh
          mesh.geometry.dispose()
        }
        ;((a.children[0] as THREE.Mesh).material as THREE.Material).dispose()
      }
      hub.geometry.dispose()
      ;(hub.material as THREE.Material).dispose()
      for (const l of labels) {
        l.material.map?.dispose()
        l.material.dispose()
      }
    }
  }
}

export { ORIGIN as AXES_ORIGIN }
