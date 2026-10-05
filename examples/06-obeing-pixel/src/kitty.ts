import { clamp, type AssistantState, type Pose } from './model';
import type { KittyCharacter } from './characters';
import type { Screen } from './layout';
import { fillRectLayers } from '../../../sdk/src/run-layers';
import { KITTY_PALETTE, KITTY_PATTERNS, type KittyPattern } from './kitty-patterns';

interface Columns { offsets: Uint16Array; runs: Int32Array }
interface Sprite { width: number; height: number; open: Columns; closed: Columns }
interface Geometry { rects: Int32Array; count: number; minX: number; minY: number; maxX: number; maxY: number }
interface Bounds { left: number; top: number; right: number; bottom: number }
interface PaintedKitty {
    screen: Screen; width: number; height: number; geometry: Geometry;
    x: number; y: number; step: number; shadowX: number; shadowY: number; top: number; bottom: number;
}
const sprites: Partial<Record<KittyCharacter, Sprite>> = {};
const geometryCache = new Map<string, Geometry>();
const paintings = new WeakMap<Bounds, PaintedKitty>();

// 图纸只解码一次，按列保存连续同色色段；闭眼也预先编码，不在每个采样点查眼睛。
function columnsFor(pattern: KittyPattern, left: number, top: number, width: number, height: number, closed: boolean): Columns {
    const offsets = new Uint16Array(width + 1), runs: number[] = [];
    for (let x = 0; x < width; x++) {
        offsets[x] = runs.length;
        let start = 0, previous = '.';
        for (let y = 0; y <= height; y++) {
            let pixel = y < height ? pattern.rows[y + top][x + left] : '.';
            if (closed && pixel === '#') {
                for (const eye of pattern.eyes) {
                    if (x + left >= eye.x && x + left < eye.x + eye.width && y + top >= eye.y && y + top < eye.y + eye.height - 1) { pixel = 'w'; break; }
                }
            }
            if (pixel === previous) continue;
            if (previous !== '.') runs.push(start, y, KITTY_PALETTE[previous]);
            start = y; previous = pixel;
        }
    }
    offsets[width] = runs.length;
    return { offsets, runs: new Int32Array(runs) };
}

function spriteFor(character: KittyCharacter): Sprite {
    const cached = sprites[character];
    if (cached) return cached;
    const pattern = KITTY_PATTERNS[character];
    let left = pattern.rows[0].length, top = pattern.rows.length, right = 0, bottom = 0;
    for (let y = 0; y < pattern.rows.length; y++) for (let x = 0; x < pattern.rows[y].length; x++) {
        if (pattern.rows[y][x] === '.') continue;
        if (x < left) left = x;
        if (x >= right) right = x + 1;
        if (y < top) top = y;
        if (y >= bottom) bottom = y + 1;
    }
    // 只裁透明边距，保留源图的头身比例、配饰位置及格子宽高；缓存供每帧复用。
    const width = right - left, height = bottom - top;
    return sprites[character] = { width, height,
        open: columnsFor(pattern, left, top, width, height, false),
        closed: columnsFor(pattern, left, top, width, height, true) };
}

// 每次绘制复用整数采样格矩形，避免逐帧分配数百个对象并触发GC。
let previousColumn = new Int32Array(128), currentColumn = new Int32Array(128);
let geometryScratch = new Int32Array(1024 * 5);
const shadowLayers = new Int32Array(3);
const emptyLayers = new Int32Array();

function geometryFor(sprite: Sprite, character: KittyCharacter, closed: boolean, yaw: number, pitch: number,
    width: number, height: number, step: number, samples: number, columns: Columns,
    cosYaw: number, shearY: number, cosPitch: number): Geometry {
    const key = `${character}|${closed ? 1 : 0}|${yaw}|${pitch}|${width}|${height}|${step}|${samples}`;
    const known = geometryCache.get(key);
    if (known) {
        geometryCache.delete(key);
        geometryCache.set(key, known);
        return known;
    }
    const runs = columns.runs;
    const capacity = Math.ceil(runs.length / 3 * samples * 5);
    if (geometryScratch.length < capacity) geometryScratch = new Int32Array(capacity);
    const work = geometryScratch;
    let count = 0, previousCount = 0;
    let minX = width * samples, minY = height * samples, maxX = 0, maxY = 0;
    for (let x = 0; x < width * samples; x++) {
        const sx = ((x + 0.5) / samples - width / 2) / cosYaw;
        const sourceX = Math.floor(sx + sprite.width / 2);
        let currentCount = 0, prior = 0;
        if (sourceX >= 0 && sourceX < sprite.width) {
            const offsetY = height / 2 + shearY * sx - cosPitch * sprite.height / 2;
            for (let i = columns.offsets[sourceX]; i < columns.offsets[sourceX + 1]; i += 3) {
                let y = Math.ceil((offsetY + cosPitch * runs[i]) * samples - 0.5);
                let end = Math.ceil((offsetY + cosPitch * runs[i + 1]) * samples - 0.5);
                if (y < 0) y = 0;
                if (end > height * samples) end = height * samples;
                if (end <= y) continue;
                const color = runs[i + 2];
                while (prior < previousCount && work[previousColumn[prior] + 1] < y) prior++;
                const match = prior < previousCount ? previousColumn[prior] : -1;
                let at: number;
                if (match >= 0 && work[match + 1] === y && work[match + 3] === end - y && work[match + 4] === color) {
                    at = match; work[at + 2]++;
                } else {
                    at = count++ * 5;
                    work[at] = x; work[at + 1] = y; work[at + 2] = 1;
                    work[at + 3] = end - y; work[at + 4] = color;
                }
                currentColumn[currentCount++] = at;
                if (x < minX) minX = x;
                if (x + 1 > maxX) maxX = x + 1;
                if (y < minY) minY = y;
                if (end > maxY) maxY = end;
            }
        }
        const swap = previousColumn; previousColumn = currentColumn; currentColumn = swap;
        previousCount = currentCount;
    }
    const resultRects = new Int32Array(count * 5);
    resultRects.set(work.subarray(0, count * 5));
    const result: Geometry = { rects: resultRects, count, minX, minY, maxX, maxY };
    geometryCache.set(key, result);
    if (geometryCache.size > 48) geometryCache.delete(geometryCache.keys().next().value!);
    return result;
}

