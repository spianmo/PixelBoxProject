const FLUSH_DELAY_MS = 300;

function takePart(text: string, first: boolean, flush: boolean): string {
    let length = 0;
    let characters = 0;
    for (const character of text) {
        // 流式分片可落在 UTF-16 代理对中间，等待下一片补齐后再朗读。
        if (character.length === 1 && /[\uD800-\uDBFF]/.test(character)) break;
        length += character.length;
        characters++;
        const sentence = /[。！？!?\n]/.test(character)
            || (character === '.' && /\s/.test(text[length] || ''));
        const clause = /[，,；;：:]/.test(character);
        if (characters >= (first ? 40 : 240)
            || (sentence && characters >= (first ? 2 : 120))
            || (first && clause && characters >= 8)) return text.slice(0, length);
    }
    return flush ? text.slice(0, length) : '';
}

/** 累计字幕只提交一次；播放期间积累后续文字，实际播完后才提交下一段。 */
export class StreamingSpeech {
    private text = '';
    private submitted = '';
    private current: Promise<void> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    private ended = false;
    private failure: unknown = null;

    constructor(private readonly speak: (text: string) => Promise<void>) { }

    update(text: string): void {
        if (this.stopped || this.ended || this.failure) return;
        // finalText 可以修订尚未播出的尾部；已经提交的前缀发生变化时停止追加，避免重复朗读。
        if (!text.startsWith(this.submitted)) { this.stop(); return; }
        this.text = text;
        this.pump(false);
    }

    async finish(text: string): Promise<void> {
        this.update(text);
        this.ended = true;
        this.clearTimer();
        this.pump(true);
        while (this.current) await this.current;
        if (this.failure) throw this.failure;
    }

    stop(): void {
        this.stopped = true;
        this.text = '';
        this.clearTimer();
    }

    private clearTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    private pump(flush: boolean): void {
        if (this.stopped || this.failure || this.current) return;
        const pending = this.text.slice(this.submitted.length);
        if (!pending) return;
        const part = takePart(pending, !this.submitted, flush || this.ended);
        if (!part) {
            if (this.timer === null) this.timer = setTimeout(() => {
                this.timer = null;
                this.pump(true);
            }, FLUSH_DELAY_MS);
            return;
        }
        this.clearTimer();
        this.submitted += part;
        // 捕获同步和异步播放失败，防止等待 AI 完成期间出现未处理的 Promise 拒绝。
        this.current = Promise.resolve().then(() => {
            if (!this.stopped && part.trim()) return this.speak(part);
        }).catch((error: unknown) => {
            if (!this.stopped) this.failure = error || new Error('语音播放失败');
        }).then(() => {
            this.current = null;
            this.pump(false);
        });
    }
}
