export type AssistantState = 'offline' | 'pairing' | 'login' | 'idle' | 'sleep' | 'wake' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error';
export interface Voxel { x: number; y: number; z: number; material: number }
export interface ProjectedVoxel extends Voxel { sx: number; sy: number; depth: number; size: number }
export const CAT_SHAPES = ['idle', 'peek', 'stretch', 'curl', 'sit', 'alert', 'listen', 'think', 'talk', 'rest', 'error'] as const;
export type CatShape = typeof CAT_SHAPES[number];
export interface Pose { yaw: number; pitch: number; lift: number; squash: number; shape?: CatShape; weights?: Float32Array }

// 从用户多视角参考提取正面轮廓：双尖耳、方形脸、短胸部；第三维为前后厚度。
const FRONT = [
    '.....................',
    '...#.............#...',
    '...##...........##...',
    '...###.........###...',
    '...####.......####...',
    '...###############...',
    '..#################..',
    '..#################..',
    '..#################..',
    '.###################.',
    '.###################.',
    '.###################.',
    '..#################..',
    '..#################..',
    '..#################..',
    '...###############...',
    '....#############....',
    '.....###########.....',
    '.....###########.....',
    '.....................',
    '.....................',
];

export function buildCatVolume(): number[][][] {
    const volume = Array.from({ length: 13 }, () => Array.from({ length: 21 }, () => Array<number>(21).fill(0)));
    for (let z = 0; z < 13; z++) {
        const edge = Math.abs(z - 6);
        for (let y = 0; y < 21; y++) {
            for (let x = 0; x < 21; x++) {
                if (FRONT[y][x] !== '#') continue;
                // 端面收缩一格，形成真实厚度；耳朵前后贯通，侧视保留耳峰。
                if (edge >= 5 && (FRONT[y][x - 1] !== '#' || FRONT[y][x + 1] !== '#')) continue;
                if (edge === 6 && y >= 18) continue;
                volume[z][y][x] = 1;
            }
        }
    }
    return volume;
}

export const CAT_VOLUME = buildCatVolume();

export function surfaceVoxels(volume: number[][][]): Voxel[] {
    const voxels: Voxel[] = [];
    for (let z = 0; z < volume.length; z++) {
        const layer = volume[z];
        const previousLayer = z > 0 ? volume[z - 1] : undefined;
        const nextLayer = z + 1 < volume.length ? volume[z + 1] : undefined;
        for (let y = 0; y < layer.length; y++) {
            const row = layer[y];
            const previousRow = y > 0 ? layer[y - 1] : undefined;
            const nextRow = y + 1 < layer.length ? layer[y + 1] : undefined;
            for (let x = 0; x < row.length; x++) {
                const material = row[x];
                if (!material) continue;

                // Avoid a closure, a temporary neighbor array, and Array#every for each voxel.
                // Optional row lookups preserve the original behavior for ragged volumes.
                const enclosed = x > 0 && !!row[x - 1]
                    && x + 1 < row.length && !!row[x + 1]
                    && !!previousRow?.[x]
                    && !!nextRow?.[x]
                    && !!previousLayer?.[y]?.[x]
                    && !!nextLayer?.[y]?.[x];
                if (enclosed) continue;
                voxels.push({ x: x - 10, y: y - 10, z: z - 6, material });
            }
        }
    }
    return voxels;
}

