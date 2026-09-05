export type AssistantState = 'offline' | 'pairing' | 'login' | 'idle' | 'sleep' | 'wake' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error';
export interface Voxel { x: number; y: number; z: number; material: number }
export interface ProjectedVoxel extends Voxel { sx: number; sy: number; depth: number; size: number }
export interface Pose { yaw: number; pitch: number; lift: number; squash: number }

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
    '...###############...',
    '....#############....',
    '....#############....',
    '....##############...',
    '....###############..',
    '....###############..',
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

export function poseFor(state: AssistantState, clock: number, tiltX: number, tiltY: number, level: number): Pose {
    const sleepy = state === 'sleep' || state === 'muted';
    return {
        yaw: clamp(tiltX, -1, 1) * 0.66 + Math.sin(clock / 3400) * 0.06,
        pitch: clamp(tiltY, -1, 1) * 0.28 + (state === 'thinking' ? -0.09 : 0),
        lift: Math.sin(clock / (sleepy ? 1500 : 760)) * (state === 'wake' ? 8 : 3),
        squash: sleepy ? 0.84 : state === 'speaking' ? 1 + clamp(level, 0, 100) * 0.0008 : 1,
    };
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
    return CAT_SURFACE.map((voxel) => projectPoint(voxel, pose, scale, cx, cy)).sort((a, b) => a.depth - b.depth);
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
        } else {
            for (let i = 0; i < (state === 'wake' ? 4 : 3); i++) put(eyeX, i - 2);
        }
    }
    if (state === 'speaking') {
        const open = 1 + Math.floor(clamp(level, 0, 100) / 35) + Math.round(Math.abs(Math.sin(clock / 130)));
        for (let y = 3; y < 3 + open; y++) for (let x = -1; x <= 1; x++) put(x, y);
    } else if (state !== 'sleep') {
        put(-1, 3); put(0, 4); put(1, 3);
    }
    return pixels;
}
