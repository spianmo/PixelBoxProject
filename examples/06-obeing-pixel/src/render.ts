import { clamp, facePoints, imuGlitch, poseFor, rasterizeCat, projectPoint, posedShapePoint, type AssistantState, type Pose } from './model';
import type { ViewState } from './state';
import { layoutScreen, lineHeight, textHeight, type Screen } from './layout';
import { CHARACTER_NAMES, type Character } from './characters';
import { drawKitty } from './kitty';

export type { Screen } from './layout';
// shake 为 0..1 连续故障强度；离线预览未传入时从倾角输入计算。
export interface RenderInput { clock: number; tiltX: number; tiltY: number; battery: number; settings: boolean; fullscreen?: boolean; pose?: Pose; shake?: number; character?: Character }

interface Bounds { left: number; top: number; right: number; bottom: number }
interface SceneFrame {
    key: string; background: number; redraw: boolean; cat?: Bounds;
    grid?: { top: number; bottom: number; color: number };
    captionKey?: string; bodyBottom?: number;
}
const frames = new WeakMap<Screen, SceneFrame>();
const glyphWidths = new WeakMap<Screen, Map<string, number>>();

// 使用最近一帧的真实主体包围盒命中；坐标与 layoutPoint 保持同一布局空间。
export function characterAt(target: Screen, x: number, y: number): boolean {
    const box = frames.get(layoutScreen(target))?.cat;
    return Boolean(box && x >= box.left - 8 && x <= box.right + 8 && y >= box.top - 8 && y <= box.bottom + 8);
}

// 静态布局变化才整屏刷新；字幕增量和 IMU 帧复用现有背景。
export function beginScene(screen: Screen, key: string, background: number): boolean {
    let frame = frames.get(screen);
    if (!frame || frame.key !== key || frame.background !== background) {
        frame = { key, background, redraw: true };
        frames.set(screen, frame);
        screen.clear(background);
    } else frame.redraw = false;
    return frame.redraw;
}

export function sceneKey(view: ViewState, input: RenderInput): string {
    return JSON.stringify([view.theme, input.fullscreen, input.settings, input.battery, view.state,
        view.connected, view.authenticated, view.muted, view.displayName, view.enterpriseId,
        view.phoneName, view.pairingCode, view.pairingPending]);
}

