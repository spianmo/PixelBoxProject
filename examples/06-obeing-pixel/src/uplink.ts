/** 原生 WS 只有 16 个发送槽。暂时满时保留顺序重试，不把背压当作断线。 */
export class BufferedUplink {
    private queue: (string | ArrayBuffer)[] = [];
    private audioBytes = 0;
    private timer = 0;
    private busySince: number | null = null;
    private closed = false;

    constructor(private write: (data: string | ArrayBuffer) => void,
        private failed: (reason: string) => void,
        private audioCongested: () => void) {}

    audio(pcm: ArrayBuffer): void {
        if (this.closed) return;
        if (this.audioBytes + pcm.byteLength > 64000) {
            // 实时语音不能无限排队，也不应因媒体积压撤掉正常的设备连接。
            // 丢弃本轮尚未发送的 PCM，由上层显式重置识别，控制消息仍按序发送。
            this.clearAudio();
            this.audioCongested();
            return;
        }
        this.queue.push(pcm.slice(0));
        this.audioBytes += pcm.byteLength;
        // 缓冲同一轮 JS 调度里到达的采音回调，给网络任务留出执行机会。
        this.schedule();
    }

    control(message: Record<string, unknown>): void {
        if (this.closed) return;
        if (this.queue.length >= 80) { this.fail('手机连接持续拥堵，正在重新连接'); return; }
        this.queue.push(JSON.stringify(message));
        if (!this.timer) this.flush();
    }

    pendingAudio(): boolean { return this.audioBytes > 0; }

    clearAudio(): void {
        // 切账号/取消时丢弃尚未提交的旧 PCM；后续 ACK 仍排在已提交消息之后。
        this.queue = this.queue.filter((item) => typeof item === 'string');
        this.audioBytes = 0;
    }

    close(): void {
        this.closed = true;
        clearTimeout(this.timer);
        this.timer = 0;
        this.queue = [];
        this.audioBytes = 0;
    }

    private schedule(): void {
        if (!this.timer && !this.closed) this.timer = setTimeout(() => { this.timer = 0; this.flush(); }, 16);
    }

    private flush(): void {
        for (let sent = 0; sent < 4 && this.queue.length && !this.closed; sent++) {
            const item = this.queue[0];
            try { this.write(item); }
            catch (error) {
                if (String(error).includes('WebSocket 发送队列已满')) {
                    const now = px.system.now();
                    if (this.busySince === null) this.busySince = now;
                    // 原生网络操作最多等待 10 秒，控制队列需留出其收尾余量；
                    // 期间媒体仍受两秒上限约束，拥堵时停麦恢复，不无限积压 PCM。
                    if (now - this.busySince >= 15000) { this.fail('手机连接持续拥堵，正在重新连接'); return; }
                    this.schedule();
                    return;
                }
                this.fail('手机连接已中断，正在重新连接');
                return;
            }
            this.busySince = null;
            this.queue.shift();
            if (typeof item !== 'string') this.audioBytes -= item.byteLength;
        }
        if (this.queue.length) this.schedule();
    }

    private fail(reason: string): void { this.close(); this.failed(reason); }
}
