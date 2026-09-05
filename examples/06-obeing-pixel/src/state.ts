import type { AssistantState } from './model';

export const WAKE_WORD = '你好小川';
export const SERVICE_TYPE = '_obeing-pixel._tcp';
export const SAMPLE_RATE = 16000;
export const MAX_TEXT = 2400;
export interface ViewState {
    state: AssistantState;
    connected: boolean;
    authenticated: boolean;
    muted: boolean;
    theme: 'dark' | 'light';
    userText: string;
    assistantText: string;
    thinkingText: string;
    errorText: string;
    displayName: string;
    enterpriseId: string;
    phoneName: string;
    pairingCode: string;
    pairingPending: boolean;
    level: number;
}

export function initialState(): ViewState {
    return { state: 'offline', connected: false, authenticated: false, muted: false, theme: 'dark', userText: '', assistantText: '', thinkingText: '', errorText: '', displayName: '', enterpriseId: '', phoneName: '', pairingCode: '', pairingPending: false, level: 0 };
}

function text(value: unknown, length = MAX_TEXT): string {
    return typeof value === 'string' ? value.slice(-length) : '';
}

export function parseMessage(raw: string): Record<string, unknown> | null {
    if (raw.length > 16384) return null;
    try {
        const value: unknown = JSON.parse(raw);
        return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).type === 'string' ? value as Record<string, unknown> : null;
    } catch { return null; }
}

function applyPhoneAccount(view: ViewState, message: Record<string, unknown>): void {
    // 设备仅展示手机下发的账号状态；每次身份切换先清除上一账号的单轮内容。
    view.authenticated = message.authenticated === true;
    view.displayName = view.authenticated ? text(message.userDisplayName, 64) || text(message.account, 64) : '';
    view.enterpriseId = view.authenticated ? text(message.enterpriseId, 64) : '';
    view.userText = '';
    view.assistantText = '';
    view.thinkingText = '';
    view.errorText = '';
    view.level = 0;
    view.state = view.authenticated ? (view.muted ? 'muted' : 'idle') : 'login';
}

export function applyMessage(view: ViewState, message: Record<string, unknown>): void {
    switch (message.type) {
        case 'hello.pending':
            view.pairingPending = true;
            view.state = 'pairing';
            break;
        case 'hello.ok':
            view.connected = true;
            view.pairingPending = false;
            view.pairingCode = '';
            applyPhoneAccount(view, message);
            break;
        case 'account.state':
            // 账号推送不能代替六位码与手机确认，未配对或撤权后的连接不得开启采音。
            if (view.connected) applyPhoneAccount(view, message);
            break;
        case 'auth.required':
            applyPhoneAccount(view, { authenticated: false });
            break;
        case 'auth.revoked':
            disconnect(view);
            view.state = 'login';
            break;
        case 'wake':
            if (message.word !== WAKE_WORD || !view.authenticated || view.muted) break;
            view.state = 'wake';
            view.userText = '';
            view.assistantText = '';
            view.thinkingText = '';
            break;
        case 'state': {
            if (!view.authenticated) break;
            const next = message.state;
            if (next === 'idle' || next === 'listening' || next === 'thinking' || next === 'speaking' || next === 'muted' || next === 'error') {
                if (next === 'listening' && view.state !== 'listening' && view.state !== 'wake') {
                    view.userText = '';
                    view.assistantText = '';
                    view.thinkingText = '';
                }
                view.state = view.muted ? 'muted' : next;
                if (next !== 'error') view.errorText = '';
            }
            break;
        }
        case 'user.text':
            if (view.authenticated) view.userText = text(message.text);
            break;
        case 'assistant.delta':
        case 'assistant.text':
            // 手机协议发送累计全文；直接替换避免重连或重复包导致字幕重复。
            if (view.authenticated) view.assistantText = text(message.text);
            break;
        case 'thinking.status':
            if (view.authenticated) view.thinkingText = text(message.text, 300);
            break;
        case 'error':
            view.errorText = text(message.message, 160) || '连接暂不可用';
            view.state = 'error';
            view.pairingPending = false;
            break;
    }
}

export function disconnect(view: ViewState): void {
    view.connected = false;
    view.authenticated = false;
    view.state = 'offline';
    view.pairingPending = false;
    view.level = 0;
    // 连接即企业授权边界，断线后不能把上一账号的内容带入下一次配对。
    view.displayName = '';
    view.enterpriseId = '';
    view.userText = '';
    view.assistantText = '';
    view.thinkingText = '';
}

export function rmsLevel(pcm: ArrayBuffer): number {
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) return 0;
    const samples = new Int16Array(pcm);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
    return Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 400));
}
