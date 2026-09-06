type ProjectionOptions = Partial<Record<'yaw' | 'pitch' | 'squash' | 'lift' | 'scale' | 'cx' | 'cy' | 'distance' | 'grid', number>>

export function projectPoints(points: Float32Array, options: ProjectionOptions, output: Int32Array): void {
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
  if (points.length % 3 || points.length > 8192 * 3 || output.length < points.length / 3 * 2 ||
    (points.length && points.buffer === output.buffer)) throw new RangeError('invalid projection lengths or aliased buffers')
  const ca = Math.cos(yaw), sa = Math.sin(yaw), cb = Math.cos(pitch), sb = Math.sin(pitch)
  for (let i = 0, j = 0; i < points.length; i += 3, j += 2) {
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
    output[j] = gx; output[j + 1] = gy
  }
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
