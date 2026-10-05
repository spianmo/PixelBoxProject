import { fillRunLayers, fillRectLayers, runLayerInnerRect, type PhysicalBounds, type RunLayerOptions, type RunLayerResult, type RunLayerRestore, type RectLayerOptions } from '../../../sdk/src/run-layers';

export type LogicalRectBatch = (rects: Float64Array, count?: number) => void;
export type Screen = Pick<PxScreen, 'width' | 'height' | 'clear' | 'fillRect' | 'drawText' | 'measureText'> & Partial<Pick<PxScreen, 'fillRects'>> & {
    /** 将布局坐标批量转换为物理像素；仅由 layoutScreen 创建。 */
    fillLogicalRects?: LogicalRectBatch;
    fillRunLayers?: (runs: Int32Array, options?: RunLayerOptions) => RunLayerResult;
    fillRunLayersRestored?: (runs: Int32Array, options: RunLayerOptions, restore: RunLayerRestore) => RunLayerResult;
    runLayerInnerRect?: (runs: Int32Array, options?: RunLayerOptions) => PhysicalBounds | undefined;
    fillRectLayers?: (rects: Int32Array, options?: RectLayerOptions) => void;
    /** 内部背景恢复：复用静态网格的物理坐标与本次裁剪端点。 */
    restoreGridRect?: (left: number, top: number, right: number, bottom: number, color: number,
        grid?: { top: number; bottom: number; color: number }, covered?: PhysicalBounds) => void;
};
type LayoutScreen = Screen & { finish(): void };
const layouts = new WeakMap<Screen, { width: number; height: number; screen: LayoutScreen }>();

// Keep the 448-high layout and touch geometry together; use the firmware settings font size.
export function layoutScale(screen: Pick<Screen, 'width' | 'height'>): number {
    return Math.min(screen.height / 448, screen.width / 320);
}

export function layoutPoint(screen: Pick<Screen, 'width' | 'height'>, x: number, y: number) {
    const scale = layoutScale(screen);
    return { x: x / scale, y: y / scale, width: screen.width / scale };
}

