import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { MTLLoader, type MaterialInfo } from 'three/addons/loaders/MTLLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { imageMimeForPath } from './imageFile'
import { modelFormatForPath, modelResourcePath } from './modelFile'

export type ModelErrorCode = 'readFailed' | 'invalid' | 'resourceFailed' | 'compressed' | 'graphicsFailed' | 'timeout'
export class ModelPreviewError extends Error {
  constructor(readonly code: ModelErrorCode, options?: ErrorOptions) { super(code, options) }
}

export interface LoadedModel {
  object: THREE.Object3D
  size: THREE.Vector3
  triangles: number
  vertices: number
  bytes: number
  dispose(): void
}

/** 共享几何/材质只释放一次;glTF ImageBitmap 需额外 close,避免反复切标签累积显存。 */
export function disposeModelObject(...roots: THREE.Object3D[]): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const skeletons = new Set<THREE.Skeleton>()
  for (const root of roots) root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    if (mesh.material) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material)
      }
    }
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((node as THREE.SkinnedMesh).skeleton)
  })
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value)
    }
    material.dispose()
  }
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close()
    texture.dispose()
  }
  for (const geometry of geometries) geometry.dispose()
  for (const skeleton of skeletons) skeleton.dispose()
}

/** GLB 的 JSON 块也可引用外部资源,不能只检查 .gltf 文件。 */
function gltfDocument(buffer: ArrayBuffer): Record<string, unknown> {
  const data = new DataView(buffer)
  if (buffer.byteLength >= 12 && data.getUint32(0, true) === 0x46546c67) {
    if (data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== buffer.byteLength) {
      throw new ModelPreviewError('invalid')
    }
    for (let offset = 12; offset + 8 <= buffer.byteLength;) {
      const length = data.getUint32(offset, true)
      const type = data.getUint32(offset + 4, true)
      if (offset + 8 + length > buffer.byteLength) throw new ModelPreviewError('invalid')
      if (type === 0x4e4f534a) return JSON.parse(new TextDecoder().decode(buffer.slice(offset + 8, offset + 8 + length)))
      offset += 8 + length
    }
    throw new ModelPreviewError('invalid')
  }
  return JSON.parse(new TextDecoder().decode(buffer))
}

