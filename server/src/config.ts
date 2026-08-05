/**
 * 配置加载:全部来自环境变量(.env),集中在此解析并给出默认值。
 * STT / LLM / TTS 三个服务可分别指向不同的 OpenAI 兼容供应商,
 * 未单独配置时统一回落到 OPENAI_BASE_URL / OPENAI_API_KEY。
 */
import 'dotenv/config';

function env(name: string): string {
  const v = process.env[name];
  return v === undefined ? '' : v.trim();
}

function strEnv(name: string, def: string): string {
  const v = env(name);
  return v === '' ? def : v;
}

function numEnv(name: string, def: number): number {
  const v = env(name);
  if (v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 去掉末尾斜杠,拼 URL 时统一 `${baseUrl}/xxx` */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** OpenAI 兼容服务端点 */
export interface Endpoint {
  baseUrl: string;
  apiKey: string;
}

function endpoint(prefix: 'STT' | 'LLM' | 'TTS'): Endpoint {
  return {
    baseUrl: trimSlash(
      strEnv(`${prefix}_BASE_URL`, strEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')),
    ),
    apiKey: strEnv(`${prefix}_API_KEY`, strEnv('OPENAI_API_KEY', '')),
  };
}

export const config = {
  /** 监听端口(WS /realtime 与 HTTP /healthz 共用) */
  port: numEnv('PORT', 8787),
  /** 连接鉴权 token;空串表示不校验 */
  token: env('VOICE_TOKEN'),
  /** LLM 系统提示词 */
  systemPrompt: strEnv(
    'SYSTEM_PROMPT',
    '你是 PixelBox 像素盒里的语音助手,回答简洁、口语化,一般不超过三句话。',
  ),
  /** 每连接保留的最大对话轮数(1 轮 = 用户 + 助手各一条) */
  maxHistoryTurns: numEnv('MAX_HISTORY_TURNS', 8),

  stt: {
    ...endpoint('STT'),
    model: strEnv('STT_MODEL', 'whisper-1'),
    /** 识别语言提示,如 "zh";空串则由服务商自动检测 */
    language: env('STT_LANGUAGE'),
    /** 单次识别请求超时毫秒 */
    timeoutMs: numEnv('STT_TIMEOUT_MS', 30000),
  },

  llm: {
    ...endpoint('LLM'),
    model: strEnv('LLM_MODEL', 'gpt-4o-mini'),
    temperature: numEnv('LLM_TEMPERATURE', 0.7),
    /** 最大生成 token;0 表示不传该字段 */
    maxTokens: numEnv('LLM_MAX_TOKENS', 0),
    timeoutMs: numEnv('LLM_TIMEOUT_MS', 60000),
  },

  tts: {
    ...endpoint('TTS'),
    model: strEnv('TTS_MODEL', 'tts-1'),
    voice: strEnv('TTS_VOICE', 'alloy'),
    /**
     * 服务商 response_format=pcm 时的输出采样率(按服务商文档标注)。
     * OpenAI 固定 24000;硅基流动跟随请求参数。tts.begin 会携带该值下发。
     */
    pcmSampleRate: numEnv('TTS_PCM_SAMPLE_RATE', 24000),
    /**
     * >0 时在 /audio/speech 请求体附加 sample_rate 字段(硅基流动等支持);
     * OpenAI 官方不接受该字段,保持 0 即可。
     */
    sampleRateParam: numEnv('TTS_SAMPLE_RATE_PARAM', 0),
    /** 句子级并行合成的最大并发数 */
    concurrency: Math.max(1, numEnv('TTS_CONCURRENCY', 2)),
    /** 推流速度倍率(相对实时播放,0 = 不限速全速推送) */
    pushSpeed: numEnv('TTS_PUSH_SPEED', 4),
    timeoutMs: numEnv('TTS_TIMEOUT_MS', 30000),
  },

  /** 服务端静默兜底 VAD(设备未发 speech.end 时由服务器判定说完) */
  vad: {
    /** 连续静音超过该毫秒数即触发 STT */
    silenceMs: numEnv('SILENCE_FALLBACK_MS', 1500),
    /** PCM16 帧 RMS 能量低于该值视为静音 */
    energyThreshold: numEnv('VAD_ENERGY_THRESHOLD', 500),
    /** 单次收音最长毫秒数,超过强制触发 STT */
    maxUtteranceMs: numEnv('MAX_UTTERANCE_MS', 20000),
    /** 有效语音最短毫秒数,低于则丢弃本轮 */
    minSpeechMs: numEnv('MIN_SPEECH_MS', 300),
  },
} as const;

/** 启动时的配置自检,打印关键信息并对缺失项告警 */
export function reportConfig(): void {
  const mask = (k: string): string => (k === '' ? '(未配置!)' : `${k.slice(0, 6)}***`);
  console.log('[config] 端口          :', config.port);
  console.log('[config] 鉴权 token    :', config.token === '' ? '(关闭)' : '(已启用)');
  console.log('[config] STT :', config.stt.baseUrl, config.stt.model, 'key=' + mask(config.stt.apiKey));
  console.log('[config] LLM :', config.llm.baseUrl, config.llm.model, 'key=' + mask(config.llm.apiKey));
  console.log('[config] TTS :', config.tts.baseUrl, config.tts.model, `voice=${config.tts.voice}`,
    `pcm@${config.tts.pcmSampleRate}Hz`, 'key=' + mask(config.tts.apiKey));
  if (config.llm.apiKey === '') {
    console.warn('[config] 警告: 未配置 OPENAI_API_KEY / LLM_API_KEY,上游调用将失败');
  }
}
