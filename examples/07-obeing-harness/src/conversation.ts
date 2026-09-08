import { AuthError, EnterpriseAuth, record, string, type Session } from './auth';

export interface ConversationEvents { answer(text: string): void; progress(text: string): void }
export type SocketFactory = (url: string) => WebSocket;
interface Frame { v: number; type: string; id?: string; sid?: string; ts: number; payload: Record<string, unknown> }

export function envelope(type: string, id: string, sid: string, payload: Record<string, unknown>, now: number): Frame {
    return { v: 1, type, ...(id ? { id } : {}), ...(sid ? { sid } : {}), ts: now, payload };
}

export function hello(session: Session, deviceId: string, now: number): Frame {
    // platform 沿用服务端已接受的枚举；实际设备信息明确为 ESP32，不需要手机中继。
    return envelope('hello', `hello-${now}`, '', {
        companyId: session.tenantId, userId: session.userId, deviceId, token: session.token,
        platform: 'phone', capabilities: [],
        deviceMeta: { model: 'PixelBox', osVersion: 'ESP-IDF', appVersion: 'ObeingHarness/1.0.0', locale: 'zh-CN' },
    }, now);
}

export class MexusConversation {
    private generation = 0;
    private cancelCurrent: (() => void) | null = null;
    private idle: { socket: WebSocket; account: Session; sid: string; stop(): void } | null = null;
    private preparing: Promise<void> | null = null;
    private stopPreparing: (() => void) | null = null;
    private prepareGeneration = 0;

    constructor(private readonly auth: EnterpriseAuth, private readonly socketFactory: SocketFactory = (url) => new WebSocket(url),
        private readonly now: () => number = () => Date.now()) { }

    cancel(closeConnection = false): void {
        this.generation++;
        const cancel = this.cancelCurrent;
        this.cancelCurrent = null;
        cancel?.();
        if (closeConnection) {
            this.prepareGeneration++;
            this.stopPreparing?.();
            this.preparing = null;
            this.closeIdle();
        }
    }

    private matchesIdle(account: Session): boolean {
        return !!this.idle && this.idle.socket.readyState === 1
            && this.idle.socket.url === this.auth.config.origin.replace(/^https:/, 'wss:') + '/mexusclaw-socket'
            && this.idle.account.token === account.token && this.idle.account.userId === account.userId
            && this.idle.account.tenantId === account.tenantId;
    }

    prepare(): Promise<void> {
        if (this.preparing) return this.preparing;
        if (this.cancelCurrent) return Promise.resolve();
        const generation = this.prepareGeneration;
        // 待机/录音阶段先完成 TLS 和 hello，不等最终转写才串行握手，不发送用户问题。
        const preparing = this.auth.valid().then(account => {
            if (generation !== this.prepareGeneration || this.cancelCurrent || this.matchesIdle(account)) return;
            this.closeIdle();
            return new Promise<void>((resolve, reject) => {
                const socket = this.socketFactory(this.auth.config.origin.replace(/^https:/, 'wss:') + '/mexusclaw-socket');
                let terminal = false;
                const finish = (error?: Error, sid = '') => {
                    if (terminal) return;
                    terminal = true;
                    clearTimeout(timer);
                    socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
                    if (this.stopPreparing === stop) this.stopPreparing = null;
                    if (sid && generation === this.prepareGeneration && socket.readyState === 1) this.keepIdle(socket, account, sid);
                    else { try { socket.close(1000, 'prepare_end'); } catch { } }
                    if (error) reject(error); else resolve();
                };
                const stop = () => finish();
                const timer = setTimeout(() => finish(new Error('AI 握手超时')), 15000);
                this.stopPreparing = stop;
                const send = (frame: Frame) => {
                    try { socket.send(JSON.stringify(frame)); }
                    catch { finish(new Error('AI 连接已中断')); }
                };
                socket.onopen = () => send(hello(account, this.auth.config.deviceId, this.now()));
                socket.onclose = socket.onerror = () => finish(new Error('AI 网络连接失败'));
                socket.onmessage = event => {
                    if (terminal || typeof event.data !== 'string') return;
                    if (event.data.length > 65536) { finish(new Error('AI 响应过大')); return; }
                    try {
                        const frame = record(JSON.parse(event.data));
                        if (frame.v !== 1) return;
                        const payload = record(frame.payload);
                        if (frame.type === 'ping') send(envelope('pong', string(frame.id), '', { nonce: string(payload.nonce) }, this.now()));
                        if (frame.type === 'welcome') {
                            const sid = string(payload.sessionId);
                            finish(sid ? undefined : new Error('AI 服务未下发会话标识'), sid);
                        }
                        if (frame.type === 'error') finish(new Error('AI 服务暂时不可用'));
                    } catch { finish(new Error('AI 消息格式错误')); }
                };
            });
        });
        this.preparing = preparing;
        const clear = () => { if (this.preparing === preparing) this.preparing = null; };
        void preparing.then(clear, clear);
        return preparing;
    }