/** 取消等待时移除监听;底层已启动的解码晚到结果由调用方回收。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function loadModel(
  path: string,
  signal: AbortSignal,
  onDependency: (path: string) => void
): Promise<LoadedModel> {
  const format = modelFormatForPath(path)
  const urls = new Set<string>()
  const resourceUrls = new Map<string, string>()
  const manager = new THREE.LoadingManager()
  let failedResource = false
  let object: THREE.Object3D | null = null
  const extraScenes: THREE.Object3D[] = []
  const read = async (file: string, code: ModelErrorCode): Promise<ArrayBuffer> => {
    signal.throwIfAborted()
    onDependency(file)
    try {
      const data = await window.api.readFileBinary(file)
      signal.throwIfAborted()
      return data
    } catch (error) {
      signal.throwIfAborted()
      throw error instanceof ModelPreviewError ? error : new ModelPreviewError(code)
    }
  }
  const resource = async (uri: string, base = path): Promise<string> => {
    if (/^data:/i.test(uri)) return uri
    let file: string
    try { file = modelResourcePath(base, uri) } catch { throw new ModelPreviewError('resourceFailed') }
    const cached = resourceUrls.get(file)
    if (cached) return cached
    const data = await read(file, 'resourceFailed')
    const url = URL.createObjectURL(new Blob([data], { type: imageMimeForPath(file) ?? 'application/octet-stream' }))
    urls.add(url)
    resourceUrls.set(file, url)
    return url
  }
  manager.setURLModifier((uri) => {
    if (/^(blob:|data:)/i.test(uri)) {
      if (uri.startsWith('blob:')) urls.add(uri) // 兼顾 3MF/glTF 加载器内部创建的贴图 URL
      return uri
    }
    const url = resourceUrls.get(uri)
    if (!url) throw new ModelPreviewError('resourceFailed')
    return url
  })
  manager.onError = () => { failedResource = true }
  // 保留一个加载哨兵,等 OBJ/3MF 的异步贴图全部结束后再交付可渲染模型。
  const texturesReady = new Promise<void>((resolve) => { manager.onLoad = resolve })
  manager.itemStart('model-preview')
  const cleanupUrls = (): void => { for (const url of urls) URL.revokeObjectURL(url) }

  try {
    const buffer = await read(path, 'readFailed')
    if (format === 'stl' || format === 'ply') {
      const geometry = format === 'stl' ? new STLLoader().parse(buffer) : new PLYLoader().parse(buffer)
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({
        color: geometry.hasAttribute('color') ? 0xffffff : 0x86a9d4,
        vertexColors: geometry.hasAttribute('color'), roughness: 0.65, metalness: 0.1, side: THREE.DoubleSide
      })
      const pointCloud = format === 'ply' && !geometry.index && !/^element face [1-9]\d*\s*$/m.test(
        new TextDecoder().decode(buffer.slice(0, 65536)).split('end_header')[0]
      )
      object = pointCloud
        ? new THREE.Points(geometry, new THREE.PointsMaterial({ color: material.color, vertexColors: material.vertexColors, size: 3, sizeAttenuation: false }))
        : new THREE.Mesh(geometry, material)
      if (object instanceof THREE.Points) material.dispose()
    } else if (format === 'obj') {
      const text = new TextDecoder().decode(buffer)
      const materialLoader = new MTLLoader(manager)
      materialLoader.setMaterialOptions({ side: THREE.DoubleSide })
      const creator = materialLoader.parse('', '')
      const infos: Record<string, MaterialInfo> = {}
      // OBJ 材质相对 MTL 所在目录解析,可含空格;不猜测缺失的同名材质文件。
      const libraries = [...text.matchAll(/^mtllib\s+(.+)$/gm)].map((match) => match[1].trim())
      for (const library of new Set(libraries)) {
        let mtlPath: string
        try { mtlPath = modelResourcePath(path, library) } catch { throw new ModelPreviewError('resourceFailed') }
        const mtl = new MTLLoader().parse(new TextDecoder().decode(await read(mtlPath, 'resourceFailed')), '')
        for (const [name, info] of Object.entries(mtl.materialsInfo)) {
          for (const key of ['map_kd', 'map_ks', 'map_ke', 'norm', 'map_bump', 'bump', 'disp', 'map_d'] as const) {
            const value = info[key]
            if (!value) continue
            const uri = creator.getTextureParams(value, {}).url
            info[key] = value.replace(uri, await resource(uri, mtlPath))
          }
          infos[name] = info
        }
      }
      creator.setMaterials(infos)
      const loader = new OBJLoader(manager)
      if (libraries.length) loader.setMaterials(creator)
      object = loader.parse(text)
    } else if (format === 'glb' || format === 'gltf') {
      const json = gltfDocument(buffer)
      const extensions = json.extensionsUsed as string[] | undefined
      if (extensions?.some((name) => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(name))) {
        throw new ModelPreviewError('compressed')
      }
      for (const item of [...(json.buffers as { uri?: string }[] ?? []), ...(json.images as { uri?: string }[] ?? [])]) {
        if (item.uri) resourceUrls.set(item.uri, await resource(item.uri))
      }
      const parsed = new GLTFLoader(manager).parseAsync(buffer, '').then((gltf) => {
        if (signal.aborted) {
          disposeModelObject(...gltf.scenes)
          cleanupUrls()
          signal.throwIfAborted()
        }
        return gltf
      })
      const gltf = await abortable(parsed, signal)
      object = gltf.scene
      extraScenes.push(...gltf.scenes.filter((scene) => scene !== object))
    } else if (format === '3mf') {
      object = new ThreeMFLoader(manager).parse(buffer)
    } else throw new ModelPreviewError('invalid')

    manager.itemEnd('model-preview')
    await abortable(texturesReady, signal)
    signal.throwIfAborted()
    if (failedResource) throw new ModelPreviewError('resourceFailed')
    // 取原始坐标尺寸;STL/OBJ/PLY 没有可靠单位,界面不擅自标注毫米。
    let triangles = 0
    let vertices = 0
    object.traverse((node) => {
      const mesh = node as THREE.Mesh
      const geometry = mesh.geometry
      if (!geometry) return
      const positions = geometry.getAttribute('position')
      if (!positions || positions.itemSize < 3) throw new ModelPreviewError('invalid')
      for (let i = 0; i < positions.count; i++) {
        if (![positions.getX(i), positions.getY(i), positions.getZ(i)].every(Number.isFinite)) throw new ModelPreviewError('invalid')
      }
      if (geometry.index) {
        for (let i = 0; i < geometry.index.count; i++) {
          if (geometry.index.getX(i) >= positions.count) throw new ModelPreviewError('invalid')
        }
      }
      const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1
      vertices += positions.count * instances
      if (mesh.isMesh) triangles += Math.floor((geometry.index?.count ?? positions.count) / 3) * instances
    })
    const box = new THREE.Box3().setFromObject(object, true)
    const size = box.getSize(new THREE.Vector3())
    if (!vertices || box.isEmpty() || ![...size, ...box.min, ...box.max].every(Number.isFinite) || size.length() === 0) {
      throw new ModelPreviewError('invalid')
    }
    const result = object
    let disposed = false
    return {
      object: result, size, triangles, vertices, bytes: buffer.byteLength,
      dispose: () => {
        if (disposed) return
        disposed = true
        disposeModelObject(result, ...extraScenes)
        cleanupUrls()
      }
    }
  } catch (error) {
    disposeModelObject(...(object ? [object] : []), ...extraScenes)
    cleanupUrls()
    signal.throwIfAborted()
    throw error instanceof ModelPreviewError ? error : new ModelPreviewError('invalid', { cause: error })
  }
}