export const CAT_SURFACE = surfaceVoxels(CAT_VOLUME);
// 同一原始 y 层、x 正负半区内的所有形变均为仿射变换。
// 透视投影的极值位于截面凸包顶点，fit 无需再完整投影 1008 个外壳点。
function boundaryIndices(): Uint32Array {
    const groups = new Map<string, number[]>();
    for (let i = 0; i < CAT_SURFACE.length; i++) {
        const p = CAT_SURFACE[i], key = `${p.y}:${p.x > 0}`;
        let group = groups.get(key);
        if (!group) { group = []; groups.set(key, group); }
        group.push(i);
    }
    const selected = new Set<number>();
    for (const group of groups.values()) {
        group.sort((a, b) => CAT_SURFACE[a].x - CAT_SURFACE[b].x || CAT_SURFACE[a].z - CAT_SURFACE[b].z);
        const hull: number[] = [];
        const put = (i: number) => {
            const p = CAT_SURFACE[i];
            while (hull.length > 1) {
                const a = CAT_SURFACE[hull[hull.length - 2]], b = CAT_SURFACE[hull[hull.length - 1]];
                if ((b.x - a.x) * (p.z - b.z) - (b.z - a.z) * (p.x - b.x) > 0) break;
                hull.pop();
            }
            hull.push(i);
        };
        for (const i of group) put(i);
        for (const i of hull) selected.add(i);
        hull.length = 0;
        for (let i = group.length - 1; i >= 0; i--) put(group[i]);
        for (const i of hull) selected.add(i);
    }
    return Uint32Array.from(selected);
}
export const CAT_BOUNDARY_INDICES = boundaryIndices();
export const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));

// 放大 IMU 转向幅度；静态姿态与形态过渡使用相同角度，避免切换状态时响应突变。
const IMU_YAW = 1.2;
const IMU_PITCH = 0.6;

// X/Y 原始加速度（含重力投影，单位 g）合成故障强度，正负方向等效。
// 0.06g 内忽略微抖，1.5g 达到最强；不要使用已经为转向钳制过的输入。
export function imuGlitch(ax: number, ay: number): number {
    const x = Number.isFinite(ax) ? ax : 0, y = Number.isFinite(ay) ? ay : 0;
    return clamp((Math.hypot(x, y) - 0.06) / 1.44, 0, 1);
}

export function poseFor(state: AssistantState, clock: number, tiltX: number, tiltY: number, level: number, idleShape: CatShape = 'idle'): Pose {
    const sleepy = state === 'sleep' || state === 'muted';
    const shape: CatShape = sleepy ? 'rest' : state === 'wake' ? 'alert' : state === 'listening' ? 'listen'
        : state === 'thinking' ? 'think' : state === 'speaking' ? 'talk' : state === 'error' ? 'error' : state === 'idle' ? idleShape : 'idle';
    return {
        shape,
        yaw: clamp(tiltX, -1, 1) * IMU_YAW + (shape === 'think' ? -0.32 : shape === 'listen' ? 0.12 : shape === 'peek' ? -0.35 : shape === 'sit' ? 0.3 : 0),
        pitch: clamp(tiltY, -1, 1) * IMU_PITCH + (state === 'thinking' ? -0.06 : 0),
        lift: Math.sin(clock / (sleepy ? 1500 : state === 'speaking' ? 240 : 760)) * (state === 'wake' ? 8 : state === 'speaking' ? 4 : 3),
        squash: state === 'speaking' ? 0.96 + clamp(level, 0, 100) * 0.0012 + Math.sin(clock / 150) * 0.035 : 1,
    };
}

export function shapePoint(voxel: Voxel, shape: CatShape = 'idle'): Voxel {
    let { x, y, z } = voxel;
    // Thin relief keeps the reference silhouette readable as IMU changes the view.
    z *= 0.42;
    if (shape === 'peek' || shape === 'think') {
        x = x * 0.86 + (y < 1 ? -1.8 : (y - 1) * 0.45 - 1.8);
        y *= 0.94;
    } else if (shape === 'stretch' || shape === 'sit') {
        if (y > 2) x = x * (8 / Math.max(3, 10 - y)) + (shape === 'sit' ? 1.2 : 0);
        x *= 0.83; y *= 1.06;
    } else if (shape === 'curl' || shape === 'rest') { x *= 1.06; y = y * 0.74 + 1.5; }
    else if (shape === 'alert' || shape === 'listen') { x *= 0.93; if (y < -5) y -= (x > 0 ? 1 : 0); }
    else if (shape === 'talk') { x *= 1.02; y *= 0.94; }
    else if (shape === 'error') { x += y * -0.12; y *= 0.96; }
    return { x: Math.fround(x), y: Math.fround(y), z: Math.fround(z), material: voxel.material };
}