function restoreBackground(screen: Screen, frame: SceneFrame, box: Bounds): void {
    const left = Math.max(0, Math.floor(box.left)), top = Math.max(0, Math.floor(box.top));
    const right = Math.min(screen.width, Math.ceil(box.right)), bottom = Math.min(screen.height, Math.ceil(box.bottom));
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

const LABEL: Record<AssistantState, string> = {
    offline: '等待连接', pairing: '配对', login: '等待手机同步', idle: '你好小川', sleep: '在这里陪你', wake: '我在', listening: '正在聆听', thinking: '思考中', speaking: '小川正在回答', muted: '麦克风已关闭', error: '连接需恢复',
};
const ICONS: Record<string, string[]> = {
    mic: ['00100', '01110', '01110', '01110', '10101', '10001', '01110', '00100', '01110'],
    mute: ['10001', '01010', '00100', '01010', '10001', '00000', '01110', '00100', '01110'],
    theme: ['0011100', '0100010', '1000101', '1001101', '1011101', '0111110', '0011100'],
    link: ['0110000', '1001000', '1001010', '0110101', '0001001', '0000110'],
    back: ['00100', '01000', '11111', '01000', '00100'],
    unlink: ['0110000', '1001000', '1001000', '0000000', '0001001', '0000110'],
    check: ['000001', '000010', '100100', '011000'],
};

function icon(screen: Screen, name: string, x: number, y: number, color: number, scale = 2): void {
    scale *= Math.max(1, textHeight(screen) / 12);
    for (const [row, cells] of ICONS[name].entries()) {
        for (let col = 0; col < cells.length; col++) if (cells[col] === '1') screen.fillRect(x + col * scale, y + row * scale, scale, scale, color);
    }
}

export function wrapText(screen: Screen, value: string, width: number, maxLines: number): string[] {
    let widths = glyphWidths.get(screen);
    if (!widths) { widths = new Map(); glyphWidths.set(screen, widths); }
    const lines: string[] = [];
    let line = '';
    let lineWidth = 0;
    for (const ch of value) {
        if (ch === '\n') { lines.push(line); line = ''; lineWidth = 0; continue; }
        let glyphWidth = widths.get(ch);
        // pixel12 和固件 measure_line 一样按字形 advance 累加，避免每字重新遍历整行。
        if (glyphWidth === undefined) {
            glyphWidth = screen.measureText(ch, { font: 'pixel12' }).width;
            if (widths.size >= 512) widths.clear();
            widths.set(ch, glyphWidth);
        }
        if (line && lineWidth + glyphWidth > width + 1e-7) { lines.push(line); line = ch; lineWidth = glyphWidth; }
        else { line += ch; lineWidth += glyphWidth; }
    }
    if (line) lines.push(line);
    return lines.slice(-maxLines);
}

function label(screen: Screen, value: string, x: number, y: number, color: number): void {
    screen.drawText(value, x, y, { font: 'pixel12', color });
}

function center(screen: Screen, value: string, y: number, color: number): void {
    label(screen, value, Math.round((screen.width - screen.measureText(value, { font: 'pixel12' }).width) / 2), y, color);
}

export function drawCat(screen: Screen, view: ViewState, input: RenderInput, cy: number, scale: number, region?: { top: number; bottom: number }): number {
    const frame = frames.get(screen);
    if (frame?.cat && !frame.redraw) restoreBackground(screen, frame, frame.cat);
    const pose = input.pose || poseFor(view.state, input.clock, input.tiltX, input.tiltY, view.level);
    const glitch = clamp(input.shake ?? imuGlitch(input.tiltX, input.tiltY), 0, 1);
    // 位移幅度增加 50%；后续仍按主体区域校正，避免挤入字幕和按钮。
    const cx = screen.width / 2 + clamp(input.tiltX, -1, 1) * 18;
    cy += clamp(input.tiltY, -1, 1) * 12;
    if (input.character && input.character !== 'cat') {
        const box = drawKitty(screen, input.character, view.state, input.clock, pose, cx, cy, scale, region);
        if (frame) frame.cat = box;
        return (box.right - box.left) * (box.bottom - box.top);
    }
    let runs = rasterizeCat(pose, scale, cx, cy);
    const bounds = () => {
        const edge = runs.step + Math.round(runs.step * glitch);
        let left = cx - 13 * scale, right = cx + 13 * scale;
        let top = Infinity, bottom = -Infinity;
        for (let i = 0; i < runs.count; i++) {
            left = Math.min(left, runs.x[i] - edge);
            right = Math.max(right, runs.x[i] + runs.width[i] + edge + 1);
            top = Math.min(top, runs.y[i] - edge);
            bottom = Math.max(bottom, runs.y[i] + runs.step + edge + 1);
        }
        return { left, right, top, bottom };
    };
    let dx = 0, dy = 0;
    if (region) {
        let box = bounds();
        const fit = Math.min(1, (screen.width - 32) / (box.right - box.left), (region.bottom - region.top) / (box.bottom - box.top));
        if (fit < 1) { scale *= fit * 0.97; runs = rasterizeCat(pose, scale, cx, cy); box = bounds(); }
        dx = box.left < 12 ? 12 - box.left : box.right > screen.width - 12 ? screen.width - 12 - box.right : 0;
        dy = box.top < region.top ? region.top - box.top : box.bottom > region.bottom ? region.bottom - box.bottom : 0;
    }
    const step = runs.step;
    // 合并投影中的单格针孔，同时保留双耳间隙。
    let count = 0;
    for (let i = 0; i < runs.count; i++) {
        const gap = count ? runs.x[i] - runs.x[count - 1] - runs.width[count - 1] : Infinity;
        if (count && runs.y[i] === runs.y[count - 1] && gap <= step) runs.width[count - 1] = runs.x[i] + runs.width[i] - runs.x[count - 1];
        else { runs.x[count] = runs.x[i]; runs.y[count] = runs.y[i]; runs.width[count++] = runs.width[i]; }
    }
    runs.count = count;
    const painted: Bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    const clipTop = region?.top ?? 0, clipBottom = region?.bottom ?? screen.height;
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
    const edge = step + Math.round(step * glitch);
    for (const layer of [{ dx: edge, dy: -edge, color: 0x2050ef }, { dx: -edge, dy: edge, color: 0xe31c35 }, { dx: Math.ceil(edge / 2), dy: 0, color: 0x17f5f5 }, { dx: -Math.ceil(edge / 2), dy: 1, color: 0xf9fb54 }]) {
        let row = 0;
        for (let i = 0; i < runs.count; i++) {
            const x = runs.x[i] + layer.dx, y = runs.y[i] + layer.dy;
            const right = x + runs.width[i] + 1, bottom = y + step + 1;
            const gridY = Math.floor(y / step) * step;
            while (row < runs.count && runs.y[row] < gridY) row++;
            let leftCut = 0, topCut = 0, rightCut = 0, bottomCut = 0, area = 0;
            // 白色主体最后覆盖：只减去同一栅格行中最大遮挡矩形，保留色边与耳间空隙。
            for (let j = row; j < runs.count && runs.y[j] === gridY; j++) {
                const bx = runs.x[j], by = runs.y[j], br = bx + runs.width[j] + 1, bb = by + step + 1;
                const left = x > bx ? x : bx, top = y > by ? y : by;
                const end = right < br ? right : br, base = bottom < bb ? bottom : bb;
                if (end <= left || base <= top) continue;
                const overlap = (end - left) * (base - top);
                if (overlap > area) { area = overlap; leftCut = left; topCut = top; rightCut = end; bottomCut = base; }
            }
            if (!area) paint(x, y, right - x, bottom - y, layer.color);
            else {
                if (topCut > y) paint(x, y, right - x, topCut - y, layer.color);
                if (bottomCut < bottom) paint(x, bottomCut, right - x, bottom - bottomCut, layer.color);
                if (leftCut > x) paint(x, topCut, leftCut - x, bottomCut - topCut, layer.color);
                if (rightCut < right) paint(rightCut, topCut, right - rightCut, bottomCut - topCut, layer.color);
            }
        }
    }
    for (let i = 0; i < runs.count; i++) paint(runs.x[i], runs.y[i], runs.width[i] + 1, step + 1, 0xffffff);
    // 眼睛和嘴位于前表面，随同一视图矩阵旋转，不贴死在屏幕坐标。
    if (Math.cos(pose.yaw) > 0.15) {
        for (const voxel of facePoints(view.state, input.clock, view.level)) {
            const p = projectPoint(posedShapePoint(voxel, pose), pose, scale, cx, cy);
            const x = Math.round(p.sx / step) * step, y = Math.round(p.sy / step) * step;
            if (glitch > 0.15 && voxel.y < 2) paint(x - Math.max(1, Math.round(step * glitch)), y, step, step, 0xf9fb54);
            paint(x, y, step + 1, step + 1, 0x0d1210);
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
    return runs.pixels;
}

export function fullscreenAt(x: number, y: number, width: number): boolean {
    return x >= width - 58 && x < width && y >= 4 && y < 42;
}

export function fullscreenIcon(screen: Screen, active: boolean, color: number): void {
    const x = screen.width - 39, y = 15, size = 21, arm = 7, stroke = 2;
    for (const sx of [0, 1]) for (const sy of [0, 1]) {
        const left = x + sx * (size - arm), top = y + sy * (size - arm);
        const vx = active ? left + (sx ? 0 : arm - stroke) : left + (sx ? arm - stroke : 0);
        const hy = active ? top + (sy ? 0 : arm - stroke) : top + (sy ? arm - stroke : 0);
        screen.fillRect(vx, top, stroke, arm, color);
        screen.fillRect(left, hy, arm, stroke, color);
    }
}

export function companionHeader(screen: Screen, brand: string, view: ViewState, input: RenderInput): void {
    const fg = view.theme === 'dark' ? 0xeef2ee : 0x121714;
    if (!input.fullscreen) {
        label(screen, brand, 20, 18, fg);
        const end = 20 + screen.measureText(brand, { font: 'pixel12' }).width;
        screen.fillRect(end + 10, 18 + textHeight(screen) / 2 - 3, 6, 6, view.connected ? 0x9ae05b : 0xe8876b);
        const batteryText = `${input.battery}%`;
        const batteryX = screen.width - 65 - screen.measureText(batteryText, { font: 'pixel12' }).width;
        if (input.battery >= 0 && batteryX > end + 28) label(screen, batteryText, batteryX, 18, view.theme === 'dark' ? 0x8b9791 : 0x59645e);
    }
    fullscreenIcon(screen, Boolean(input.fullscreen), fg);
}

function waveform(screen: Screen, view: ViewState, input: RenderInput, y: number, color: number): void {
    const active = ['wake', 'listening', 'thinking', 'speaking'].includes(view.state);
    const amplitude = active ? 3 + Math.min(10, view.level / 10) : view.state === 'sleep' || view.muted ? 1 : 2;
    for (let i = 0; i < 27; i++) {
        const phase = input.clock / (view.state === 'thinking' ? 270 : 130);
        const h = Math.round(2 + Math.abs(Math.sin(i * 0.73 + phase)) * amplitude);
        screen.fillRect(screen.width / 2 - 79 + i * 6, y - h / 2, 3, h, color);
    }
}

export function companionBody(screen: Screen, view: ViewState, input: RenderInput, status: string, fallback = ''): void {
    const frame = frames.get(screen);
    const dark = view.theme === 'dark', fg = dark ? 0xeef2ee : 0x121714;
    const quiet = dark ? 0x8b9791 : 0x59645e, accent = dark ? 0xc4f27c : 0x477f18;
    const line = lineHeight(screen, 17);
    const progress = view.thinkingText;
    const captionTop = screen.height - (line * 2 + textHeight(screen) + 12 + (input.fullscreen && progress ? line : 0));
    const statusY = captionTop - 34;
    const top = input.fullscreen ? 42 : 83, bottom = input.fullscreen ? captionTop - 38 : statusY - 8;
    if (frame && frame.bodyBottom !== undefined && frame.bodyBottom !== bottom) {
        screen.fillRect(0, top, screen.width, screen.height - top, frame.background);
        frame.cat = undefined; frame.captionKey = undefined; frame.redraw = true;
    }
    if (frame) frame.bodyBottom = bottom;
    if (!input.fullscreen && (!frame || frame.redraw)) {
        const grid = dark ? 0x18201e : 0xdce2df;
        for (let x = 24; x < screen.width - 20; x += 20) screen.fillRect(x, top, 1, bottom - top, grid);
        for (let y = top; y < bottom; y += 20) screen.fillRect(24, y, screen.width - 48, 1, grid);
        if (frame) frame.grid = { top, bottom, color: grid };
    }
    drawCat(screen, view, input, (top + bottom) / 2, input.fullscreen ? 14 : 11, { top, bottom });
    if (input.fullscreen) {
        if (frame && !frame.redraw) screen.fillRect(screen.width / 2 - 80, captionTop - 27, 165, 17, frame.background);
        waveform(screen, view, input, captionTop - 19, view.state === 'error' ? 0xf07979 : accent);
    }
    const hint = view.state === 'idle' || view.state === 'sleep' ? `${CHARACTER_NAMES[input.character || 'cat']} · 长按换装` : '';
    const captionKey = JSON.stringify([progress, status, fallback, hint, view.errorText, view.assistantText, view.userText]);
    if (frame && !frame.redraw && frame.captionKey === captionKey) return;
    if (frame) {
        if (!frame.redraw) screen.fillRect(0, input.fullscreen ? captionTop : statusY, screen.width, screen.height - (input.fullscreen ? captionTop : statusY), frame.background);
        frame.captionKey = captionKey;
    }
    if (!input.fullscreen) center(screen, wrapText(screen, progress || status, screen.width - 40, 1)[0] || '', statusY, view.state === 'error' ? 0xf07979 : accent);
    const reply = view.errorText || view.assistantText;
    let y = captionTop;
    if (input.fullscreen && progress) {
        label(screen, wrapText(screen, progress, screen.width - 40, 1)[0] || '', 20, y, accent);
        y += line;
    }
    if (view.userText && reply) {
        label(screen, wrapText(screen, view.userText, screen.width - 40, 1)[0] || '', 20, y, quiet);
        y += line;
    }
    const text = reply || view.userText || fallback || hint;
    const available = Math.max(1, Math.min(2, Math.floor((screen.height - y - 8) / line)));
    wrapText(screen, text, screen.width - 40, available).forEach((value, i) => label(screen, value, 20, y + i * line, !view.assistantText && view.errorText ? 0xf07979 : fg));
}

export function pairingKeyAt(x: number, y: number, width: number): string | null {
    if (y < 233 || y >= 417 || x < 22 || x >= width - 22) return null;
    const col = Math.floor((x - 22) / ((width - 44) / 3));
    const row = Math.floor((y - 233) / 46);
    return ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'][row * 3 + col] ?? null;
}

export function drawScene(target: Screen, view: ViewState, input: RenderInput): void {
    const screen = layoutScreen(target);
    try { renderScene(screen, view, input); } finally { screen.finish(); }
}

function renderScene(screen: Screen, view: ViewState, input: RenderInput): void {
    const dark = view.theme === 'dark';
    const bg = dark ? 0x080b0b : 0xeff1f1;
    const fg = dark ? 0xeef2ee : 0x121714;
    const quiet = dark ? 0x8b9791 : 0x59645e;
    const line = dark ? 0x26302b : 0xd3d9d5;
    const accent = dark ? 0xc4f27c : 0x477f18;
    const W = screen.width;
    const companion = !input.settings && view.state !== 'pairing' && !(view.state === 'error' && !view.authenticated && view.phoneName);
    const redraw = beginScene(screen, sceneKey(view, input) + (companion ? '' : JSON.stringify(view.errorText)), bg);
    if (redraw) companionHeader(screen, 'OBEING PIXEL', view, input);
    if (input.fullscreen) { companionBody(screen, view, input, '', view.authenticated ? '' : view.errorText); return; }
    if (redraw) {
        icon(screen, view.muted ? 'mute' : 'mic', W - 116, 42, view.muted ? 0xf07979 : accent);
        icon(screen, 'theme', W - 78, 43, fg);
        icon(screen, 'link', W - 39, 44, fg);
    }

    if (input.settings) {
        drawCat(screen, view, input, 150, 4.4);
        if (!redraw) return;
        center(screen, wrapText(screen, view.displayName || '手机尚未登录', W - 44, 1)[0] || '', 231, fg);
        center(screen, wrapText(screen, view.enterpriseId ? `企业 ${view.enterpriseId}` : '等待手机同步账号', W - 44, 1)[0] || '', 255, quiet);
        center(screen, wrapText(screen, view.phoneName || 'Obeing Pixel APP', W - 44, 1)[0] || '', 282, quiet);
        screen.fillRect(22, 327, W - 44, 1, line);
        icon(screen, 'unlink', 33, 354, 0xe8876b);
        label(screen, '断开手机连接', 62, 355, fg);
        icon(screen, 'back', 34, 409, quiet);
        label(screen, '返回', 62, 408, quiet);
        return;
    }

    if (view.state === 'pairing' || (view.state === 'error' && !view.authenticated && view.phoneName)) {
        if (view.pairingPending) {
            drawCat(screen, view, input, 171, 6.5);
            if (!redraw) return;
            center(screen, '正在连接手机', 288, fg);
            center(screen, wrapText(screen, view.phoneName, W - 44, 1)[0] || '', 316, quiet);
            center(screen, '取消', 397, quiet);
            return;
        }
        if (!redraw) return;
        center(screen, '手机配对码', 85, fg);
        center(screen, wrapText(screen, view.phoneName, W - 44, 1)[0] || '', 112, quiet);
        for (let i = 0; i < 6; i++) {
            const x = Math.round(W / 2 - 120 + i * 42);
            screen.fillRect(x, 163, 27, 2, line);
            label(screen, view.pairingCode[i] || '', x + 8, 139, accent);
        }
        const message = view.errorText || '输入一次，后续自动连接';
        center(screen, wrapText(screen, message, W - 32, 1)[0] || '', 188, quiet);
        const keyWidth = (W - 44) / 3;
        for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 3; col++) {
                const key = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'][row * 3 + col];
                const x = Math.round(22 + col * keyWidth + keyWidth / 2);
                const y = 247 + row * 46;
                if (key === 'back') icon(screen, 'back', x - 5, y, fg);
                else if (key === 'ok') icon(screen, 'check', x - 5, y, view.pairingCode.length === 6 ? accent : quiet);
                else label(screen, key, x - screen.measureText(key, { font: 'pixel12' }).width / 2, y, fg);
            }
        }
        return;
    }

    const fallback = view.authenticated ? '' : view.state === 'login' ? '请在手机登录' : '正在发现 Obeing Pixel 手机';
    companionBody(screen, view, input, LABEL[view.state], fallback);
}
