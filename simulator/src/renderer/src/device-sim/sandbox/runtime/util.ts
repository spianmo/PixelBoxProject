/**
 * px.util / px.color 与运行时通用工具
 * 注意:sha256 / crc32 需要同步返回(d.ts 契约),因此使用纯 JS 实现而非 crypto.subtle
 */

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** BinaryLike → Uint8Array 视图(不拷贝) */
export function toU8(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

/** BinaryLike → 独立 ArrayBuffer(拷贝,可安全 transfer) */
export function toArrayBufferCopy(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const u8 = toU8(data)
  return u8.slice().buffer
}

/** 0xRRGGBB → 'rgb(r,g,b)' */
export function colorToCss(color: number): string {
  const c = color & 0xffffff
  return `rgb(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff})`
}

// ---------------------------------------------------------------
// base64 / hex
// ---------------------------------------------------------------

export function b64encode(data: ArrayBuffer | Uint8Array): string {
  const u8 = toU8(data)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function b64decode(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8.buffer
}

export function hexEncode(data: ArrayBuffer | Uint8Array): string {
  const u8 = toU8(data)
  let out = ''
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, '0')
  return out
}

export function hexDecode(hex: string): ArrayBuffer {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const u8 = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return u8.buffer
}

// ---------------------------------------------------------------
// crc32(标准 IEEE 多项式)
// ---------------------------------------------------------------

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

export function crc32(data: ArrayBuffer | Uint8Array): number {
  const u8 = toU8(data)
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < u8.length; i++) {
    crc = table[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------
// sha256(纯 JS 同步实现,FIPS 180-4)
// ---------------------------------------------------------------

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

export function sha256(data: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : toU8(data)
  const len = input.length
  // 填充
  const bitLen = len * 8
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64)
  padded.set(input)
  padded[len] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  dv.setUint32(padded.length - 4, bitLen >>> 0, false)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const w = new Uint32Array(64)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  const out = new Uint8Array(32)
  const outDv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, h[i], false)
  return out.buffer
}

// ---------------------------------------------------------------
// 随机
// ---------------------------------------------------------------

export function randomBytes(len: number): ArrayBuffer {
  const u8 = new Uint8Array(Math.max(0, len | 0))
  // getRandomValues 单次上限 65536 字节
  for (let i = 0; i < u8.length; i += 65536) {
    crypto.getRandomValues(u8.subarray(i, Math.min(i + 65536, u8.length)))
  }
  return u8.buffer
}

/** UUID v4(沙箱 opaque origin 下 crypto.randomUUID 可能不可用,手动实现) */
export function uuid(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = hexEncode(b)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ---------------------------------------------------------------
// 颜色工具
// ---------------------------------------------------------------

export function rgb(r: number, g: number, b: number): number {
  return ((clamp(r | 0, 0, 255) << 16) | (clamp(g | 0, 0, 255) << 8) | clamp(b | 0, 0, 255)) >>> 0
}

/** h 0-360, s/v 0-100 */
export function hsv(h: number, s: number, v: number): number {
  const hh = ((h % 360) + 360) % 360
  const ss = clamp(s, 0, 100) / 100
  const vv = clamp(v, 0, 100) / 100
  const c = vv * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = vv - c
  let r = 0
  let g = 0
  let b = 0
  if (hh < 60) [r, g, b] = [c, x, 0]
  else if (hh < 120) [r, g, b] = [x, c, 0]
  else if (hh < 180) [r, g, b] = [0, c, x]
  else if (hh < 240) [r, g, b] = [0, x, c]
  else if (hh < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return rgb(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255))
}

export function lerpColor(a: number, b: number, t: number): number {
  const tt = clamp(t, 0, 1)
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  return rgb(
    Math.round(ar + (br - ar) * tt),
    Math.round(ag + (bg - ag) * tt),
    Math.round(ab + (bb - ab) * tt)
  )
}