export function posedShapePoint(voxel: Voxel, pose: Pose): Voxel {
    if (!pose.weights) return shapePoint(voxel, pose.shape);
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < CAT_SHAPES.length; i++) {
        const weight = pose.weights[i];
        if (!weight) continue;
        const point = shapePoint(voxel, CAT_SHAPES[i]);
        x += point.x * weight; y += point.y * weight; z += point.z * weight;
    }
    return { x: Math.fround(x), y: Math.fround(y), z: Math.fround(z), material: voxel.material };
}

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
        // target由poseFor在本次调用内创建；显式复制固定字段，保持返回对象与current隔离。
        const result: Pose = { shape: target.shape, yaw: target.yaw + clamp(tiltX, -1, 1) * IMU_YAW,
            pitch: target.pitch + clamp(tiltY, -1, 1) * IMU_PITCH, lift: target.lift, squash: target.squash };
        if (target.weights) result.weights = target.weights;
        return result;
    }
}

export function projectionAngles(pose: Pose) {
    return { cosYaw: Math.cos(pose.yaw), sinYaw: Math.sin(pose.yaw), cosPitch: Math.cos(pose.pitch), sinPitch: Math.sin(pose.pitch) };
}

export function projectPoint(voxel: Voxel, pose: Pose, scale: number, cx: number, cy: number,
    angles = projectionAngles(pose)): ProjectedVoxel {
    // 同一帧面部复用四个三角函数，保留原来的 double 乘加次序与最后取整。
    const { cosYaw, sinYaw, cosPitch, sinPitch } = angles;
    const x = voxel.x * cosYaw + voxel.z * sinYaw;
    const z = -voxel.x * sinYaw + voxel.z * cosYaw;
    const y = voxel.y * pose.squash * cosPitch - z * sinPitch;
    const depth = voxel.y * sinPitch + z * cosPitch;
    const perspective = 64 / (64 - depth);
    return { ...voxel, sx: Math.round(cx + x * scale * perspective), sy: Math.round(cy + y * scale * perspective + pose.lift), depth, size: Math.ceil(scale * perspective) + 1 };
}

export function projectCat(pose: Pose, scale: number, cx: number, cy: number): ProjectedVoxel[] {
    // 只排序外壳，避免每帧投影几千个不可见体素；深度从远到近覆盖。
    return CAT_SURFACE.map((voxel) => projectPoint(posedShapePoint(voxel, pose), pose, scale, cx, cy)).sort((a, b) => a.depth - b.depth);
}

