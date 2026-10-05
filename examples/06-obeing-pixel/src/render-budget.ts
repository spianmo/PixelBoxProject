/** 绘制与采音共用 JS 线程；按实际耗时给其它回调留出执行窗口。 */
export class RenderBudget {
    private finishedAt = -Infinity;
    private cost = 0;

    ready(now: number, realtime: boolean, pendingAudio = false): boolean {
        if (realtime && pendingAudio) return false;
        // 普通动画最多占用一半回调时间；语音期留出两倍绘制时长，且至少 64ms。
        // 30 FPS 是目标上限，不能让慢设备连续积压绘制而饿死未知的音频订阅者。
        const reserve = realtime ? Math.max(64, this.cost * 2) : this.cost;
        return now - this.finishedAt >= reserve;
    }

    complete(startedAt: number, finishedAt: number): void {
        this.finishedAt = finishedAt;
        this.cost = Math.max(0, finishedAt - startedAt);
    }
}
