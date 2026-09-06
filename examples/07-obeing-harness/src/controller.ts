import { initialState, type ViewState } from '../../06-obeing-pixel/src/state';
import { EnterpriseAuth, type ServerConfig, type Session } from './auth';
import { MexusConversation } from './conversation';

export const WAKE_PHRASE = '你好小川';
export interface SpeechConfig { region: string; key: string; language?: string; voice?: string }
export interface SpeechPort {
    available(): boolean;
    configure(config: SpeechConfig): void;
    wakeword: { start(options: { phrase: '你好小川'; onWake(): void; onError?(message: string): void }): Promise<void>; stop(): void };
    recognize(options: { maxMs: number; silenceMs: number; timeoutMs: number; onLevel(level: number): void }): Promise<string>;
    speak(text: string): Promise<void>;
    cancel(): void;
}

export class HarnessController {
    readonly view: ViewState = initialState();
    private generation = 0;
    private busy = false;
    private disposed = false;
    private speechConfigured = false;
    private wakeGeneration = 0;
    private wakeStarted = false;
    private paused = true;

    constructor(readonly auth: EnterpriseAuth, readonly conversation: MexusConversation,
        private readonly speech: SpeechPort, private readonly online: () => boolean) {
        this.view.state = 'login';
        this.view.phoneName = 'ObeingHarness';
    }