const rasterX = new Int32Array(CAT_SURFACE.length);
const rasterY = new Int32Array(CAT_SURFACE.length);
const shapeCache: Partial<Record<CatShape, Float32Array>> = {};
const shapePending: Partial<Record<CatShape, { points: Float32Array; used: number }>> = {};
const projectedGrid = new Int32Array(CAT_SURFACE.length * 2);
const projectedRuns = new Int32Array(CAT_SURFACE.length * 3);
const projectedBounds = new Int32Array(4);
const blendedPoints = new Float32Array(CAT_SURFACE.length * 3);
let blendInputs: Float32Array[] | undefined;
let blendWeights = new Float32Array(0);
function packedShape(shape: CatShape): Float32Array {
    let points = shapeCache[shape];
    if (points) return points;
    const pending = shapePending[shape];
    points = pending?.points || new Float32Array(CAT_SURFACE.length * 3);
    for (let i = pending?.used || 0; i < CAT_SURFACE.length; i++) {
        const voxel = shapePoint(CAT_SURFACE[i], shape);
        points[i * 3] = voxel.x; points[i * 3 + 1] = voxel.y; points[i * 3 + 2] = voxel.z;
    }
    shapeCache[shape] = points;
    delete shapePending[shape];
    return points;
}
export function prepareCat(pose?: Pose, maxPoints = 32): boolean {
    // 实时绘制前分批生成所需姿态；整个调用共用点数预算，切换形态不会阻塞采音。
    // 缓存只有完整时才公开，尚未准备好的帧由调用方保留上一画面。
    if (!blendInputs) blendInputs = [];
    if (!pose) return true;
    let remaining = Math.max(1, Math.floor(maxPoints));
    const shape = pose.shape || 'idle', hasWeights = pose.weights;
    // 已预热的单形态是常规帧路径；保留shape→weights读取顺序，不再分配临时数组。
    if (!hasWeights && shapeCache[shape]) return true;
    const wanted: CatShape[] = [shape];
    if (hasWeights) for (let i = 0; i < CAT_SHAPES.length; i++) {
        if (pose.weights![i] && !wanted.includes(CAT_SHAPES[i])) wanted.push(CAT_SHAPES[i]);
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
let occupancy = new Uint8Array(4096);
const raster = {
    step: 0, count: 0, runs: projectedRuns,
};

// 同一帧拟合与最终投影共享形态缓存和混合缓冲，避免重复混合全部外壳点。
export function packedCat(pose: Pose): Float32Array {
    let packedPoints = packedShape(pose.shape || 'idle');
    if (pose.weights) {
        // 过渡只预热实际参与的姿态。启动阶段不再一次性 map 全部 11 种形态，
        // 否则会在 NuttX QuickJS 的单轮执行预算内被中断。
        let active = 0;
        for (let i = 0; i < CAT_SHAPES.length; i++) if (pose.weights[i]) active++;
        if (active && typeof px !== 'undefined' && px.util && typeof px.util.blendPoints === 'function') {
            // 只传实际参与的姿态，首个过渡即可使用原生混合，不等全部 11 种缓存齐备。
            // 顺序与 JS 逐次 Float32 累加一致，保留打断过渡时的数学定义。
            prepareCat();
            blendInputs!.length = active;
            if (blendWeights.length !== active) blendWeights = new Float32Array(active);
            for (let i = 0, slot = 0; i < CAT_SHAPES.length; i++) if (pose.weights[i]) {
                blendInputs![slot] = packedShape(CAT_SHAPES[i]);
                blendWeights[slot++] = pose.weights[i];
            }
            px.util.blendPoints(blendInputs!, blendWeights, blendedPoints);
        } else {
            blendedPoints.fill(0);
            for (let i = 0; i < CAT_SHAPES.length; i++) {
                const weight = pose.weights[i];
                if (!weight) continue;
                const points = packedShape(CAT_SHAPES[i]);
                for (let j = 0; j < points.length; j++) blendedPoints[j] += points[j] * weight;
            }
        }
        packedPoints = blendedPoints;
    }
    return packedPoints;
}

export function catProjectionBounds(pose: Pose, scale: number, cx: number, cy: number, points: Float32Array): Int32Array | undefined {
    if (typeof px === 'undefined' || !px.util || typeof px.util.projectPointBounds !== 'function') return;
    px.util.projectPointBounds(points, { yaw: pose.yaw, pitch: pose.pitch, squash: pose.squash, lift: pose.lift,
        scale, cx, cy, grid: Math.max(2, Math.round(scale)) }, projectedBounds, CAT_BOUNDARY_INDICES);
    return projectedBounds;
}

export function rasterizeCat(pose: Pose, scale: number, cx: number, cy: number, points?: Float32Array): typeof raster {
    const packedPoints = points || packedCat(pose);
    const step = Math.max(2, Math.round(scale));
    if (typeof px !== 'undefined' && px.util && typeof px.util.projectPointRuns === 'function') {
        raster.step = step;
        raster.count = px.util.projectPointRuns(packedPoints, { ...pose, scale, cx, cy, grid: step }, projectedRuns);
        return raster;
    }
    const native = typeof px !== 'undefined' && px.util && typeof px.util.projectPoints === 'function';
    if (native) px.util.projectPoints(packedPoints, { ...pose, scale, cx, cy, grid: step }, projectedGrid);
    const cosYaw = native ? 0 : Math.cos(pose.yaw), sinYaw = native ? 0 : Math.sin(pose.yaw);
    const cosPitch = native ? 0 : Math.cos(pose.pitch), sinPitch = native ? 0 : Math.sin(pose.pitch);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < CAT_SURFACE.length; i++) {
        let gx: number, gy: number;
        if (native) {
            gx = projectedGrid[i * 2]; gy = projectedGrid[i * 2 + 1];
        } else {
            const vx = packedPoints[i * 3], vy = packedPoints[i * 3 + 1], vz = packedPoints[i * 3 + 2];
            const x = vx * cosYaw + vz * sinYaw;
            const z = -vx * sinYaw + vz * cosYaw;
            const y = vy * pose.squash * cosPitch - z * sinPitch;
            const depth = vy * sinPitch + z * cosPitch;
            const perspective = 64 / (64 - depth);
            gx = Math.round(Math.round(cx + x * scale * perspective) / step);
            gy = Math.round(Math.round(cy + y * scale * perspective + pose.lift) / step);
        }
        rasterX[i] = gx; rasterY[i] = gy;
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const cells = width * height;
    if (occupancy.length < cells) occupancy = new Uint8Array(cells);
    else occupancy.fill(0, 0, cells);
    for (let i = 0; i < rasterX.length; i++) occupancy[(rasterY[i] - minY) * width + rasterX[i] - minX] = 1;
    raster.step = step; raster.count = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width;) {
            if (!occupancy[y * width + x]) { x++; continue; }
            const start = x;
            while (x < width && occupancy[y * width + x]) x++;
            const i = raster.count++ * 3;
            projectedRuns[i] = start + minX;
            projectedRuns[i + 1] = y + minY;
            projectedRuns[i + 2] = x - start;
        }
    }
    return raster;
}