    private closeIdle(): void {
        const idle = this.idle;
        this.idle = null;
        if (!idle) return;
        idle.stop();
        idle.socket.onopen = null; idle.socket.onmessage = null; idle.socket.onclose = null; idle.socket.onerror = null;
        try { idle.socket.close(1000, 'session_end'); } catch { }
    }

    private keepIdle(socket: WebSocket, account: Session, sid: string): void {
        // 轮次结束后保留 TLS 和服务端会话；待机仍响应心跳，退出和换身份时显式释放。
        let lastFrameAt = this.now();
        const send = (frame: Frame) => {
            try { socket.send(JSON.stringify(frame)); } catch { this.closeIdle(); }
        };
        const heartbeat = setInterval(() => {
            if (this.idle?.socket !== socket) return;
            if (this.now() - lastFrameAt > 45000) { this.closeIdle(); return; }
            send(envelope('ping', '', sid, { nonce: `${this.now()}` }, this.now()));
        }, 15000);
        this.idle = { socket, account, sid, stop: () => clearInterval(heartbeat) };
        socket.onclose = socket.onerror = () => { if (this.idle?.socket === socket) this.closeIdle(); };
        socket.onmessage = (event) => {
            if (this.idle?.socket !== socket || typeof event.data !== 'string' || event.data.length > 65536) return;
            try {
                const frame = record(JSON.parse(event.data));
                if (frame.v !== 1) return;
                lastFrameAt = this.now();
                if (frame.type === 'ping') send(envelope('pong', string(frame.id), sid, { nonce: string(record(frame.payload).nonce) }, this.now()));
                if (frame.type === 'error') this.closeIdle();
            } catch { this.closeIdle(); }
        };
    }

    async ask(text: string, events: ConversationEvents): Promise<string> {
        this.cancel();
        if (!text.trim() || text.length > 2000) throw new Error('问题长度须为 1 至 2000 字');
        const generation = this.generation;
        let account = await this.auth.valid();
        if (generation !== this.generation) throw new Error('本轮已取消');
        // 预连接失败由正式请求重试；普通轮次取消仍允许复用已开始的握手。
        if (this.preparing) await new Promise<void>((resolve, reject) => {
            const cancel = () => {
                if (this.cancelCurrent === cancel) this.cancelCurrent = null;
                reject(new Error('本轮已取消'));
            };
            const done = () => {
                if (this.cancelCurrent === cancel) this.cancelCurrent = null;
                resolve();
            };
            this.cancelCurrent = cancel;
            void this.preparing!.then(done, done);
        });
        if (generation !== this.generation) throw new Error('本轮已取消');
        for (let attempt = 0; attempt < 2; attempt++) {
            try { return await this.connect(text, account, events, generation); }
            catch (error) {
                if (generation !== this.generation) throw new Error('本轮已取消');
                if (!(error instanceof AuthError) || attempt > 0) throw error;
                account = await this.auth.valid(account.token);
                if (generation !== this.generation) throw new Error('本轮已取消');
            }
        }
        throw new Error('AI 连接失败');
    }

