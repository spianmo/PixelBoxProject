import { clamp, type AssistantState, type Pose } from './model';
import type { KittyCharacter } from './characters';
import type { Screen } from './layout';
import { KITTY_PALETTE, KITTY_PATTERNS, type KittyPattern } from './kitty-patterns';

interface Columns { offsets: Uint16Array; runs: Int32Array }
interface Sprite { width: number; height: number; open: Columns; closed: Columns }
const sprites: Partial<Record<KittyCharacter, Sprite>> = {};

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
let rectangles = new Int32Array(1024 * 5);
let previousColumn = new Int32Array(128), currentColumn = new Int32Array(128);

export function drawKitty(screen: Screen, character: KittyCharacter, state: AssistantState, clock: number,
    pose: Pose, cx: number, cy: number, scale: number, region?: { top: number; bottom: number }) {
    const sprite = spriteFor(character);
    // 薄浮雕只随 IMU 转向与呼吸平移；不套用小猫的纵向挤压，避免脸型随状态拉伸。
    const yaw = clamp(pose.yaw, -1.15, 1.15) * 0.65, pitch = clamp(pose.pitch, -0.7, 0.7) * 0.65;
    const a = Math.cos(yaw), b = Math.sin(yaw) * Math.sin(pitch);
    const d = Math.cos(pitch);
    const width = Math.ceil(sprite.width * a) + 4;
    const height = Math.ceil(sprite.height * d + sprite.width * Math.abs(b)) + 4;
    const top = region?.top ?? cy - 12 * scale, bottom = region?.bottom ?? cy + 12 * scale;
    const step = Math.max(1, Math.floor(Math.min(scale * 24 / Math.max(sprite.width, sprite.height), (screen.width - 32) / width, (bottom - top - 8) / height)));
    const x0 = Math.round(clamp(cx - width * step / 2, 12, screen.width - 12 - width * step));
    const y0 = Math.round(clamp(cy + pose.lift - height * step / 2, top, bottom - height * step));
    const closed = state === 'sleep' || state === 'muted' || clock % 5300 < 140;
    const shadowX = Math.round(Math.sin(yaw) * step), shadowY = Math.round(-Math.sin(pitch) * step);
    // 每个目标列只计算一次源X，再直接求各色段的目标Y区间，省去整张网格的逐点反算。
    // 仍使用原来的半格采样中心与最近邻边界，保持倾斜后的眼睛、鼻子和轮廓。
    const samples = yaw === 0 && pitch === 0 ? 1 : 2;
    const sampleStep = step / samples;
    const columns = closed ? sprite.closed : sprite.open;
    const runs = columns.runs;
    // 一个源列最多覆盖两个目标半格列；容量按未合并的最坏情况预留。
    const capacity = runs.length / 3 * samples * 5;
    if (rectangles.length < capacity) rectangles = new Int32Array(capacity);
    let count = 0, previousCount = 0;
    let minX = width * samples, minY = height * samples, maxX = 0, maxY = 0;
    for (let x = 0; x < width * samples; x++) {
        const sx = ((x + 0.5) / samples - width / 2) / a;
        const sourceX = Math.floor(sx + sprite.width / 2);
        let currentCount = 0, prior = 0;
        if (sourceX >= 0 && sourceX < sprite.width) {
            const offsetY = height / 2 + b * sx - d * sprite.height / 2;
            for (let i = columns.offsets[sourceX]; i < columns.offsets[sourceX + 1]; i += 3) {
                let y = Math.ceil((offsetY + d * runs[i]) * samples - 0.5);
                let end = Math.ceil((offsetY + d * runs[i + 1]) * samples - 0.5);
                if (y < 0) y = 0;
                if (end > height * samples) end = height * samples;
                if (end <= y) continue;
                const color = runs[i + 2];
                // 相邻列中起止Y和颜色相同的色段直接横向合并，大幅减少绘图调用。
                while (prior < previousCount && rectangles[previousColumn[prior] + 1] < y) prior++;
                const match = prior < previousCount ? previousColumn[prior] : -1;
                let at: number;
                if (match >= 0 && rectangles[match + 1] === y && rectangles[match + 3] === end - y && rectangles[match + 4] === color) {
                    at = match; rectangles[at + 2]++;
                } else {
                    at = count++ * 5;
                    rectangles[at] = x; rectangles[at + 1] = y; rectangles[at + 2] = 1;
                    rectangles[at + 3] = end - y; rectangles[at + 4] = color;
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
    // 无偏移时阴影完全被主体覆盖，不做无效绘制。
    if (shadowX || shadowY) for (let at = 0; at < count * 5; at += 5) {
        screen.fillRect(x0 + rectangles[at] * sampleStep + shadowX, y0 + rectangles[at + 1] * sampleStep + shadowY,
            rectangles[at + 2] * sampleStep, rectangles[at + 3] * sampleStep, 0x514561);
    }
    for (let at = 0; at < count * 5; at += 5) {
        screen.fillRect(x0 + rectangles[at] * sampleStep, y0 + rectangles[at + 1] * sampleStep,
            rectangles[at + 2] * sampleStep, rectangles[at + 3] * sampleStep, rectangles[at + 4]);
    }
    // 只恢复实际画过的区域，不能把透明留白扩到状态文字或全屏波形上。
    return { left: x0 + minX * sampleStep + Math.min(0, shadowX), top: y0 + minY * sampleStep + Math.min(0, shadowY),
        right: x0 + maxX * sampleStep + Math.max(0, shadowX), bottom: y0 + maxY * sampleStep + Math.max(0, shadowY) };
}
