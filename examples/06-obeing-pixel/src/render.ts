import { facePoints, poseFor, projectCat, projectPoint, type AssistantState } from './model';
import type { ViewState } from './state';

export type Screen = Pick<PxScreen, 'width' | 'height' | 'clear' | 'fillRect' | 'drawText' | 'measureText'>;
export interface RenderInput { clock: number; tiltX: number; tiltY: number; battery: number; settings: boolean }

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

export function drawCat(screen: Screen, view: ViewState, input: RenderInput, cy: number, scale: number): number {
    const pose = poseFor(view.state, input.clock, input.tiltX, input.tiltY, view.level);
    const projected = projectCat(pose, scale, screen.width / 2, cy);
    const step = Math.max(2, Math.round(scale));
    // 深度排序后落入显示网格，只保留每个像素粒子最近的一层，控制真机绘制调用量。
    const grid = new Map<string, { x: number; y: number }>();
    for (const p of projected) {
        const x = Math.round(p.sx / step) * step;
        const y = Math.round(p.sy / step) * step;
        grid.set(`${x},${y}`, { x, y });
    }
    const pixels = Array.from(grid.values()).sort((a, b) => a.y - b.y || a.x - b.x);
    const runs: Array<{ x: number; y: number; width: number }> = [];
    for (const pixel of pixels) {
        const previous = runs[runs.length - 1];
        if (previous && previous.y === pixel.y && previous.x + previous.width === pixel.x) previous.width += step;
        else runs.push({ x: pixel.x, y: pixel.y, width: step });
    }
    for (const layer of [{ dx: step, dy: -step, color: 0x2050ef }, { dx: -step, dy: step, color: 0xe31c35 }, { dx: Math.ceil(step / 2), dy: 0, color: 0x17f5f5 }, { dx: -Math.ceil(step / 2), dy: 1, color: 0xf9fb54 }, { dx: 0, dy: 0, color: 0xffffff }]) {
        for (const run of runs) screen.fillRect(run.x + layer.dx, run.y + layer.dy, run.width + 1, step + 1, layer.color);
    }
    // 眼睛和嘴位于前表面，随同一视图矩阵旋转，不贴死在屏幕坐标。
    if (Math.cos(pose.yaw) > 0.15) {
        for (const voxel of facePoints(view.state, input.clock, view.level)) {
            const p = projectPoint(voxel, pose, scale, screen.width / 2, cy);
            screen.fillRect(Math.round(p.sx / step) * step, Math.round(p.sy / step) * step, step, step, 0x0d1210);
        }
    }
    // 参考素材中的离散色边在头部边缘形成短扫描线，线条亦跟随视差。
    const offset = Math.round(input.tiltX * 8);
    screen.fillRect(screen.width / 2 - 12 * scale + offset, cy - 4 * scale, 4 * scale, 2, 0xf9fb54);
    screen.fillRect(screen.width / 2 + 8 * scale + offset, cy + 2 * scale, 4 * scale, 2, 0x17f5f5);
    return pixels.length;
}

export function pairingKeyAt(x: number, y: number, width: number): string | null {
    if (y < 233 || y >= 417 || x < 22 || x >= width - 22) return null;
    const col = Math.floor((x - 22) / ((width - 44) / 3));
    const row = Math.floor((y - 233) / 46);
    return ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'][row * 3 + col] ?? null;
}

export function drawScene(screen: Screen, view: ViewState, input: RenderInput): void {
    const dark = view.theme === 'dark';
    const bg = dark ? 0x080b0b : 0xeff1f1;
    const fg = dark ? 0xeef2ee : 0x121714;
    const quiet = dark ? 0x8b9791 : 0x59645e;
    const line = dark ? 0x26302b : 0xd3d9d5;
    const accent = dark ? 0xc4f27c : 0x477f18;
    const W = screen.width;
    const H = screen.height;
    screen.clear(bg);
    label(screen, 'OBEING PIXEL', 20, 20, fg);
    if (input.battery >= 0) label(screen, `${input.battery}%`, W - 58, 20, quiet);
    screen.fillRect(20, 47, 5, 5, view.connected ? accent : 0xe8876b);
    label(screen, wrapText(screen, view.connected ? (view.displayName || 'PIXELBOX') : 'PIXELBOX', W - 172, 1)[0] || '', 32, 43, quiet);
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
                else label(screen, key, x - 3, y, fg);
            }
        }
        return;
    }

    // 参考素材的规则点阵作为投影参照，背景位移仅为前景的四分之一。
    const parallaxX = Math.round(input.tiltX * 3);
    const parallaxY = Math.round(input.tiltY * 3);
    for (let y = 82; y < 262; y += 12) for (let x = 34; x < W - 28; x += 12) screen.fillRect(x + parallaxX, y + parallaxY, 1, 1, line);
    drawCat(screen, view, input, 170, Math.min(7.8, (W - 116) / 29));
    center(screen, LABEL[view.state], 273, view.state === 'error' ? 0xf07979 : accent);
    if (view.state === 'listening' || view.state === 'speaking') {
        for (let i = 0; i < 24; i++) {
            const h = 2 + Math.round((0.4 + Math.abs(Math.sin(i * 1.5 + input.clock / 100))) * view.level / 12);
            screen.fillRect(W / 2 - 70 + i * 6, 300 - h / 2, 3, h, accent);
        }
    }
    screen.fillRect(20, 313, W - 40, 1, line);

    if (!view.authenticated) {
        const message = view.errorText || (view.state === 'login' ? '请在手机登录' : '正在发现 Obeing Pixel 手机');
        const lines = wrapText(screen, message, W - 44, 2);
        lines.forEach((value, i) => label(screen, value, 22, 335 + i * 19, fg));
        label(screen, view.state === 'login' ? '等待手机同步账号' : '同一 Wi-Fi', 22, H - 40, quiet);
        return;
    }
    if (view.userText) {
        const you = wrapText(screen, view.userText, W - 68, 1);
        label(screen, '你', 22, 330, quiet);
        label(screen, you[0] || '', 50, 330, fg);
    }
    const process = wrapText(screen, view.thinkingText || (view.state === 'listening' ? '正在识别语音' : view.state === 'thinking' ? '正在等待回答' : ''), W - 44, 1);
    if (process[0]) label(screen, process[0], 22, 354, accent);
    const reply = wrapText(screen, view.errorText || view.assistantText, W - 44, 3);
    reply.forEach((value, i) => label(screen, value, 22, 377 + i * 18, view.errorText ? 0xf07979 : fg));
}
