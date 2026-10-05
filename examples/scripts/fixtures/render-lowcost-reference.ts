// 冻结于native19 JS小优化之前，保存扫描条和波形所在原函数；不得从被测源码重建。
// 原render.ts SHA256: 094a0a841a677e44b7f5fbd1df302b070cadaef8dbe0ea59055fb5417c0e2289
import { catProjectionBounds, clamp, imuGlitch, packedCat, poseFor, rasterizeCat, rasterizeFace } from '../../06-obeing-pixel/src/model';
import type { Screen } from '../../06-obeing-pixel/src/layout';
import type { ViewState } from '../../06-obeing-pixel/src/state';
import type { RenderInput } from '../../06-obeing-pixel/src/render';
import { drawKitty } from '../../06-obeing-pixel/src/kitty';
import { fillRunLayers, runLayerBounds, type PhysicalBounds, type RunLayerOptions, type RunLayerResult } from '../../../sdk/src/run-layers';
interface Bounds { left: number; top: number; right: number; bottom: number }
interface SceneFrame {
    background: number; redraw: boolean; cat?: Bounds;
    grid?: { top: number; bottom: number; color: number };
}
const frames = new WeakMap<Screen, SceneFrame>();
const catLayers = new Int32Array(12);
const catRestore = new Float64Array(9);
function restoreBackground(screen: Screen, frame: SceneFrame, box: Bounds, covered?: PhysicalBounds): void {
    const left = Math.max(0, Math.floor(box.left)), top = Math.max(0, Math.floor(box.top));
    const right = Math.min(screen.width, Math.ceil(box.right)), bottom = Math.min(screen.height, Math.ceil(box.bottom));
    if (screen.restoreGridRect) { screen.restoreGridRect(left, top, right, bottom, frame.background, frame.grid, covered); return; }
    screen.fillRect(left, top, right - left, bottom - top, frame.background);
    const grid = frame.grid;
    if (!grid) return;
    for (let x = 24; x < screen.width - 20; x += 20) {
        if (x >= left && x < right) screen.fillRect(x, Math.max(top, grid.top), 1, Math.max(0, Math.min(bottom, grid.bottom) - Math.max(top, grid.top)), grid.color);
    }
    for (let y = grid.top; y < grid.bottom; y += 20) {
        if (y >= top && y < bottom) screen.fillRect(Math.max(left, 24), y, Math.max(0, Math.min(right, screen.width - 24) - Math.max(left, 24)), 1, grid.color);
    }
}

