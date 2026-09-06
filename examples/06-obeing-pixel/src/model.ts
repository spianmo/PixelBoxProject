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
        for (let y = 0; y < volume[z].length; y++) {
            for (let x = 0; x < volume[z][y].length; x++) {
                if (!volume[z][y][x]) continue;
                const at = (xx: number, yy: number, zz: number) => volume[zz]?.[yy]?.[xx] ?? 0;
                if ([at(x - 1, y, z), at(x + 1, y, z), at(x, y - 1, z), at(x, y + 1, z), at(x, y, z - 1), at(x, y, z + 1)].every(Boolean)) continue;
                voxels.push({ x: x - 10, y: y - 10, z: z - 6, material: volume[z][y][x] });
            }
        }
    }
    return voxels;
}

export const CAT_SURFACE = surfaceVoxels(CAT_VOLUME);
export const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));

export function poseFor(state: AssistantState, clock: number, tiltX: number, tiltY: number, level: number, idleShape: CatShape = 'idle'): Pose {
    const sleepy = state === 'sleep' || state === 'muted';
    const shape: CatShape = sleepy ? 'rest' : state === 'wake' ? 'alert' : state === 'listening' ? 'listen'
        : state === 'thinking' ? 'think' : state === 'speaking' ? 'talk' : state === 'error' ? 'error' : state === 'idle' ? idleShape : 'idle';
    return {
        shape,
        yaw: clamp(tiltX, -1, 1) * 0.9 + (shape === 'think' ? -0.32 : shape === 'listen' ? 0.12 : shape === 'peek' ? -0.35 : shape === 'sit' ? 0.3 : 0),
        pitch: clamp(tiltY, -1, 1) * 0.4 + (state === 'thinking' ? -0.06 : 0),
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
        // Sensor rotation is applied after the state morph, without interpolation.
        return { ...target, yaw: target.yaw + clamp(tiltX, -1, 1) * 0.9, pitch: target.pitch + clamp(tiltY, -1, 1) * 0.4 };
    }
}

export function projectPoint(voxel: Voxel, pose: Pose, scale: number, cx: number, cy: number): ProjectedVoxel {
    const x = voxel.x * Math.cos(pose.yaw) + voxel.z * Math.sin(pose.yaw);
    const z = -voxel.x * Math.sin(pose.yaw) + voxel.z * Math.cos(pose.yaw);
    const y = voxel.y * pose.squash * Math.cos(pose.pitch) - z * Math.sin(pose.pitch);
    const depth = voxel.y * Math.sin(pose.pitch) + z * Math.cos(pose.pitch);
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
const projectedGrid = new Int32Array(CAT_SURFACE.length * 2);
const projectedRuns = new Int32Array(CAT_SURFACE.length * 3);
const blendedPoints = new Float32Array(CAT_SURFACE.length * 3);
function packedShape(shape: CatShape): Float32Array {
    let points = shapeCache[shape];
    if (points) return points;
    points = new Float32Array(CAT_SURFACE.length * 3);
    for (let i = 0; i < CAT_SURFACE.length; i++) {
        const voxel = shapePoint(CAT_SURFACE[i], shape);
        points[i * 3] = voxel.x; points[i * 3 + 1] = voxel.y; points[i * 3 + 2] = voxel.z;
    }
    shapeCache[shape] = points;
    return points;
}
export function prepareCat(): void {
    for (const shape of CAT_SHAPES) packedShape(shape);
}
let occupancy = new Uint8Array(4096);
const raster = {
    step: 0, count: 0, pixels: 0,
    x: new Int32Array(CAT_SURFACE.length),
    y: new Int32Array(CAT_SURFACE.length),
    width: new Int32Array(CAT_SURFACE.length),
};

// Reused workspace, consumed synchronously by drawCat. All shell pixels share
// one material, so their union needs neither depth sorting nor string-keyed maps.
export function rasterizeCat(pose: Pose, scale: number, cx: number, cy: number): typeof raster {
    let packedPoints = packedShape(pose.shape || 'idle');
    if (pose.weights) {
        blendedPoints.fill(0);
        for (let i = 0; i < CAT_SHAPES.length; i++) {
            const weight = pose.weights[i];
            if (!weight) continue;
            const points = packedShape(CAT_SHAPES[i]);
            for (let j = 0; j < points.length; j++) blendedPoints[j] += points[j] * weight;
        }
        packedPoints = blendedPoints;
    }
    const cosYaw = Math.cos(pose.yaw), sinYaw = Math.sin(pose.yaw);
    const cosPitch = Math.cos(pose.pitch), sinPitch = Math.sin(pose.pitch);
    const step = Math.max(2, Math.round(scale));
    if (typeof px !== 'undefined' && px.util && typeof px.util.projectPointRuns === 'function') {
        raster.step = step; raster.pixels = 0;
        raster.count = px.util.projectPointRuns(packedPoints, { ...pose, scale, cx, cy, grid: step }, projectedRuns);
        for (let i = 0; i < raster.count; i++) {
            raster.x[i] = projectedRuns[i * 3] * step;
            raster.y[i] = projectedRuns[i * 3 + 1] * step;
            raster.width[i] = projectedRuns[i * 3 + 2] * step;
            raster.pixels += projectedRuns[i * 3 + 2];
        }
        return raster;
    }
    const native = typeof px !== 'undefined' && px.util && typeof px.util.projectPoints === 'function';
    if (native) px.util.projectPoints(packedPoints, { ...pose, scale, cx, cy, grid: step }, projectedGrid);
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
    raster.step = step; raster.count = 0; raster.pixels = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width;) {
            if (!occupancy[y * width + x]) { x++; continue; }
            const start = x;
            while (x < width && occupancy[y * width + x]) x++;
            const i = raster.count++;
            raster.x[i] = (start + minX) * step;
            raster.y[i] = (y + minY) * step;
            raster.width[i] = (x - start) * step;
            raster.pixels += x - start;
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
