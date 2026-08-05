/**
 * TTS 适配器:OpenAI 兼容 POST {base}/audio/speech。
 * 优先请求 response_format=pcm(裸 PCM16LE,采样率按服务商标注 = TTS_PCM_SAMPLE_RATE);
 * 服务商不支持 pcm 时自动降级 response_format=wav,本地解头取 PCM。
 * 即使请求了 pcm,部分服务商仍会返回 WAV,这里通过 RIFF 魔数自动识别。
 */
import { config } from '../config.js';
import { parseWav, stereoToMono } from '../wav.js';
import { signalWithTimeout } from '../util.js';

export interface TtsResult {
  /** PCM16LE 单声道裸数据 */
  pcm: Buffer;
  /** 采样率 Hz */
  sampleRate: number;
}

/** 单次 /audio/speech 请求;pcm 尝试失败(HTTP 错误)时返回 null 交由上层降级 */
async function request(
  text: string,
  format: 'pcm' | 'wav',
  signal: AbortSignal | undefined,
): Promise<TtsResult | null> {
  const body: Record<string, unknown> = {
    model: config.tts.model,
    input: text,
    voice: config.tts.voice,
    response_format: format,
  };
  // 硅基流动等支持在请求中指定输出采样率
  if (config.tts.sampleRateParam > 0) body.sample_rate = config.tts.sampleRateParam;

  const res = await fetch(`${config.tts.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.tts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: signalWithTimeout(signal, config.tts.timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    if (format === 'pcm') return null; // 交给上层降级 wav
    throw new Error(`TTS 请求失败 HTTP ${res.status}: ${detail}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // 无论请求什么格式,先按魔数识别真实内容
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const wav = parseWav(buf);
    if (wav === null) throw new Error('TTS 返回的 WAV 无法解析');
    if (wav.bitsPerSample !== 16) throw new Error(`TTS WAV 位深不支持: ${wav.bitsPerSample}bit`);
    const mono = wav.channels === 2 ? stereoToMono(wav.data) : wav.data;
    return { pcm: mono, sampleRate: wav.sampleRate };
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('mpeg') || contentType.includes('mp3')) {
    throw new Error('TTS 服务商返回 mp3,无法直接推流;请确认其支持 pcm 或 wav 输出');
  }
  if (format === 'wav') {
    // 请求 wav 却拿到非 RIFF 内容
    throw new Error(`TTS 返回内容无法识别 (content-type=${contentType})`);
  }
  // 裸 PCM:采样率以配置标注为准
  return { pcm: buf, sampleRate: config.tts.pcmSampleRate };
}

/**
 * 合成一句话。先试 pcm,失败自动降级 wav。
 */
export async function synthesize(text: string, signal?: AbortSignal): Promise<TtsResult> {
  const viaPcm = await request(text, 'pcm', signal);
  if (viaPcm !== null) return viaPcm;
  const viaWav = await request(text, 'wav', signal);
  if (viaWav === null) throw new Error('TTS pcm/wav 均失败');
  return viaWav;
}