export function drawCat(screen: Screen, view: ViewState, input: RenderInput, cy: number, scale: number, region?: { top: number; bottom: number }): number {
    const frame = frames.get(screen);
    const pose = input.pose || poseFor(view.state, input.clock, input.tiltX, input.tiltY, view.level);
    const glitch = clamp(input.shake ?? imuGlitch(input.tiltX, input.tiltY), 0, 1);
    // 位移幅度增加 50%；后续仍按主体区域校正，避免挤入字幕和按钮。
    const cx = screen.width / 2 + clamp(input.tiltX, -1, 1) * 18;
    cy += clamp(input.tiltY, -1, 1) * 12;
    if (input.character && input.character !== 'cat') {
        // 先判定角色是否需要重画；场景清屏后不传旧帧，避免背景已恢复却错误跳过绘制。
        const previous = frame && !frame.redraw ? frame.cat : undefined;
        const box = drawKitty(screen, input.character, view.state, input.clock, pose, cx, cy, scale, region,
            previous, previous && frame ? () => restoreBackground(screen, frame, previous) : undefined);
        if (frame) frame.cat = box;
        return (box.right - box.left) * (box.bottom - box.top);
    }
    // fit 只读取截面凸包边界；形态混合一次，完整外壳只在最终尺寸投影。
    const points = packedCat(pose);
    const projected = region ? catProjectionBounds(pose, scale, cx, cy, points) : undefined;
    if (projected && region) {
        const step = Math.max(2, Math.round(scale)), edge = step + Math.round(step * glitch);
        const left = Math.min(cx - 13 * scale, projected[0] * step - edge);
        const right = Math.max(cx + 13 * scale, projected[2] * step + step + edge + 1);
        const top = projected[1] * step - edge, bottom = projected[3] * step + step + edge + 1;
        const fit = Math.min(1, (screen.width - 32) / (right - left), (region.bottom - region.top) / (bottom - top));
        if (fit < 1) scale *= fit * 0.97;
    }
    let runs = rasterizeCat(pose, scale, cx, cy, points);
    if (region && !projected) {
        const edge = runs.step + Math.round(runs.step * glitch);
        const box = runLayerBounds(runs.runs, runs.count, runs.step, edge, cx - 13 * scale, cx + 13 * scale);
        const fit = Math.min(1, (screen.width - 32) / (box.right - box.left), (region.bottom - region.top) / (box.bottom - box.top));
        if (fit < 1) { scale *= fit * 0.97; runs = rasterizeCat(pose, scale, cx, cy, points); }
    }
    const step = runs.step;
    const clipTop = region?.top ?? 0, clipBottom = region?.bottom ?? screen.height;
    const edge = step + Math.round(step * glitch), halfEdge = Math.ceil(edge / 2);
    // 复用原有typed数组，避免每帧先分配12元素临时Array再复制。
    catLayers[0] = edge; catLayers[1] = -edge; catLayers[2] = 0x2050ef;
    catLayers[3] = -edge; catLayers[4] = edge; catLayers[5] = 0xe31c35;
    catLayers[6] = halfEdge; catLayers[7] = 0; catLayers[8] = 0x17f5f5;
    catLayers[9] = -halfEdge; catLayers[10] = 1; catLayers[11] = 0xf9fb54;
    const options: RunLayerOptions = { count: runs.count, step, layers: catLayers, padding: 1,
        left: cx - 13 * scale, right: cx + 13 * scale, clipTop, clipBottom, color: 0xffffff };
    if (region) options.margin = 12;
    let painted: RunLayerResult;
    if (frame?.cat && !frame.redraw && screen.fillRunLayersRestored) {
        // 一次原生调用完成旧背景和网格恢复、主体覆盖分析及彩边绘制，避免重复进入JS密集循环。
        const box = frame.cat, grid = frame.grid;
        catRestore[0] = box.left; catRestore[1] = box.top;
        catRestore[2] = box.right; catRestore[3] = box.bottom;
        catRestore[4] = frame.background;
        catRestore[5] = grid?.top ?? 0; catRestore[6] = grid?.bottom ?? 0;
        catRestore[7] = grid?.color ?? 0; catRestore[8] = grid ? 1 : 0;
        painted = screen.fillRunLayersRestored(runs.runs, options, catRestore);
    } else {
        if (frame?.cat && !frame.redraw)
            restoreBackground(screen, frame, frame.cat, screen.runLayerInnerRect?.(runs.runs, options));
        painted = screen.fillRunLayers ? screen.fillRunLayers(runs.runs, options) : fillRunLayers(screen, runs.runs, options);
    }
    const dx = painted.dx, dy = painted.dy;
    const paint = (x: number, y: number, w: number, h: number, color: number) => {
        x += dx; y += dy;
        // 增强的彩边和扫描条也受主体区域限制，并计入下一帧的背景恢复范围。
        if (x < 0) { w += x; x = 0; }
        if (y < clipTop) { h -= clipTop - y; y = clipTop; }
        if (x + w > screen.width) w = screen.width - x;
        if (y + h > clipBottom) h = clipBottom - y;
        if (w <= 0 || h <= 0) return;
        // 热路径用比较直接更新包围盒，避免每个小矩形反复跨入 Math 原生函数。
        if (x < painted.left) painted.left = x;
        if (y < painted.top) painted.top = y;
        if (x + w > painted.right) painted.right = x + w;
        if (y + h > painted.bottom) painted.bottom = y + h;
        screen.fillRect(x, y, w, h, color);
    };
    // 眼睛和嘴位于前表面，随同一视图矩阵旋转，不贴死在屏幕坐标。
    if (Math.cos(pose.yaw) > 0.15) {
        const face = rasterizeFace(view.state, input.clock, view.level, pose, scale, cx, cy, step);
        const upperOffset = glitch > 0.15 ? Math.max(1, Math.round(step * glitch)) : 0, faceSize = step + 1;
        for (let i = 0; i < face.count; i++) {
            const x = face.xy[i * 2] * step, y = face.xy[i * 2 + 1] * step;
            if (glitch > 0.15 && face.upper[i]) paint(x - upperOffset, y, step, step, 0xf9fb54);
            paint(x, y, faceSize, faceSize, 0x0d1210);
        }
    }
    // 强度越大，扫描条越多、越长、跳动越快；最多 12 个额外矩形，限制每帧工作量。
    const scan = Math.floor(input.clock / (120 - glitch * 80));
    const stripHeight = Math.max(1, Math.round(step * glitch * 0.7));
    for (let i = 0; i < Math.floor(glitch * 6); i++) {
        const y = cy + ((i * 5 + scan) % 17 - 8) * scale;
        const x = cx + (i % 2 ? 6 : -11) * scale;
        paint(x, y, (3 + glitch * 4) * scale, stripHeight, i % 2 ? 0x17f5f5 : 0xf9fb54);
        paint(x + scale, y, (1 + glitch * 2) * scale, stripHeight, 0xffffff);
    }
    if (frame) frame.cat = painted;
    return painted.pixels;
}

export function waveform(screen: Screen, view: ViewState, input: RenderInput, y: number, color: number): void {
    const active = ['wake', 'listening', 'thinking', 'speaking'].includes(view.state);
    const amplitude = active ? 3 + Math.min(10, view.level / 10) : view.state === 'sleep' || view.muted ? 1 : 2;
    const phase = input.clock / (view.state === 'thinking' ? 270 : 130), left = screen.width / 2 - 79;
    for (let i = 0; i < 27; i++) {
        const h = Math.round(2 + Math.abs(Math.sin(i * 0.73 + phase)) * amplitude);
        screen.fillRect(left + i * 6, y - h / 2, 3, h, color);
    }
}
