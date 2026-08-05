/**
 * WAV 封装 / 解析 / PCM16 重采样工具。
 * - STT 上传:把裸 PCM16LE 封成标准 WAV(44 字节头)
 * - TTS 降级:服务商拿不到 pcm 时请求 wav,在这里解头取出裸 PCM
 */

/** 把 PCM16LE 裸数据封成 WAV 文件 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt 块长度
  header.writeUInt16LE(1, 20); // PCM 编码
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 裸 PCM 数据 */
  data: Buffer;
}

/**
 * 解析 WAV 文件,遍历 RIFF 块(兼容 LIST 等附加块)。
 * 非法或不支持的格式返回 null。
 */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      const end = Math.min(body + size, buf.length);
      data = buf.subarray(body, end);
    }
    // 块按 2 字节对齐
    off = body + size + (size % 2);
  }
  if (data === null || sampleRate === 0) return null;
  return { sampleRate, channels: channels || 1, bitsPerSample: bitsPerSample || 16, data };
}

/**
 * PCM16LE 单声道线性插值重采样。
 * 仅用于兜底(同一轮 TTS 中不同句子采样率不一致时对齐到 tts.begin 声明值)。
 */
export function resamplePcm16(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to || pcm.length < 4) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.max(1, Math.round((inSamples * to) / from));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = outSamples === 1 ? 0 : (i * (inSamples - 1)) / (outSamples - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - i0;
    const v = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

/** 把立体声 PCM16 混合为单声道(极少数服务商 wav 返回双声道时兜底) */
export function stereoToMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = pcm.readInt16LE(i * 4);
    const r = pcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.round((l + r) / 2), i * 2);
  }
  return out;
}
