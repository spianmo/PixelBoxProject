import { beginScene, sceneKey, companionBody, companionHeader, wrapText, type RenderInput, type Screen } from '../../06-obeing-pixel/src/render';
import type { ViewState } from '../../06-obeing-pixel/src/state';
import { layoutScreen, lineHeight, textHeight } from '../../06-obeing-pixel/src/layout';
import { WAKEWORD_CONFIG } from './wakeword-config';

export type Field = 'tenant' | 'account' | 'password' | 'region' | 'key' | 'origin' | 'oem' | 'domain' | 'question';
export type Page = 'assistant' | 'login' | 'speech' | 'server' | 'settings' | 'editor';
export interface FormState {
    page: Page;
    returnPage: Page;
    field: Field;
    values: Record<Field, string>;
    upper: boolean;
    symbols: boolean;
    busy: boolean;
    speechReady: boolean;
}

export const FIELD_LABELS: Record<Field, string> = {
    tenant: '企业 ID', account: '账号', password: '密码', region: '语音区域', key: '语音密钥',
    origin: '服务地址', oem: 'OEM', domain: '企业域', question: '说点什么',
};
const LETTER_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const SYMBOL_ROWS = ['!@#$%^&*()', '-_=+[]{}<>', '/:;,.?\\|', '`~\'"'];
const LABELS: Record<string, string> = { wake: '我在', listening: '正在聆听', thinking: '思考中',
    speaking: '小川正在回答', muted: '麦克风已关闭', error: '等待恢复', sleep: '在这里陪你' };

function palette(view: ViewState) {
    return view.theme === 'dark' ? { bg: 0x080b0b, fg: 0xeef2ee, quiet: 0x99aaa0, line: 0x2e3932, accent: 0xc4f27c, input: 0x171e1a }
        : { bg: 0xeff1f1, fg: 0x121714, quiet: 0x59645e, line: 0xc7d1ca, accent: 0x477f18, input: 0xffffff };
}

function text(screen: Screen, value: string, x: number, y: number, color: number): void {
    screen.drawText(value, x, y, { font: 'pixel12', color });
}
function center(screen: Screen, value: string, y: number, color: number): void {
    text(screen, value, Math.round((screen.width - screen.measureText(value, { font: 'pixel12' }).width) / 2), y, color);
}
function short(screen: Screen, value: string, width: number): string { return wrapText(screen, value, width, 1)[0] || ''; }

function icon(screen: Screen, name: 'back' | 'mute' | 'mic' | 'theme' | 'settings' | 'delete' | 'check', x: number, y: number, color: number): void {
    const icons = {
        back: ['00100', '01000', '11111', '01000', '00100'],
        mute: ['10001', '01010', '00100', '01010', '10001'],
        mic: ['01110', '01110', '01110', '10101', '10001', '01110', '00100'],
        theme: ['0011100', '0100010', '1000101', '1001101', '1011101', '0111110', '0011100'],
        settings: ['0101010', '1111111', '0110110', '1100011', '0110110', '1111111', '0101010'],
        delete: ['0011111', '0100001', '1001011', '1010101', '1001011', '0100001', '0011111'],
        check: ['000001', '000010', '100100', '011000'],
    };
    const size = 2 * Math.max(1, textHeight(screen) / 12);
    icons[name].forEach((row, y1) => { for (let x1 = 0; x1 < row.length; x1++) if (row[x1] === '1') screen.fillRect(x + x1 * size, y + y1 * size, size, size, color); });
}

export function keyboardRows(form: FormState): string[] {
    const rows = form.symbols ? SYMBOL_ROWS : LETTER_ROWS;
    return rows.map((value) => form.upper && !form.symbols ? value.toUpperCase() : value);
}

export function keyboardKeyAt(form: FormState, x: number, y: number, width: number): string | null {
    if (y >= 386 && y < 434) {
        if (x < width / 4) return 'shift';
        if (x < width / 2) return 'symbols';
        if (x < width * 3 / 4) return 'space';
        return 'done';
    }
    if (y >= 115 && y < 159 && x > width - 60) return 'delete';
    if (y < 176 || y >= 368 || x < 8 || x >= width - 8) return null;
    const row = Math.floor((y - 176) / 48);
    const letters = keyboardRows(form)[row];
    const cell = (width - 16) / 10;
    const left = (width - letters.length * cell) / 2;
    const index = Math.floor((x - left) / cell);
    return index >= 0 && index < letters.length ? letters[index] : null;
}

function field(screen: Screen, view: ViewState, form: FormState, name: Field, y: number): void {
    const p = palette(view);
    text(screen, FIELD_LABELS[name], 22, y, p.quiet);
    screen.fillRect(22, y + 26, screen.width - 44, 32, p.input);
    const value = form.values[name];
    const visible = name === 'password' || name === 'key' ? '*'.repeat(Math.min(value.length, 40)) : value;
    text(screen, short(screen, visible || '--', screen.width - 68), 32, y + 26 + (32 - textHeight(screen)) / 2, value ? p.fg : p.quiet);
}

