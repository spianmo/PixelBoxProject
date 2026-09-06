import { facePoints, poseFor, rasterizeCat, projectPoint, posedShapePoint, type AssistantState, type Pose } from './model';
import type { ViewState } from './state';
import { layoutScreen, lineHeight, textHeight, type Screen } from './layout';

export type { Screen } from './layout';
export interface RenderInput { clock: number; tiltX: number; tiltY: number; battery: number; settings: boolean; fullscreen?: boolean; pose?: Pose; shake?: number }

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
    const lines: string[] = [];
    let line = '';
    for (const ch of value) {
        if (ch === '\n') { lines.push(line); line = ''; continue; }
        if (line && screen.measureText(line + ch, { font: 'pixel12' }).width > width) { lines.push(line); line = ch; }
        else line += ch;
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
    const pose = input.pose || poseFor(view.state, input.clock, input.tiltX, input.tiltY, view.level);
    let runs = rasterizeCat(pose, scale, screen.width / 2, cy);
    const bounds = () => {
        let left = screen.width / 2 - 13 * scale, right = screen.width / 2 + 13 * scale;
        let top = Infinity, bottom = -Infinity;
        for (let i = 0; i < runs.count; i++) {
            left = Math.min(left, runs.x[i] - runs.step);
            right = Math.max(right, runs.x[i] + runs.width[i] + runs.step + 1);
            top = Math.min(top, runs.y[i] - runs.step);
            bottom = Math.max(bottom, runs.y[i] + 2 * runs.step + 1);
        }
        return { left, right, top, bottom };
    };
    let dx = 0, dy = 0;
    if (region) {
        let box = bounds();
        const fit = Math.min(1, (screen.width - 32) / (box.right - box.left), (region.bottom - region.top) / (box.bottom - box.top));
        if (fit < 1) { scale *= fit * 0.97; runs = rasterizeCat(pose, scale, screen.width / 2, cy); box = bounds(); }
        dx = box.left < 12 ? 12 - box.left : box.right > screen.width - 12 ? screen.width - 12 - box.right : 0;
        dy = box.top < region.top ? region.top - box.top : box.bottom > region.bottom ? region.bottom - box.bottom : 0;
    }
    const step = runs.step;
    // Close single-cell projection pinholes while retaining the gap between ears.
    let count = 0;
    for (let i = 0; i < runs.count; i++) {
        const gap = count ? runs.x[i] - runs.x[count - 1] - runs.width[count - 1] : Infinity;
        if (count && runs.y[i] === runs.y[count - 1] && gap <= step) runs.width[count - 1] = runs.x[i] + runs.width[i] - runs.x[count - 1];
        else { runs.x[count] = runs.x[i]; runs.y[count] = runs.y[i]; runs.width[count++] = runs.width[i]; }
    }
    runs.count = count;
    const paint = (x: number, y: number, w: number, h: number, color: number) => screen.fillRect(x + dx, y + dy, w, h, color);
    for (const layer of [{ dx: step, dy: -step, color: 0x2050ef }, { dx: -step, dy: step, color: 0xe31c35 }, { dx: Math.ceil(step / 2), dy: 0, color: 0x17f5f5 }, { dx: -Math.ceil(step / 2), dy: 1, color: 0xf9fb54 }, { dx: 0, dy: 0, color: 0xffffff }]) {
        for (let i = 0; i < runs.count; i++) paint(runs.x[i] + layer.dx, runs.y[i] + layer.dy, runs.width[i] + 1, step + 1, layer.color);
    }
    // 眼睛和嘴位于前表面，随同一视图矩阵旋转，不贴死在屏幕坐标。
    if (Math.cos(pose.yaw) > 0.15) {
        for (const voxel of facePoints(view.state, input.clock, view.level)) {
            const p = projectPoint(posedShapePoint(voxel, pose), pose, scale, screen.width / 2, cy);
            const x = Math.round(p.sx / step) * step, y = Math.round(p.sy / step) * step;
            if (input.shake && voxel.y < 2) paint(x - Math.max(1, Math.floor(step / 2)), y, step, step, 0xf9fb54);
            paint(x, y, step + 1, step + 1, 0x0d1210);
        }
    }
    // 参考素材中的离散色边在头部边缘形成短扫描线，线条亦跟随视差。
    const scan = Math.floor(input.clock / 70) % 3;
    for (let i = 0; i < (input.shake ? 3 : 0); i++) {
        const y = cy + (i * 5 - 6 + scan) * scale;
        const x = screen.width / 2 + (i % 2 ? 8 : -12) * scale;
        paint(x, y, 4 * scale, Math.max(2, step - 1), i % 2 ? 0x17f5f5 : 0xf9fb54);
        paint(x + scale, y, 2 * scale, Math.max(2, step - 1), 0xffffff);
    }
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
    const dark = view.theme === 'dark', fg = dark ? 0xeef2ee : 0x121714;
    const quiet = dark ? 0x8b9791 : 0x59645e, accent = dark ? 0xc4f27c : 0x477f18;
    const line = lineHeight(screen, 17);
    const progress = view.thinkingText;
    const captionTop = screen.height - (line * 2 + textHeight(screen) + 12 + (input.fullscreen && progress ? line : 0));
    const statusY = captionTop - 34;
    const top = input.fullscreen ? 42 : 83, bottom = input.fullscreen ? captionTop - 38 : statusY - 8;
    if (!input.fullscreen) {
        const grid = dark ? 0x18201e : 0xdce2df;
        for (let x = 24; x < screen.width - 20; x += 20) screen.fillRect(x, top, 1, bottom - top, grid);
        for (let y = top; y < bottom; y += 20) screen.fillRect(24, y, screen.width - 48, 1, grid);
    }
    drawCat(screen, view, input, (top + bottom) / 2, input.fullscreen ? 14 : 11, { top, bottom });
    if (input.fullscreen) waveform(screen, view, input, captionTop - 19, view.state === 'error' ? 0xf07979 : accent);
    else center(screen, wrapText(screen, progress || status, screen.width - 40, 1)[0] || '', statusY, view.state === 'error' ? 0xf07979 : accent);
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
    const text = reply || view.userText || fallback;
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
    screen.clear(bg);
    companionHeader(screen, 'OBEING PIXEL', view, input);
    if (input.fullscreen) { companionBody(screen, view, input, '', view.authenticated ? '' : view.errorText); return; }
    icon(screen, view.muted ? 'mute' : 'mic', W - 116, 42, view.muted ? 0xf07979 : accent);
    icon(screen, 'theme', W - 78, 43, fg);
    icon(screen, 'link', W - 39, 44, fg);

    if (input.settings) {
        drawCat(screen, view, input, 150, 4.4);
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
            center(screen, '等待手机确认', 288, fg);
            center(screen, wrapText(screen, view.phoneName, W - 44, 1)[0] || '', 316, quiet);
            center(screen, '取消', 397, quiet);
            return;
        }
        center(screen, '手机配对码', 85, fg);
        center(screen, wrapText(screen, view.phoneName, W - 44, 1)[0] || '', 112, quiet);
        for (let i = 0; i < 6; i++) {
            const x = Math.round(W / 2 - 120 + i * 42);
            screen.fillRect(x, 163, 27, 2, line);
            label(screen, view.pairingCode[i] || '', x + 8, 139, accent);
        }
        const message = view.errorText || '连接后等待手机确认';
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