export function facePoints(state: AssistantState, clock: number, level: number): Voxel[] {
    const pixels: Voxel[] = [];
    const put = (x: number, y: number) => pixels.push({ x, y, z: 6.7, material: 2 });
    const closed = state === 'sleep' || state === 'muted' || clock % 5300 < 140;
    for (const eyeX of [-4, 3]) {
        if (state === 'error') {
            for (let i = 0; i < 3; i++) { put(eyeX + i, i - 2); put(eyeX + i, -i); }
        } else if (closed) {
            for (let i = 0; i < 3; i++) put(eyeX + i, 0);
        } else if (state === 'thinking') {
            for (let i = 0; i < 3; i++) put(eyeX - 1, i - 1);
        } else {
            for (let i = 0; i < (state === 'wake' ? 4 : 3); i++) put(eyeX, i - 1);
        }
    }
    if (state === 'speaking') {
        const open = 1 + (level > 35 && Math.sin(clock / 130) > 0 ? 1 : 0);
        for (let y = 4; y < 4 + open; y++) put(0, y);
    }
    return pixels;
}

interface FaceTemplate {
    voxels: Voxel[];
    upper: Uint8Array;
    shapes: Partial<Record<CatShape, Float32Array>>;
    blended: Float32Array;
}

export interface FaceRaster {
    count: number;
    xy: Int32Array;
    /** 原始面部体素 y < 2，用于保留彩边对眼睛的裁定。 */
    upper: Uint8Array;
}

// 表情只有 9 种组合；缓存按需建立，避免每帧生成体素及每个形态的临时对象。
const faceTemplates: (FaceTemplate | undefined)[] = [];
const faceRaster: FaceRaster = { count: 0, xy: new Int32Array(24), upper: new Uint8Array(0) };
const faceBlendInputs: Float32Array[] = [];
const faceBlendWeights = new Float32Array(CAT_SHAPES.length);

