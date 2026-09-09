const steps = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,
  80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,
  494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,
  2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,
  8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,
  27086,29794,32767
]
const shifts = [-1,-1,-1,-1,2,4,6,8]

/** 与固件相同的独立块格式，模拟器也走真实压缩传输协议。 */
export function encodeImaAdpcm(pcm: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  if (!bytes.byteLength || bytes.byteLength > 8192 || bytes.byteLength % 2)
    throw new RangeError('PCM 必须包含 1 至 4096 个完整的 16 位样本')
  const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = bytes.byteLength / 2
  let predicted = samples.getInt16(0, true), index = 0
  if (count > 1) {
    const initial = Math.abs(samples.getInt16(2, true) - predicted)
    while (index < 88 && steps[index]! < initial) index++
  }
  const result = new Uint8Array(6 + Math.floor(count / 2))
  const header = new DataView(result.buffer)
  header.setUint16(0, count, true)
  header.setInt16(2, predicted, true)
  result[4] = index
  for (let i = 1; i < count; i++) {
    let delta = samples.getInt16(i * 2, true) - predicted
    let code = delta < 0 ? 8 : 0
    delta = Math.abs(delta)
    let step = steps[index]!, change = step >> 3
    for (let bit = 4; bit; bit >>= 1, step >>= 1) {
      if (delta >= step) { code |= bit; delta -= step; change += step }
    }
    predicted = Math.max(-32768, Math.min(32767, predicted + ((code & 8) ? -change : change)))
    index = Math.max(0, Math.min(88, index + shifts[code & 7]!))
    result[6 + Math.floor((i-1)/2)]! |= code << (((i-1) % 2) * 4)
  }
  return result.buffer
}
