/** 二进制 STL 的尺寸与完整性检查；导出时落床，不修改装配预览坐标。 */
export function stlBounds(buffer: ArrayBuffer): { min: number[]; max: number[]; triangles: number } {
  if (buffer.byteLength < 84) throw new Error('STL 文件不完整')
  const view = new DataView(buffer)
  const triangles = view.getUint32(80, true)
  if (!triangles || 84 + triangles * 50 !== buffer.byteLength) throw new Error('STL 三角形数量与文件长度不一致')
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < triangles; i++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        const v = view.getFloat32(84 + i * 50 + 12 + vertex * 12 + axis * 4, true)
        if (!Number.isFinite(v)) throw new Error('STL 包含无效顶点')
        min[axis] = Math.min(min[axis], v)
        max[axis] = Math.max(max[axis], v)
      }
    }
  }
  if (max.some((v, axis) => v - min[axis] <= 0)) throw new Error('STL 不是有效三维实体')
  return { min, max, triangles }
}

export function placeStlOnBed(buffer: ArrayBuffer): ArrayBuffer {
  const { min, max, triangles } = stlBounds(buffer)
  const out = buffer.slice(0)
  const view = new DataView(out)
  const shift = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]]
  for (let i = 0; i < triangles; i++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        const at = 84 + i * 50 + 12 + vertex * 12 + axis * 4
        view.setFloat32(at, view.getFloat32(at, true) - shift[axis], true)
      }
    }
  }
  return out
}
