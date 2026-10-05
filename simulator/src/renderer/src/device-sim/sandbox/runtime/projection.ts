type ProjectionOptions = Partial<Record<'yaw' | 'pitch' | 'squash' | 'lift' | 'scale' | 'cx' | 'cy' | 'distance' | 'grid', number>>

export function blendPoints(pointSets: Float32Array[], weights: Float32Array, output: Float32Array): void {
  if (!Array.isArray(pointSets) || !(weights instanceof Float32Array) || !(output instanceof Float32Array))
    throw new TypeError('blendPoints needs point sets, weights and Float32Array output')
  if (!pointSets.length || pointSets.length > 32) throw new RangeError('blendPoints accepts 1 to 32 point sets')
  // 先读完数组 getter，再检查视图，保持与固件的 buffer 脱离检查顺序一致。
  const sources = Array.from(pointSets)
  new Uint8Array(weights.buffer)
  new Uint8Array(output.buffer)
  if (weights.length !== sources.length || output.length % 3 || output.length > 8192 * 3 ||
    (output.length && output.buffer === weights.buffer)) throw new RangeError('invalid blend lengths or aliased output')
  for (let i = 0; i < sources.length; i++) {
    const points = sources[i]
    if (!(points instanceof Float32Array)) throw new TypeError('point sets must be Float32Array')
    new Uint8Array(points.buffer)
    if (points.length !== output.length || (output.length && points.buffer === output.buffer) || !Number.isFinite(weights[i]))
      throw new RangeError('invalid point set, weight or aliased output')
  }
  output.fill(0)
  for (let i = 0; i < sources.length; i++) {
    const weight = weights[i]
    if (!weight) continue
    const points = sources[i]
    for (let j = 0; j < output.length; j++) output[j] += points[j] * weight
  }
}

function projectInto(points: Float32Array, options: ProjectionOptions, output: Int32Array, bounds: boolean, indices?: Uint32Array): number {
  if (!(points instanceof Float32Array) || !options || typeof options !== 'object' || !(output instanceof Int32Array))
    throw new TypeError('projectPoints needs Float32Array, options, Int32Array')
  const option = (key: keyof ProjectionOptions, fallback: number): number => {
    const value = options[key]
    return value === undefined ? fallback : Number(value)
  }
  const yaw = option('yaw', 0), pitch = option('pitch', 0)
  const squash = option('squash', 1), lift = option('lift', 0)
  const scale = option('scale', 1), cx = option('cx', 0), cy = option('cy', 0)
  const distance = option('distance', 64), grid = option('grid', 1)
  if (![yaw, pitch, squash, lift, scale, cx, cy, distance, grid].every(Number.isFinite) || scale <= 0 || distance <= 0 || grid < 1)
    throw new RangeError('invalid projection options')
  // Construct views after reading options: getters may detach a supplied buffer.
  new Uint8Array(points.buffer)
  new Uint8Array(output.buffer)
  if (indices !== undefined) {
    if (!(indices instanceof Uint32Array)) throw new TypeError('projection indices must be Uint32Array')
    new Uint8Array(indices.buffer)
  }
  if (points.length % 3 || points.length > 8192 * 3 || output.length < (bounds ? 4 : points.length / 3 * 2) ||
    (indices && indices.length > 8192) ||
    (points.length && points.buffer === output.buffer)) throw new RangeError('invalid projection lengths or aliased buffers')
  const ca = Math.cos(yaw), sa = Math.sin(yaw), cb = Math.cos(pitch), sb = Math.sin(pitch)
  const count = indices ? indices.length : points.length / 3
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let k = 0, j = 0; k < count; k++, j += 2) {
    const index = indices ? indices[k] : k
    if (index >= points.length / 3) throw new RangeError('projection index is out of range')
    const i = index * 3
    const x = points[i] * ca + points[i + 2] * sa
    const z = -points[i] * sa + points[i + 2] * ca
    const y = points[i + 1] * squash * cb - z * sb
    const depth = points[i + 1] * sb + z * cb
    const perspective = distance / (distance - depth)
    const gx = Math.round(Math.round(cx + x * scale * perspective) / grid)
    const gy = Math.round(Math.round(cy + y * scale * perspective + lift) / grid)
    if (depth >= distance || !Number.isFinite(gx) || !Number.isFinite(gy) ||
      gx < -2147483648 || gx > 2147483647 || gy < -2147483648 || gy > 2147483647)
      throw new RangeError('point is outside the projection range')
    if (!bounds) { output[j] = gx; output[j + 1] = gy }
    if (gx < minX) minX = gx
    if (gx > maxX) maxX = gx
    if (gy < minY) minY = gy
    if (gy > maxY) maxY = gy
  }
  if (bounds) {
    output[0] = count ? minX : 0; output[1] = count ? minY : 0
    output[2] = count ? maxX : 0; output[3] = count ? maxY : 0
  }
  return count
}

export function projectPoints(points: Float32Array, options: ProjectionOptions, output: Int32Array): void {
  projectInto(points, options, output, false)
}

export function projectPointBounds(points: Float32Array, options: ProjectionOptions, output: Int32Array, indices?: Uint32Array): number {
  return projectInto(points, options, output, true, indices)
}

export function projectPointRuns(points: Float32Array, options: ProjectionOptions, output: Int32Array): number {
  if (!(points instanceof Float32Array) || !(output instanceof Int32Array)) throw new TypeError('invalid projection arrays')
  if (output.length < points.length) throw new RangeError('output must fit 3 integers per point')
  projectPoints(points, options, output)
  const count = points.length / 3
  if (!count) return 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, output[i * 2]); maxX = Math.max(maxX, output[i * 2])
    minY = Math.min(minY, output[i * 2 + 1]); maxY = Math.max(maxY, output[i * 2 + 1])
  }
  const width = maxX - minX + 1, height = maxY - minY + 1
  if (width * height > 65536) throw new RangeError('projected grid exceeds 65536 cells')
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < count; i++) mask[(output[i * 2 + 1] - minY) * width + output[i * 2] - minX] = 1
  let emitted = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width;) {
    if (!mask[y * width + x]) { x++; continue }
    const start = x
    while (x < width && mask[y * width + x]) x++
    output[emitted * 3] = start + minX
    output[emitted * 3 + 1] = y + minY
    output[emitted * 3 + 2] = x - start
    emitted++
  }
  return emitted
}
