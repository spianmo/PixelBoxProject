/**
 * LLM 适配器:OpenAI 兼容 POST {base}/chat/completions,stream=true。
 * 以异步生成器逐段产出增量文本(SSE 解析)。
 */
import { config } from '../config.js';
import { signalWithTimeout } from '../util.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
}

/**
 * 流式对话。逐段 yield 增量文本;上游异常时抛错。
 * @param messages 完整消息列表(含 system 与多轮历史)
 * @param signal 外部中止信号(interrupt 时立即断流)
 */
export async function* chatStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const body: Record<string, unknown> = {
    model: config.llm.model,
    messages,
    stream: true,
    temperature: config.llm.temperature,
  };
  if (config.llm.maxTokens > 0) body.max_tokens = config.llm.maxTokens;

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.llm.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: signalWithTimeout(signal, config.llm.timeoutMs),
  });
  if (!res.ok || res.body === null) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`LLM 请求失败 HTTP ${res.status}: ${detail}`);
  }

  const decoder = new TextDecoder();
  let buf = '';
  // Node 20 的 web ReadableStream 支持异步迭代
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload) as StreamChunk;
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta !== '') yield delta;
      } catch {
        // 忽略无法解析的 SSE 行(注释/心跳等)
      }
    }
  }
}