    configureSpeech(config: SpeechConfig): void {
        if (!/^[a-z][a-z0-9]{0,39}$/.test(config.region.trim()) || !/^[A-Za-z0-9+/=_-]{16,256}$/.test(config.key.trim()))
            throw new Error('请输入有效语音区域和密钥');
        if (!this.speech.available()) throw new Error('此固件未启用独立语音能力');
        this.cancel();
        this.speech.configure({ region: config.region.trim(), key: config.key.trim(), language: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural' });
        this.speechConfigured = true;
        this.view.errorText = '';
        void this.standby();
    }

    async login(tenant: string, user: string, password: string): Promise<void> {
        this.logout();
        const generation = this.generation;
        if (!this.online()) { this.view.errorText = 'PixelBox 尚未连接 Wi-Fi'; return; }
        this.busy = true;
        this.view.state = 'login';
        this.view.thinkingText = '正在登录';
        try {
            const account = await this.auth.login(tenant, user, password);
            if (!this.active(generation)) return;
            this.applyIdentity(account);
            this.view.errorText = '';
            this.view.thinkingText = '';
            this.busy = false;
            await this.standby();
        } catch (error) {
            if (!this.active(generation)) return;
            this.busy = false;
            this.view.thinkingText = '';
            this.view.errorText = userMessage(error, '企业登录失败');
            this.view.state = 'login';
        }
    }

    private applyIdentity(account: Session): void {
        this.view.authenticated = true;
        this.view.connected = true;
        this.view.displayName = account.nickname || account.userCode;
        this.view.enterpriseId = account.tenantCode;
    }

    async restore(): Promise<void> {
        if (!this.auth.current() || !this.online() || this.disposed) return;
        const generation = this.generation;
        this.busy = true;
        try {
            const account = await this.auth.valid();
            if (!this.active(generation)) return;
            this.applyIdentity(account);
            this.view.state = 'idle';
            this.view.errorText = '';
        } catch (error) {
            if (this.active(generation)) this.view.errorText = userMessage(error, '登录恢复失败，请重试');
        } finally { if (this.active(generation)) this.busy = false; }
    }

    async listen(): Promise<void> {
        if (this.disposed || this.paused || !this.view.authenticated || this.view.muted) return;
        this.cancel();
        const generation = this.generation;
        if (!this.online()) { this.view.errorText = 'Wi-Fi 已断开'; this.view.state = 'error'; return; }
        if (!this.speechConfigured) { this.view.errorText = '请先配置设备语音区域和密钥'; this.view.state = 'error'; return; }
        this.busy = true;
        this.clearTurn();
        this.view.state = 'listening';
        try {
            const transcript = await this.speech.recognize({ maxMs: 15000, silenceMs: 800, timeoutMs: 20000,
                onLevel: (level) => { if (this.active(generation)) this.view.level = Math.max(0, Math.min(100, level)); } });
            if (!this.active(generation)) return;
            const text = transcript.trim();
            if (!text) throw new Error('没有听到内容，请再说一次');
            this.view.userText = text;
            await this.respond(text, generation);
        } catch (error) { await this.turnFailed(error, generation); }
    }

    async sendText(text: string): Promise<void> {
        if (!this.view.authenticated || this.disposed || this.paused || !text.trim()) return;
        this.cancel();
        const generation = this.generation;
        this.clearTurn();
        this.busy = true;
        this.view.userText = text.trim();
        try { await this.respond(text.trim(), generation); }
        catch (error) { await this.turnFailed(error, generation); }
    }

    private async respond(text: string, generation: number): Promise<void> {
        this.view.state = 'thinking';
        const answer = await this.conversation.ask(text, {
            answer: (value) => { if (this.active(generation)) this.view.assistantText = value.slice(-2400); },
            progress: (value) => { if (this.active(generation)) this.view.thinkingText = value; },
        });
        if (!this.active(generation)) return;
        this.view.assistantText = answer.slice(-2400);
        this.view.level = 0;
        if (answer && this.speechConfigured && !this.view.muted) {
            this.view.state = 'speaking';
            // 原生 speak Promise 仅在扬声器实际播完后结束，整个播报期间保持关闭唤醒。
            for (const part of speechParts(answer)) {
                if (!this.active(generation)) return;
                await this.speech.speak(part);
            }
        }
        if (!this.active(generation)) return;
        this.busy = false;
        await this.standby();
    }

    private async turnFailed(error: unknown, generation: number): Promise<void> {
        if (!this.active(generation)) return;
        this.busy = false;
        this.view.level = 0;
        this.view.errorText = userMessage(error, '本轮未完成，请重试');
        if (!this.auth.current()) {
            this.logout();
            this.view.errorText = '登录已过期，请重新登录';
            return;
        }
        await this.standby();
    }

    async standby(): Promise<void> {
        if (this.disposed || this.paused || this.busy || !this.view.authenticated) return;
        this.view.state = this.view.muted ? 'muted' : 'idle';
        if (this.view.muted || !this.speechConfigured || !this.online() || this.wakeStarted) return;
        const generation = ++this.wakeGeneration;
        this.wakeStarted = true;
        try {
            await this.speech.wakeword.start({ phrase: WAKE_PHRASE, onWake: () => {
                if (generation !== this.wakeGeneration || this.paused || !this.wakeStarted || !this.view.authenticated || this.view.muted || this.busy) return;
                this.view.state = 'wake';
                void this.listen();
            }, onError: (message) => {
                if (generation !== this.wakeGeneration) return;
                this.wakeStarted = false;
                this.view.errorText = userMessage(new Error(message), '本地唤醒已停止，点击小川重试');
            } });
            if (generation !== this.wakeGeneration) return;
        } catch (error) {
            if (generation !== this.wakeGeneration) return;
            this.wakeStarted = false;
            this.view.errorText = userMessage(error, '本地唤醒不可用，点击小川开始');
        }
    }

    cancel(): void {
        this.generation++;
        this.wakeGeneration++;
        this.wakeStarted = false;
        this.busy = false;
        this.conversation.cancel();
        this.speech.wakeword.stop();
        this.speech.cancel();
        this.view.level = 0;
    }

    /** 非助手页面暂停全部音频；恢复后由显式页面动作选择待机或立即录音。 */
    setPaused(paused: boolean): void {
        if (this.paused === paused) return;
        this.paused = paused;
        if (paused) this.cancel();
    }

    toggleMute(): void {
        this.view.muted = !this.view.muted;
        this.cancel();
        if (this.view.authenticated) void this.standby();
    }

    networkChanged(connected: boolean): void {
        if (!connected) {
            this.cancel();
            if (!this.view.authenticated && !this.auth.current()) this.auth.clear(false);
            if (this.view.authenticated) { this.view.state = 'error'; this.view.errorText = 'Wi-Fi 已断开'; }
        } else if (this.view.authenticated) { this.view.errorText = ''; void this.standby(); }
    }

    logout(persist = true): void {
        this.cancel();
        this.auth.clear(persist);
        this.view.authenticated = false;
        this.view.connected = false;
        this.view.state = 'login';
        this.view.displayName = '';
        this.view.enterpriseId = '';
        this.clearTurn();
    }

    dispose(): void { this.logout(false); this.disposed = true; }
    isBusy(): boolean { return this.busy; }
    hasSpeech(): boolean { return this.speechConfigured; }
    private active(generation: number): boolean { return !this.disposed && generation === this.generation; }
    private clearTurn(): void { this.view.userText = ''; this.view.assistantText = ''; this.view.thinkingText = ''; this.view.errorText = ''; }
}

export function userMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    // 原生底层错误不透出 URL、服务响应或密钥，只保留面向用户的有限描述。
    const message = error.message;
    if (message === 'ENOTSUP: 需要 speech 固件及 16 kHz 音频硬件')
        return '语音引擎启动失败，请更新固件后重启';
    if (/^[\u3400-\u9fff\s，。：、？！A-Za-z0-9-]{1,100}$/.test(message) && !/https|token|key|Bearer/i.test(message)) return message;
    return fallback;
}

export function defaultServer(deviceId: string): ServerConfig {
    return { origin: 'https://v4.teamhelper.cn', domain: '', oem: '', deviceId };
}

/** 同时限制字节和朗读长度，避免长中文超过单段播放时限，且不拆开 Unicode 字符。 */
export function speechParts(text: string): string[] {
    const encoder = new TextEncoder();
    const parts: string[] = [];
    let part = '';
    let bytes = 0;
    let characters = 0;
    for (const character of text) {
        const size = encoder.encode(character).byteLength;
        if ((bytes + size > 5400 || characters >= 240) && part) {
            parts.push(part); part = ''; bytes = 0; characters = 0;
        }
        part += character; bytes += size; characters++;
        if (characters >= 120 && /[。！？.!?\n]/.test(character)) {
            parts.push(part); part = ''; bytes = 0; characters = 0;
        }
    }
    if (part) parts.push(part);
    return parts;
}
