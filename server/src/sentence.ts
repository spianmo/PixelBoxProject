/**
 * 流式句子切分器:LLM 增量文本 → 完整句子,用于句子级并行 TTS。
 *
 * 策略:
 * - 强边界(。!?!?;;…换行)一到即切;
 * - 弱边界(,,、::)只有在累计长度达到阈值时才切,
 *   且首句阈值更短 —— 尽快产出第一段音频,降低首包延迟;
 * - 英文句号 "." 需排除小数(3.14)场景,且必须能看到后继字符才判定;
 * - 纯标点碎片(不含文字/数字)直接丢弃,不浪费 TTS 调用。
 */

const STRONG = new Set(['。', '!', '?', '!', '?', ';', ';', '…', '\n']);
const WEAK = new Set([',', ',', '、', ':', ':']);
/** 含有至少一个字母 / 数字 / 汉字才值得送 TTS */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

export class SentenceSplitter {
  private buf = '';
  private emitted = 0;

  constructor(
    /** 首句允许在弱边界切分的最小长度 */
    private readonly weakFirstLen = 12,
    /** 后续句子允许在弱边界切分的最小长度 */
    private readonly weakLen = 40,
  ) {}

  /** 喂入一段增量文本,返回本次新产出的完整句子(可能为空数组) */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf.charAt(i);
      const len = i - start + 1;
      let cut = false;
      if (STRONG.has(ch)) {
        cut = true;
      } else if (ch === '.') {
        const prev = i > 0 ? this.buf.charAt(i - 1) : '';
        const next = i + 1 < this.buf.length ? this.buf.charAt(i + 1) : '';
        // 后继字符尚未到达时不判定;排除 "3.14" 这类小数
        if (next !== '' && !(/[0-9]/.test(prev) && /[0-9]/.test(next))) cut = true;
      } else if (WEAK.has(ch)) {
        const threshold = this.emitted === 0 ? this.weakFirstLen : this.weakLen;
        if (len >= threshold) cut = true;
      }
      if (cut) {
        const s = this.buf.slice(start, i + 1).trim();
        if (HAS_CONTENT.test(s)) {
          out.push(s);
          this.emitted += 1;
        }
        start = i + 1;
      }
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** 流结束时取出剩余文本(无内容返回 null) */
  flush(): string | null {
    const s = this.buf.trim();
    this.buf = '';
    return HAS_CONTENT.test(s) ? s : null;
  }
}

/** 把一段完整文本(如 tts.request / voice.say)一次性切成句子数组 */
export function splitSentences(text: string): string[] {
  const sp = new SentenceSplitter();
  const out = sp.push(text);
  const rest = sp.flush();
  if (rest !== null) out.push(rest);
  return out;
}
