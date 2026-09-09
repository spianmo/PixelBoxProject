const PREBUFFER_MS = 256;
const MAX_START_WAIT_MS = 512;

/** 首播和断流恢复均预缓冲，覆盖网络批次与 JS 绘制调度抖动。 */
export class BufferedPcmPlayback {
    private readonly stream: ReturnType<typeof px.audio.player.openPcmStream>;
    private pending: ArrayBuffer[] = [];
    private pendingBytes = 0;
    private started = false;
    private closed = false;
    private startTimer = 0;

    constructor(private readonly sampleRate: number) {
        this.stream = px.audio.player.openPcmStream({ sampleRate, channels: 1 });
    }

    feed(pcm: ArrayBuffer): void {
        if (this.closed || !pcm.byteLength) return;
        if (this.started && this.stream.buffered() > 0) { this.stream.feed(pcm); return; }
        // 已播空时重新积累连续音频，避免之后每个小包都伴随一次静音间隙。
        this.started = false;
        this.pending.push(pcm);
        this.pendingBytes += pcm.byteLength;
        if (this.pendingBytes >= Math.ceil(this.sampleRate * 2 * PREBUFFER_MS / 1000)) this.flush();
        else if (!this.startTimer) this.startTimer = setTimeout(() => { this.startTimer = 0; if (!this.closed) this.flush(); }, MAX_START_WAIT_MS);
    }

    private flush(): void {
        clearTimeout(this.startTimer);
        this.startTimer = 0;
        if (!this.pendingBytes) return;
        const pcm = new Uint8Array(this.pendingBytes);
        let offset = 0;
        for (const chunk of this.pending) { pcm.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
        this.pending = [];
        this.pendingBytes = 0;
        this.started = true;
        this.stream.feed(pcm.buffer);
    }

    buffered(): number { return this.pendingBytes * 1000 / (this.sampleRate * 2) + this.stream.buffered(); }
    onEnded(callback: () => void): void { this.stream.onEnded(callback); }

    end(): void {
        if (this.closed) return;
        this.closed = true;
        this.flush();
        this.stream.end();
    }

    stop(): void {
        this.closed = true;
        clearTimeout(this.startTimer);
        this.startTimer = 0;
        this.pending = [];
        this.pendingBytes = 0;
        this.stream.stop();
    }
}