export function layoutScreen(target: Screen): LayoutScreen {
    const cached = layouts.get(target);
    if (cached && cached.width === target.width && cached.height === target.height) return cached.screen;
    const scale = layoutScale(target);
    const textScale = Math.min(target.width, target.height) / 368 >= 1.2 ? 2 : 1;
    const styleFor = (style?: PxTextStyle): PxTextStyle => ({ ...style, scale: (style?.scale ?? 1) * textScale });
    const rects = target.fillRects ? new Int32Array(1024 * 5) : null;
    let count = 0, flushEpoch = 0;
    let gridBatch: { rects: Int32Array; width: number; height: number; left: number; top: number; right: number; bottom: number;
        color: number; gridTop: number; gridBottom: number; gridColor: number;
        cutLeft?: number; cutTop?: number; cutRight?: number; cutBottom?: number } | undefined;
    const queueRect = (x: number, y: number, width: number, height: number, color: number): void => {
        const left = Math.round(x * scale), top = Math.round(y * scale);
        const w = Math.round((x + width) * scale) - left, h = Math.round((y + height) * scale) - top;
        if (!rects) { target.fillRect(left, top, w, h, color); return; }
        if (count === 1024) finish();
        const at = count++ * 5;
        rects[at] = left; rects[at + 1] = top; rects[at + 2] = w; rects[at + 3] = h; rects[at + 4] = color;
    };
    const finish = () => {
        if (count && rects) {
            const pending = count; count = 0; flushEpoch++;
            try { target.fillRects!(rects, pending); }
            catch (error) { gridBatch = undefined; throw error; }
        }
    };
    const queuePhysicalRect = (x: number, y: number, width: number, height: number, color: number): void => {
        if (!rects) { target.fillRect(x, y, width, height, color); return; }
        if (count === 1024) finish();
        const at = count++ * 5;
        rects[at] = x; rects[at + 1] = y; rects[at + 2] = width; rects[at + 3] = height; rects[at + 4] = color;
    };
    const queueUncoveredRect = (x: number, y: number, width: number, height: number, color: number, covered?: PhysicalBounds): void => {
        if (!covered) { queuePhysicalRect(x, y, width, height, color); return; }
        const right = x + width, bottom = y + height;
        const leftCut = Math.max(x, covered.left), topCut = Math.max(y, covered.top);
        const rightCut = Math.min(right, covered.right), bottomCut = Math.min(bottom, covered.bottom);
        if (rightCut <= leftCut || bottomCut <= topCut) { queuePhysicalRect(x, y, width, height, color); return; }
        // 已知新主体完全覆盖这里，背景和网格只恢复外围最多四块，减少外存写入。
        if (topCut > y) queuePhysicalRect(x, y, width, topCut - y, color);
        if (bottomCut < bottom) queuePhysicalRect(x, bottomCut, width, bottom - bottomCut, color);
        if (leftCut > x) queuePhysicalRect(x, topCut, leftCut - x, bottomCut - topCut, color);
        if (rightCut < right) queuePhysicalRect(rightCut, topCut, right - rightCut, bottomCut - topCut, color);
    };
    let gridCache: { top: number; bottom: number; vertical: number[]; horizontal: number[] } | undefined;
    const restoreGridRect: NonNullable<Screen['restoreGridRect']> = (left, top, right, bottom, color, grid, covered) => {
        const previous = gridBatch;
        if (grid && rects && previous && previous.width === target.width && previous.height === target.height &&
            previous.left === left && previous.top === top && previous.right === right && previous.bottom === bottom && previous.color === color &&
            previous.gridTop === grid.top && previous.gridBottom === grid.bottom && previous.gridColor === grid.color &&
            previous.cutLeft === covered?.left && previous.cutTop === covered?.top && previous.cutRight === covered?.right && previous.cutBottom === covered?.bottom) {
            // 只复用组装结果，仍逐批重画；按原1024矩形边界拆分，保留前后队列顺序。
            const cached = previous.rects, total = cached.length / 5;
            for (let offset = 0; offset < total;) {
                if (count === 1024) finish();
                const take = Math.min(total - offset, 1024 - count);
                rects.set(cached.subarray(offset * 5, (offset + take) * 5), count * 5);
                count += take; offset += take;
            }
            return;
        }
        const batchStart = count, epoch = flushEpoch;
        if (grid) gridBatch = undefined;
        if (!covered) queueRect(left, top, right - left, bottom - top, color);
        else {
            const x = Math.round(left * scale), y = Math.round(top * scale);
            queueUncoveredRect(x, y, Math.round((left + (right - left)) * scale) - x,
                Math.round((top + (bottom - top)) * scale) - y, color, covered);
        }
        if (!grid) return;
        // 网格不随角色移动；每条线的固定轴仅在布局变化时取整。
        if (!gridCache || gridCache.top !== grid.top || gridCache.bottom !== grid.bottom) {
            const vertical: number[] = [], horizontal: number[] = [];
            for (let x = 24; x < target.width / scale - 20; x += 20) {
                const physical = Math.round(x * scale);
                vertical.push(x, physical, Math.round((x + 1) * scale) - physical);
            }
            for (let y = grid.top; y < grid.bottom; y += 20) {
                const physical = Math.round(y * scale);
                horizontal.push(y, physical, Math.round((y + 1) * scale) - physical);
            }
            gridCache = { top: grid.top, bottom: grid.bottom, vertical, horizontal };
        }
        // 先减后加保持原 layoutScreen 四次 round 的运算顺序，不能直接替换成终点。
        const vy = Math.max(top, grid.top), vh = Math.max(0, Math.min(bottom, grid.bottom) - vy);
        const hx = Math.max(left, 24), hw = Math.max(0, Math.min(right, target.width / scale - 24) - hx);
        const physicalTop = Math.round(vy * scale), physicalHeight = Math.round((vy + vh) * scale) - physicalTop;
        const physicalLeft = Math.round(hx * scale), physicalWidth = Math.round((hx + hw) * scale) - physicalLeft;
        const vertical = gridCache.vertical, horizontal = gridCache.horizontal;
        for (let i = 0; i < vertical.length; i += 3) if (vertical[i] >= left && vertical[i] < right)
            queueUncoveredRect(vertical[i + 1], physicalTop, vertical[i + 2], physicalHeight, grid.color, covered);
        for (let i = 0; i < horizontal.length; i += 3) if (horizontal[i] >= top && horizontal[i] < bottom)
            queueUncoveredRect(physicalLeft, horizontal[i + 1], physicalWidth, horizontal[i + 2], grid.color, covered);
        // 仅缓存完整留在队列中的网格批次；中途提交或抛错都不能保存半份结果。
        if (rects && epoch === flushEpoch) gridBatch = { rects: rects.slice(batchStart * 5, count * 5),
            width: target.width, height: target.height, left, top, right, bottom, color,
            gridTop: grid.top, gridBottom: grid.bottom, gridColor: grid.color,
            cutLeft: covered?.left, cutTop: covered?.top, cutRight: covered?.right, cutBottom: covered?.bottom };
    };
    const fillLogicalRects: LogicalRectBatch = (logical, requested = Math.floor(logical.length / 5)) => {
        const pending = Math.min(requested, Math.floor(logical.length / 5));
        for (let i = 0; i < pending; i++) {
            const at = i * 5;
            queueRect(logical[at], logical[at + 1], logical[at + 2], logical[at + 3], logical[at + 4]);
        }
    };
    const measurements = new Map<string, { width: number; height: number }>();
    const screen: LayoutScreen = {
        finish,
        width: target.width / scale, height: target.height / scale,
        clear: (color) => { finish(); target.clear(color); },
        fillRect: queueRect,
        runLayerInnerRect: (runs, options) => runLayerInnerRect(target, runs, { ...options, scale }),
        restoreGridRect,
        fillLogicalRects,
        fillRunLayers(runs, options) {
            finish();
            const scaled = { ...options, scale };
            return target.fillRunLayers ? target.fillRunLayers(runs, scaled) : fillRunLayers(target, runs, scaled);
        },
        fillRectLayers(logical, options) {
            finish();
            const scaled = { ...options, scale };
            if (target.fillRectLayers) target.fillRectLayers(logical, scaled);
            else fillRectLayers(target, logical, scaled);
        },
        drawText: (text, x, y, style) => { finish(); target.drawText(text, Math.round(x * scale), Math.round(y * scale), styleFor(style)); },
        measureText(text, style) {
            const key = `${style?.font || ''}:${style?.scale || 1}:${text}`;
            const known = measurements.get(key);
            if (known) return known;
            const size = target.measureText(text, styleFor(style));
            const measured = { width: size.width / scale, height: size.height / scale };
            if (text.length <= 128) {
                if (measurements.size >= 192) measurements.clear();
                measurements.set(key, measured);
            }
            return measured;
        },
    };
    // 只暴露目标真实提供的融合能力；旧固件和模拟器继续走已有背景恢复路径。
    if (target.fillRunLayersRestored) screen.fillRunLayersRestored = (runs, options, restore) => {
        finish();
        return target.fillRunLayersRestored!(runs, { ...options, scale }, restore);
    };
    layouts.set(target, { width: target.width, height: target.height, screen });
    return screen;
}

export function textHeight(screen: Screen): number {
    return screen.measureText('M', { font: 'pixel12' }).height;
}

export function lineHeight(screen: Screen, minimum = 18): number {
    return Math.max(minimum, textHeight(screen) + 4);
}
