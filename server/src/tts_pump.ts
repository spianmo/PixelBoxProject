/**
 * TTS 推流泵:句子级并行合成 + 严格按顺序推流。
 *
 * - enqueue() 立即发起合成请求(受并发闸门限制),多个句子并行请求以降低首包延迟;
 * - 内部泵循环按入队顺序等待结果,保证音频顺序正确;
 * - 首段音频到达时下发 tts.begin{sampleRate},全部推完(或被打断)后下发 tts.end;
 * - 同一轮中后续句子采样率与首段不一致时,线性重采样对齐(不同服务商混用时兜底);
 * - abort() 立即停止推流(interrupt 语义),在途 fetch 由上层 AbortController 中止。
 */
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { synthesize, type TtsResult } from './adapters/tts.js';
import { resamplePcm16 } from './wav.js';
import { sleep, log, logWarn, errMsg, isAbortError } from './util.js';

export class TtsPump {
  private readonly jobs: Array<Promise<TtsResult | null>> = [];
  private finished = false;
  private aborted = false;
  private beganFlag = false;
  /** tts.end 是否已下发(abort 同步收尾与 run 异步收尾只发一次) */
  private endSent = false;
  private beginRate = 0;
  private pushedBytes = 0;
  /** 泵循环唤醒器 */
  private wakeFn: (() => void) | null = null;
  private readonly pumpDone: Promise<void>;
  /** 并发闸门 */
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly tag: string,
    /** 代次校验:会话被打断后返回 false,泵立即收尾 */
    private readonly isLive: () => boolean,
  ) {
    this.pumpDone = this.run();
  }

  /** 是否已下发 tts.begin */
  get began(): boolean {
    return this.beganFlag;
  }

  /** 累计推送的音频字节数 */
  get pushed(): number {
    return this.pushedBytes;
  }

  /** 入队一个句子,立即(受并发限制)发起合成 */
  enqueue(text: string, signal: AbortSignal): void {
    if (this.finished || this.aborted) return;
    const p = this.gated(() => synthesize(text, signal)).catch((err: unknown) => {
      if (!isAbortError(err)) logWarn(this.tag, `TTS 合成失败(跳过该句): ${errMsg(err)}`);
      return null;
    });
    this.jobs.push(p);
    this.wake();
  }

  /** 声明不再有新句子 */
  finish(): void {
    this.finished = true;
    this.wake();
  }

  /** 立即中止推流(interrupt);已发送 tts.begin 时仍会补发 tts.end 收尾 */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    // 竞态修复:abort 由 interrupt / 新一轮输入同步触发,而 run() 的收尾要等下一个
    // 微任务/定时器唤醒;若此间新一代 pump 已下发 tts.begin,设备会先收到新 begin
    // 再收到旧 end,状态机错乱。这里同步补发 tts.end(endSent 去重),保证时序:
    // 旧 tts.end 一定先于新 tts.begin 到达设备。abort 后 streamPcm 每块前都检查
    // aborted,不会再有二进制帧晚于该 tts.end 发出。
    this.sendEnd();
    this.wake();
  }

  /** 等待泵完全结束(所有音频推完或被中止) */
  wait(): Promise<void> {
    return this.pumpDone;
  }

  // ---------- 内部实现 ----------

  private async gated<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= config.tts.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private wake(): void {
    const fn = this.wakeFn;
    this.wakeFn = null;
    fn?.();
  }

  private async run(): Promise<void> {
    let next = 0;
    while (true) {
      if (this.aborted || !this.isLive()) break;
      if (next < this.jobs.length) {
        const job = this.jobs[next];
        next += 1;
        if (job === undefined) continue;
        const result = await job;
        if (this.aborted || !this.isLive()) break;
        if (result === null || result.pcm.length === 0) continue;
        let pcm = result.pcm;
        if (!this.beganFlag) {
          this.beganFlag = true;
          this.beginRate = result.sampleRate;
          this.sendJson({ type: 'tts.begin', sampleRate: this.beginRate });
        } else if (result.sampleRate !== this.beginRate) {
          logWarn(this.tag, `TTS 采样率不一致 ${result.sampleRate} → 重采样到 ${this.beginRate}`);
          pcm = resamplePcm16(pcm, result.sampleRate, this.beginRate);
        }
        await this.streamPcm(pcm);
      } else if (this.finished) {
        break;
      } else {
        // 等待新句子入队 / finish / abort
        await new Promise<void>((resolve) => {
          this.wakeFn = resolve;
        });
      }
    }
    this.sendEnd();
  }

  /** 收尾:下发 tts.end 并打印统计,abort() 与 run() 共用,endSent 保证只发一次 */
  private sendEnd(): void {
    if (!this.beganFlag || this.endSent) return;
    this.endSent = true;
    if (this.ws.readyState === this.ws.OPEN) this.sendJson({ type: 'tts.end' });
    log(this.tag, `TTS 推流结束,共 ${Math.round(this.pushedBytes / 1024)}KB${this.aborted ? '(被打断)' : ''}`);
  }

  /** 分块推送一段 PCM,带限速与 WS 背压控制 */
  private async streamPcm(pcm: Buffer): Promise<void> {
    const bytesPerSec = this.beginRate * 2;
    // 每块约 60ms 音频
    const chunkBytes = Math.max(1600, Math.floor((bytesPerSec * 0.06) / 2) * 2);
    for (let off = 0; off < pcm.length; off += chunkBytes) {
      if (this.aborted || !this.isLive() || this.ws.readyState !== this.ws.OPEN) return;
      // WS 发送缓冲背压:超过 256KB 暂停推送
      while (this.ws.bufferedAmount > 256 * 1024) {
        await sleep(20);
        if (this.aborted || this.ws.readyState !== this.ws.OPEN) return;
      }
      const end = Math.min(off + chunkBytes, pcm.length);
      this.ws.send(pcm.subarray(off, end), { binary: true });
      this.pushedBytes += end - off;
      if (config.tts.pushSpeed > 0) {
        const chunkMs = ((end - off) / bytesPerSec) * 1000;
        await sleep(chunkMs / config.tts.pushSpeed);
      }
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