export function drawHarness(target: Screen, view: ViewState, input: RenderInput, form: FormState,
    wakePhrase: string = WAKEWORD_CONFIG.phrase): void {
    const screen = layoutScreen(target);
    try { renderHarness(screen, view, input, form, wakePhrase); } finally { screen.finish(); }
}

function renderHarness(screen: Screen, view: ViewState, input: RenderInput, form: FormState, wakePhrase: string): void {
    const p = palette(view);
    const W = screen.width;
    const redraw = beginScene(screen, sceneKey(view, input) + JSON.stringify(form.page === 'assistant'
        ? [form.page, wakePhrase] : [form, view.errorText, view.thinkingText]), p.bg);
    if (form.page === 'assistant') {
        if (redraw) companionHeader(screen, 'ObeingHarness', view, input);
        if (redraw && !input.fullscreen) {
            icon(screen, view.muted ? 'mute' : 'mic', W - 116, 43, p.accent);
            icon(screen, 'theme', W - 78, 43, p.fg);
            icon(screen, 'settings', W - 38, 43, p.fg);
        }
        companionBody(screen, view, input, view.state === 'idle' ? short(screen, wakePhrase, screen.width - 44) : LABELS[view.state] || '小川');
        return;
    }
    if (!redraw) return;
    text(screen, 'ObeingHarness', 20, 19, p.fg);
    if (input.battery >= 0) text(screen, `${input.battery}%`, W - 54, 19, p.quiet);
    icon(screen, 'back', 23, 49, p.fg);
    icon(screen, 'theme', W - 43, 47, p.fg);
    if (form.page === 'editor') {
        center(screen, FIELD_LABELS[form.field], 52, p.fg);
        const value = form.values[form.field];
        const visible = form.field === 'password' || form.field === 'key' ? '*'.repeat(value.length) : value;
        screen.fillRect(18, 94, W - 36, 63, p.input);
        wrapText(screen, visible, W - 94, 2).forEach((line, i) => text(screen, line, 27, 101 + i * lineHeight(screen, 19), p.fg));
        icon(screen, 'delete', W - 45, 119, p.quiet);
        const rows = keyboardRows(form);
        const cell = (W - 16) / 10;
        rows.forEach((letters, row) => {
            const left = (W - letters.length * cell) / 2;
            for (let i = 0; i < letters.length; i++) {
                const x = left + i * cell;
                screen.fillRect(Math.round(x + 2), 176 + row * 48, Math.floor(cell - 4), 40, p.input);
                text(screen, letters[i], Math.round(x + (cell - screen.measureText(letters[i], { font: 'pixel12' }).width) / 2), 176 + row * 48 + (40 - textHeight(screen)) / 2, p.fg);
            }
        });
        text(screen, form.upper ? 'abc' : 'ABC', 22, 403, p.fg);
        text(screen, form.symbols ? 'abc' : '#+=', W / 4 + 18, 403, p.fg);
        text(screen, '空格', W / 2 + 18, 403, p.quiet);
        icon(screen, 'check', W * 3 / 4 + 28, 404, p.accent);
        return;
    }
    if (form.page === 'settings') {
        center(screen, short(screen, view.displayName || '设备设置', W - 44), 93, p.fg);
        center(screen, short(screen, view.enterpriseId ? `企业 ${view.enterpriseId}` : '独立联网', W - 44), 118, p.quiet);
        const rows = [form.speechReady ? '语音服务 · 已配置' : '语音服务 · 未配置', '企业服务器',
            ...(view.authenticated ? ['文字提问', '退出登录'] : ['企业登录'])];
        rows.forEach((line, i) => {
            screen.fillRect(22, 159 + i * 57, W - 44, 1, p.line);
            text(screen, line, 28, 181 + i * 57, i === 3 ? 0xe47878 : p.fg);
        });
        return;
    }
    const fields: Field[] = form.page === 'login' ? ['tenant', 'account', 'password']
        : form.page === 'speech' ? ['region', 'key'] : ['origin', 'oem', 'domain'];
    center(screen, form.page === 'login' ? '企业登录' : form.page === 'speech' ? '设备语音' : '企业服务器', 53, p.fg);
    fields.forEach((name, index) => field(screen, view, form, name, 94 + index * 65));
    const y = form.page === 'speech' ? 252 : 314;
    screen.fillRect(22, y, W - 44, 43, form.busy ? p.line : p.accent);
    center(screen, form.busy ? '正在登录' : form.page === 'login' ? '登录' : '保存', y + (43 - textHeight(screen)) / 2, view.theme === 'dark' && !form.busy ? 0x17200f : p.bg);
    const status = view.errorText || view.thinkingText;
    if (status) wrapText(screen, status, W - 44, 2).forEach((line, i) => text(screen, line, 22, y + 50 + i * lineHeight(screen, 17), 0xe47878));
    if (form.page === 'login') text(screen, '服务设置', 22, 419, p.quiet);
}
