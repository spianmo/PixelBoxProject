export type Screen = Pick<PxScreen, 'width' | 'height' | 'clear' | 'fillRect' | 'drawText' | 'measureText'> & Partial<Pick<PxScreen, 'fillRects'>>;
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
    let count = 0;
    const finish = () => { if (count && rects) { const pending = count; count = 0; target.fillRects!(rects, pending); } };
    const measurements = new Map<string, { width: number; height: number }>();
    const screen: LayoutScreen = {
        finish,
        width: target.width / scale, height: target.height / scale,
        clear: (color) => { finish(); target.clear(color); },
        fillRect(x, y, width, height, color) {
            const left = Math.round(x * scale), top = Math.round(y * scale);
            const w = Math.round((x + width) * scale) - left, h = Math.round((y + height) * scale) - top;
            if (!rects) target.fillRect(left, top, w, h, color);
            else {
                if (count === 1024) finish();
                const at = count++ * 5;
                rects[at] = left; rects[at + 1] = top; rects[at + 2] = w; rects[at + 3] = h; rects[at + 4] = color;
            }
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
    layouts.set(target, { width: target.width, height: target.height, screen });
    return screen;
}

export function textHeight(screen: Screen): number {
    return screen.measureText('M', { font: 'pixel12' }).height;
}

export function lineHeight(screen: Screen, minimum = 18): number {
    return Math.max(minimum, textHeight(screen) + 4);
}