function faceTemplate(state: AssistantState, clock: number, level: number): FaceTemplate {
    const closed = state === 'sleep' || state === 'muted' || clock % 5300 < 140;
    const eye = state === 'error' ? 0 : closed ? 1 : state === 'thinking' ? 2 : state === 'wake' ? 3 : 4;
    const mouth = state === 'speaking' ? 1 + (level > 35 && Math.sin(clock / 130) > 0 ? 1 : 0) : 0;
    const key = eye * 3 + mouth;
    let template = faceTemplates[key];
    if (!template) {
        const voxels = facePoints(state, clock, level);
        template = { voxels, upper: Uint8Array.from(voxels, (voxel) => voxel.y < 2 ? 1 : 0),
            shapes: {}, blended: new Float32Array(voxels.length * 3) };
        faceTemplates[key] = template;
    }
    return template;
}

function packedFaceShape(template: FaceTemplate, shape: CatShape = 'idle'): Float32Array {
    let points = template.shapes[shape];
    if (!points) {
        points = new Float32Array(template.voxels.length * 3);
        for (let i = 0; i < template.voxels.length; i++) {
            const point = shapePoint(template.voxels[i], shape);
            points[i * 3] = point.x; points[i * 3 + 1] = point.y; points[i * 3 + 2] = point.z;
        }
        template.shapes[shape] = points;
    }
    return points;
}

/** 返回复用的面部栅格；xy 是 grid 坐标，下一次调用会覆盖结果。 */
export function rasterizeFace(state: AssistantState, clock: number, level: number, pose: Pose,
    scale: number, cx: number, cy: number, step = Math.max(2, Math.round(scale))): FaceRaster {
    const template = faceTemplate(state, clock, level);
    let points: Float32Array;
    if (pose.weights) {
        let active = 0;
        for (let i = 0; i < CAT_SHAPES.length; i++) {
            const weight = pose.weights[i];
            if (!weight) continue;
            faceBlendInputs[active] = packedFaceShape(template, CAT_SHAPES[i]);
            faceBlendWeights[active++] = weight;
        }
        points = template.blended;
        for (let j = 0; j < points.length; j += 3) {
            // posedShapePoint 逐形态用 Double 累加，只在最终写入时取 Float32；
            // 主体的 blendPoints 每次累加都会取 Float32，不能用于面部。
            let x = 0, y = 0, z = 0;
            for (let i = 0; i < active; i++) {
                const shape = faceBlendInputs[i], weight = faceBlendWeights[i];
                x += shape[j] * weight; y += shape[j + 1] * weight; z += shape[j + 2] * weight;
            }
            points[j] = x; points[j + 1] = y; points[j + 2] = z;
        }
    } else points = packedFaceShape(template, pose.shape);

    const xy = faceRaster.xy;
    if (typeof px !== 'undefined' && px.util && typeof px.util.projectPoints === 'function') {
        px.util.projectPoints(points, { yaw: pose.yaw, pitch: pose.pitch, squash: pose.squash,
            lift: pose.lift, scale, cx, cy, grid: step }, xy);
    } else {
        const { cosYaw, sinYaw, cosPitch, sinPitch } = projectionAngles(pose);
        for (let i = 0, j = 0; i < points.length; i += 3, j += 2) {
            const vx = points[i], vy = points[i + 1], vz = points[i + 2];
            const x = vx * cosYaw + vz * sinYaw;
            const z = -vx * sinYaw + vz * cosYaw;
            const y = vy * pose.squash * cosPitch - z * sinPitch;
            const depth = vy * sinPitch + z * cosPitch;
            const perspective = 64 / (64 - depth);
            // 两次舍入分别对应原 projectPoint 和 render 的网格量化，不合并。
            xy[j] = Math.round(Math.round(cx + x * scale * perspective) / step);
            xy[j + 1] = Math.round(Math.round(cy + y * scale * perspective + pose.lift) / step);
        }
    }
    faceRaster.count = template.voxels.length;
    faceRaster.upper = template.upper;
    return faceRaster;
}
