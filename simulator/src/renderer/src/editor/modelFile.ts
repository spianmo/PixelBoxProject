/** 仅声明已有加载器支持的格式;STEP/FBX 等不冒充可预览格式。 */
export type ModelFormat = 'stl' | 'obj' | 'ply' | 'glb' | 'gltf' | '3mf'
const MODEL_FORMATS = new Set<ModelFormat>(['stl', 'obj', 'ply', 'glb', 'gltf', '3mf'])

export function modelFormatForPath(path: string): ModelFormat | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const ext = (dot < 0 ? '' : name.slice(dot + 1).toLowerCase()) as ModelFormat
  return MODEL_FORMATS.has(ext) ? ext : null
}

export function isModelFile(path: string): boolean {
  return modelFormatForPath(path) !== null
}

/** 模型引用的相对资源路径;实际工作区边界仍由二进制 IPC 校验。 */
export function modelResourcePath(modelPath: string, uri: string): string {
  const relative = decodeURIComponent(uri).replace(/\\/g, '/')
  if (!relative || /^[a-z][a-z\d+.-]*:|^\/|\0/i.test(relative)) {
    throw new Error('模型资源须使用本地相对路径')
  }
  const separator = modelPath.includes('\\') ? '\\' : '/'
  const parts = modelPath.split(/[/\\]/)
  parts.pop()
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length <= 1) throw new Error('模型资源路径越界')
      parts.pop()
    } else parts.push(part)
  }
  return parts.join(separator)
}