    private connect(text: string, account: Session, events: ConversationEvents, generation: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = this.auth.config.origin.replace(/^https:/, 'wss:') + '/mexusclaw-socket';
            if (this.idle && !this.matchesIdle(account)) this.closeIdle();
            const reused = this.idle;
            this.idle = null;
            reused?.stop();
            const socket = reused?.socket ?? this.socketFactory(url);
            const requestId = `px-${this.now()}-${generation}`;
            const startedAt = this.now();
            let sentAt = startedAt;
            let firstChunk = true;
            let deltaCount = 0;
            let textDeltaCount = 0;
            let sid = reused?.sid ?? '';
            let answer = '';
            let sequence = -1;
            let terminal = false;
            let ready = !!reused;
            let lastFrameAt = this.now();
            const clear = (keep: boolean) => {
                clearTimeout(welcomeTimer); clearTimeout(turnTimer); clearInterval(heartbeat);
                socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
                if (keep && ready && socket.readyState === 1) this.keepIdle(socket, account, sid);
                else { try { socket.close(1000, 'turn_end'); } catch { } }
                if (this.cancelCurrent === cancel) this.cancelCurrent = null;
            };
            const finish = (error?: Error, value?: string, keep = !error) => {
                if (terminal) return;
                terminal = true;
                clear(keep);
                if (error) reject(error); else resolve(value ?? answer);
            };
            const send = (frame: Frame) => {
                if (terminal || generation !== this.generation) return;
                try { socket.send(JSON.stringify(frame)); }
                catch { finish(new Error('AI 连接已中断')); }
            };
            const cancel = () => {
                let keep = ready;
                if (ready && socket.readyState === 1) {
                    try { socket.send(JSON.stringify(envelope('cancel', requestId, sid, { requestId }, this.now()))); }
                    catch { keep = false; }
                }
                finish(new Error('本轮已取消'), undefined, keep);
            };
            const welcomeTimer = setTimeout(() => finish(new Error('AI 握手超时')), 15000);
            const turnTimer = setTimeout(() => finish(new Error('AI 响应超时，请重试')), 60000);
            const heartbeat = setInterval(() => {
                if (this.now() - lastFrameAt > 45000) { finish(new Error('AI 连接超时')); return; }
                if (ready) send(envelope('ping', '', sid, { nonce: `${this.now()}` }, this.now()));
            }, 15000);
            this.cancelCurrent = cancel;
            socket.onopen = () => send(hello(account, this.auth.config.deviceId, this.now()));
            socket.onerror = () => finish(new Error('AI 网络连接失败'));
            socket.onclose = () => finish(new Error('AI 连接已结束，请重试'));
            socket.onmessage = (event) => {
                if (terminal || generation !== this.generation || typeof event.data !== 'string') return;
                if (event.data.length > 65536) { finish(new Error('AI 响应过大')); return; }
                let frame: Record<string, unknown>;
                try { frame = record(JSON.parse(event.data)); } catch { finish(new Error('AI 消息格式错误')); return; }
                if (frame.v !== 1) return;
                const payload = record(frame.payload);
                const type = string(frame.type);
                lastFrameAt = this.now();
                if (type === 'ping') { send(envelope('pong', string(frame.id), sid, { nonce: string(payload.nonce) }, this.now())); return; }
                if (type === 'welcome' && !ready) {
                    sid = string(payload.sessionId);
                    if (!sid) { finish(new Error('AI 服务未下发会话标识')); return; }
                    ready = true;
                    clearTimeout(welcomeTimer);
                    console.log(`[harness.ai] ready=${this.now() - startedAt}ms reused=false`);
                    sentAt = this.now();
                    send(envelope('user.turn', requestId, sid, { requestId, text, locale: 'zh-CN' }, this.now()));
                    return;
                }
                if (type === 'error' || type === 'assistant.error') {
                    if (ready && string(payload.requestId) && payload.requestId !== requestId) return;
                    const authFailure = [1100, 1101, 401, 20401].includes(Number(payload.code));
                    finish(authFailure && !answer ? new AuthError(401, 'AI 登录凭据已过期') : new Error('AI 服务暂时不可用'));
                    return;
                }
                if (!ready) return;
                if (type === 'edge.invoke') {
                    send(envelope('edge.result', string(payload.callId), sid,
                        { callId: string(payload.callId), status: 'error', result: {}, error: 'device_capability_unavailable' }, this.now()));
                    return;
                }
                if (payload.requestId !== requestId) return;
                if (type === 'assistant.delta') {
                    deltaCount++;
                    if (typeof payload.textChunk === 'string' && payload.textChunk.length) textDeltaCount++;
                    // 只记录协议形状和长度，定位服务端未发文字与设备拒收的区别。
                    if (deltaCount <= 2) console.log(`[harness.ai] delta seq=${Number(payload.seq)} chars=${typeof payload.textChunk === 'string' ? payload.textChunk.length : 0} effect=${Boolean(payload.visualEffect)}`);
                    const effect = record(payload.visualEffect);
                    const params = record(effect.params);
                    const label = string(params.displayName) || string(params.name);
                    if (label) events.progress(label.slice(0, 300));
                    const chunk = typeof payload.textChunk === 'string' ? payload.textChunk : '';
                    const incomingSequence = Number(payload.seq);
                    if (!chunk || !Number.isSafeInteger(incomingSequence) || incomingSequence <= sequence) return;
                    sequence = incomingSequence;
                    if (firstChunk) {
                        firstChunk = false;
                        console.log(`[harness.ai] first-text=${this.now() - sentAt}ms`);
                    }
                    if (answer.length + chunk.length > 12000) { finish(new Error('回答超出设备显示范围，请缩小问题')); return; }
                    answer += chunk;
                    events.answer(answer);
                } else if (type === 'assistant.done') {
                    console.log(`[harness.ai] done=${this.now() - sentAt}ms deltas=${deltaCount} text-deltas=${textDeltaCount}`);
                    const final = typeof payload.finalText === 'string' && payload.finalText.trim() ? payload.finalText : answer;
                    if (final.length > 12000) { finish(new Error('回答过长，请缩小问题')); return; }
                    events.answer(final);
                    finish(undefined, final);
                }
            };
            if (reused) {
                clearTimeout(welcomeTimer);
                console.log('[harness.ai] ready=0ms reused=true');
                sentAt = this.now();
                send(envelope('user.turn', requestId, sid, { requestId, text, locale: 'zh-CN' }, this.now()));
            }
        });
    }
}
