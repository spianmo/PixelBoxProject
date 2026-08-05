/**
 * STT 适配器:OpenAI 兼容 POST {base}/audio/transcriptions(multipart)。
 * 输入为裸 PCM16LE,这里封成 WAV 再上传。
 * 兼容 OpenAI whisper-1 / 硅基流动 SenseVoiceSmall 等。
 */
import { config } from '../config.js';
import { pcmToWav } from '../wav.js';
import { signalWithTimeout } from '../util.js';

interface TranscriptionResp {
  text?: string;
}

/**
 * 语音转文字。
 * @param pcm PCM16LE 单声道裸数据
 * @param sampleRate 采样率(来自 session.start,默认 16000)
 * @param signal 外部中止信号(interrupt / 连接关闭)
 * @returns 识别文本(可能为空串)
 */
export async function transcribe(pcm: Buffer, sampleRate: number, signal?: AbortSignal): Promise<string> {
  const wav = pcmToWav(pcm, sampleRate);
  const form = new FormData();
  // Buffer 可能共享底层池,精确切出视图再构造 Blob
  const bytes = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', config.stt.model);
  if (config.stt.language !== '') form.append('language', config.stt.language);

  const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.stt.apiKey}` },
    body: form,
    signal: signalWithTimeout(signal, config.stt.timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`STT 请求失败 HTTP ${res.status}: ${detail}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    const json = (await res.json()) as TranscriptionResp;
    return (json.text ?? '').trim();
  }
  // 部分服务商 response_format=text 时直接返回纯文本
  return (await res.text()).trim();
}
