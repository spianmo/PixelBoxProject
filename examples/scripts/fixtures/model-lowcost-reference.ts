// 冻结于native19 JS小优化之前，仅保存本轮改动的两段实现；不得从被测源码重建。
// 原model.ts SHA256: 638cb0b0f3ae758c0ee0e143a6792210a4d58b214339fa427fbaf1a5dcfffc5a
import { CAT_SHAPES, CAT_SURFACE, clamp, poseFor, shapePoint, type AssistantState, type CatShape, type Pose } from '../../06-obeing-pixel/src/model';
export { CAT_SHAPES };
const IMU_YAW = 1.2, IMU_PITCH = 0.6;
// A fixed-size blend preserves continuity even when speech interrupts an idle move.
export class CatMotion {
    private state?: AssistantState;
    private shape: CatShape = 'idle';
    private nextIdle = 0;
    private started = -1000;
    private current?: Pose;
    private from?: Pose;
    private readonly weights = new Float32Array(CAT_SHAPES.length);
    private readonly source = new Float32Array(CAT_SHAPES.length);
    constructor(private readonly random: () => number = Math.random) {}

    sample(state: AssistantState, clock: number, tiltX: number, tiltY: number, level: number): Pose {
        const changed = this.state !== state;
        let idleShape = this.shape;
        if (state === 'idle' && (changed || clock >= this.nextIdle)) {
            const previous = CAT_SHAPES.indexOf(this.shape);
            const choice = Math.floor(clamp(this.random(), 0, 0.999999) * 4);
            idleShape = CAT_SHAPES[previous >= 0 && previous < 5 ? (previous + 1 + choice) % 5 : choice];
            this.nextIdle = clock + 4500 + clamp(this.random(), 0, 1) * 4000;
        }
        const target = poseFor(state, clock, 0, 0, level, idleShape);
        if (!this.current) {
            this.weights[CAT_SHAPES.indexOf(target.shape!)] = 1;
        } else if (changed || target.shape !== this.shape) {
            this.source.set(this.weights);
            this.from = { ...this.current };
            this.started = clock;
        }
        this.state = state; this.shape = target.shape!;
        const progress = clamp((clock - this.started) / 420, 0, 1);
        const ease = progress * progress * (3 - 2 * progress);
        if (this.from && progress < 1) {
            for (let i = 0; i < this.weights.length; i++) this.weights[i] = this.source[i] * (1 - ease) + (CAT_SHAPES[i] === this.shape ? ease : 0);
            for (const key of ['yaw', 'pitch', 'lift', 'squash'] as const) target[key] = this.from[key] + (target[key] - this.from[key]) * ease;
            target.weights = this.weights;
        } else {
            this.weights.fill(0); this.weights[CAT_SHAPES.indexOf(this.shape)] = 1;
            this.from = undefined;
        }
        this.current = target;
        // IMU 转向在形态过渡之后叠加，直接跟随当前倾角。
        return { ...target, yaw: target.yaw + clamp(tiltX, -1, 1) * IMU_YAW, pitch: target.pitch + clamp(tiltY, -1, 1) * IMU_PITCH };
    }
}

const shapeCache: Partial<Record<CatShape, Float32Array>> = {};
const shapePending: Partial<Record<CatShape, { points: Float32Array; used: number }>> = {};
let blendInputs: Float32Array[] | undefined;
export function prepareCat(pose?: Pose, maxPoints = 32): boolean {
    // 实时绘制前分批生成所需姿态；整个调用共用点数预算，切换形态不会阻塞采音。
    // 缓存只有完整时才公开，尚未准备好的帧由调用方保留上一画面。
    if (!blendInputs) blendInputs = [];
    if (!pose) return true;
    let remaining = Math.max(1, Math.floor(maxPoints));
    const wanted: CatShape[] = [pose.shape || 'idle'];
    if (pose.weights) for (let i = 0; i < CAT_SHAPES.length; i++) {
        if (pose.weights[i] && !wanted.includes(CAT_SHAPES[i])) wanted.push(CAT_SHAPES[i]);
    }
    for (const shape of wanted) {
        if (shapeCache[shape]) continue;
        const pending = shapePending[shape] || (shapePending[shape] = {
            points: new Float32Array(CAT_SURFACE.length * 3), used: 0,
        });
        while (remaining > 0 && pending.used < CAT_SURFACE.length) {
            const i = pending.used++, voxel = shapePoint(CAT_SURFACE[i], shape);
            pending.points[i * 3] = voxel.x;
            pending.points[i * 3 + 1] = voxel.y;
            pending.points[i * 3 + 2] = voxel.z;
            remaining--;
        }
        if (pending.used < CAT_SURFACE.length) return false;
        shapeCache[shape] = pending.points;
        delete shapePending[shape];
    }
    return true;
}