export function drawKitty(screen: Screen, character: KittyCharacter, state: AssistantState, clock: number,
    pose: Pose, cx: number, cy: number, scale: number, region?: { top: number; bottom: number },
    previous?: Bounds, beforeDraw?: () => void): Bounds {
    const sprite = spriteFor(character);
    // 薄浮雕只随 IMU 转向与呼吸平移；不套用小猫的纵向挤压，避免脸型随状态拉伸。
    const yaw = clamp(pose.yaw, -1.15, 1.15) * 0.65, pitch = clamp(pose.pitch, -0.7, 0.7) * 0.65;
    // 每帧只计算四个三角函数；色段反算和阴影复用同一值，不改变乘加顺序。
    const a = Math.cos(yaw), sinYaw = Math.sin(yaw), sinPitch = Math.sin(pitch), b = sinYaw * sinPitch;
    const d = Math.cos(pitch);
    const width = Math.ceil(sprite.width * a) + 2;
    const height = Math.ceil(sprite.height * d + sprite.width * Math.abs(b)) + 2;
    const top = region?.top ?? cy - 12 * scale, bottom = region?.bottom ?? cy + 12 * scale;
    // 主页面按可用区域的最大整格尺寸等比铺满；预览仍由 scale 控制，四边各留一格容纳倾斜阴影。
    const step = Math.max(1, Math.floor(Math.min(region ? Infinity : scale * 24 / Math.max(sprite.width, sprite.height), (screen.width - 16) / width, (bottom - top - 4) / height)));
    const x0 = Math.round(clamp(cx - width * step / 2, 8, screen.width - 8 - width * step));
    const y0 = Math.round(clamp(cy + pose.lift - height * step / 2, top, bottom - height * step));
    const closed = state === 'sleep' || state === 'muted' || clock % 5300 < 140;
    const shadowX = Math.round(sinYaw * step), shadowY = Math.round(-sinPitch * step);
    // 每个目标列只计算一次源X，再直接求各色段的目标Y区间，省去整张网格的逐点反算。
    // 仍使用原来的半格采样中心与最近邻边界，保持倾斜后的眼睛、鼻子和轮廓。
    const samples = yaw === 0 && pitch === 0 ? 1 : 2;
    const sampleStep = step / samples;
    const columns = closed ? sprite.closed : sprite.open;
    const geometry = geometryFor(sprite, character, closed, yaw, pitch, width, height, step, samples, columns, a, b, d);
    const drawRects = geometry.rects;
    const count = geometry.count;
    const minX = geometry.minX, minY = geometry.minY, maxX = geometry.maxX, maxY = geometry.maxY;
    const retained = previous && paintings.get(previous);
    // 只有上一帧像素仍在、几何及全部绘制参数相同才复用；字幕和波形由调用者继续更新。
    if (previous && retained && retained.screen === screen && retained.width === screen.width && retained.height === screen.height &&
        retained.geometry === geometry && retained.x === x0 && retained.y === y0 && retained.step === sampleStep &&
        retained.shadowX === shadowX && retained.shadowY === shadowY && retained.top === top && retained.bottom === bottom) return previous;
    // 背景恢复或原生绘制抛错后，旧画面已经不完整，不能继续把旧 bounds 当作可复用帧。
    if (previous) paintings.delete(previous);
    beforeDraw?.();
    shadowLayers.set([shadowX, shadowY, 0x514561]);
    // 缓存几何直接传入原生批处理，阴影与主体共用同一布局取整定义。
    const options = { count, step: sampleStep, x: x0, y: y0, layers: shadowX || shadowY ? shadowLayers : emptyLayers };
    if (screen.fillRectLayers) screen.fillRectLayers(drawRects, options);
    else fillRectLayers(screen, drawRects, options);
    // 只恢复实际画过的区域，不能把透明留白扩到状态文字或全屏波形上。
    const bounds = { left: x0 + minX * sampleStep + Math.min(0, shadowX), top: y0 + minY * sampleStep + Math.min(0, shadowY),
        right: x0 + maxX * sampleStep + Math.max(0, shadowX), bottom: y0 + maxY * sampleStep + Math.max(0, shadowY) };
    paintings.set(bounds, { screen, width: screen.width, height: screen.height, geometry,
        x: x0, y: y0, step: sampleStep, shadowX, shadowY, top, bottom });
    return bounds;
}
