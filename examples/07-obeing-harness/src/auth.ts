import { isSafeNumber, parse } from 'lossless-json';

export interface Session {
    token: string;
    refreshToken: string;
    expiresIn: number;
    refreshTokenExpiresIn: number;
    issuedAt: number;
    userId: string;
    tenantId: string;
    tenantCode: string;
    userCode: string;
    nickname: string;
}

export interface ServerConfig { origin: string; oem: string; domain: string; deviceId: string }
export interface SessionStore { load(): Session | null; save(session: Session | null): void }
export type Fetcher = (url: string, init?: PxRequestInit) => Promise<PxResponse>;
export class AuthError extends Error {
    constructor(public readonly code: number, message: string) { super(message); }
}

export function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function positive(value: unknown): number { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; }
function identity(value: unknown): string {
    if (typeof value === 'string' && /^\d+$/.test(value) && !/^0+$/.test(value)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (value !== undefined && value !== null && value !== 0 && value !== '') throw new AuthError(0, '企业或用户 ID 格式无效');
    return '';
}

function httpsOrigin(value: string): string | null {
    // QuickJS firmware has no URL global. Limit authority syntax to the DNS/IPv4
    // HTTPS origins accepted by server settings; never normalize userinfo or backslashes.
    if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
    const match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?=[/?#]|$)/i.exec(value);
    if (!match) return null;
    const port = match[2] === undefined ? 443 : Number(match[2]);
    if (port < 1 || port > 65535) return null;
    return `https://${match[1].toLowerCase()}${port === 443 ? '' : ':' + port}`;
}

export function isSameServiceOrigin(url: string, origin: string): boolean {
    const actual = httpsOrigin(url);
    return actual !== null && actual === httpsOrigin(origin);
}

export function validateOrigin(raw: string): string {
    const origin = raw.trim().replace(/\/+$/, '');
    // 仅配置 HTTPS 源，不接受用户信息、路径、查询串或不可见字符。
    const normalized = httpsOrigin(origin);
    if (!/^https:\/\/[^/?#]+$/i.test(origin) || normalized === null)
        throw new AuthError(0, '服务地址须为 HTTPS 域名');
    return normalized;
}

export function parseSession(data: unknown, tenantCode: string, userCode: string, now: number, previous?: Session): Session {
    const value = record(data);
    const nested = record(value.userSession);
    const session = {
        token: (string(value.token) || string(value.accessToken)).replace(/^Bearer\s+/i, ''),
        refreshToken: string(value.refreshToken),
        expiresIn: positive(value.expiresIn), refreshTokenExpiresIn: positive(value.refreshTokenExpiresIn), issuedAt: now,
        userId: identity(nested.userId ?? value.userId) || previous?.userId || '',
        tenantId: identity(nested.tenantId ?? value.tenantId) || previous?.tenantId || '',
        tenantCode: string(value.tenantCode) || tenantCode, userCode: string(value.userCode) || userCode,
        nickname: string(value.nickname) || previous?.nickname || '',
    };
    if (!session.token || !session.refreshToken) throw new AuthError(0, '登录响应缺少完整凭据');
    return session;
}

function failureDetail(envelope: Record<string, unknown>): string {
    // 只显示结构完整的业务错误；已知英文错误先映射，避免回显账号或凭据。
    const code = Number(envelope.code);
    const message = string(envelope.msg);
    if (Object.prototype.hasOwnProperty.call(envelope, 'data') && Number.isInteger(code) && code >= 300
        && (message === 'invalid userCode or password' || string(envelope.message) === 'invalid userCode or password'))
        return '账号或密码错误';
    if (!Object.prototype.hasOwnProperty.call(envelope, 'data') || !Number.isInteger(code) || code < 300
        || message.length < 2 || message.length > 36 || !/[\u3400-\u9fff]{2}/.test(message)
        || (message !== '该企业内无此用户ID' && !/^[\u3400-\u9fff，。！？：；、（） 0-9]+$/.test(message))
        || /\d{3,}/.test(message)
        || /密码[为是]|验证码[为是]|密钥|令牌/.test(message)) return '';
    return message;
}

function requestFailure(path: string, code: number, detail = ''): string {
    // 首次登录尚无会话；只有刷新凭据被拒绝才属于登录过期。
    const denied = [401, 403, 20401].includes(code);
    if (path === '/basestation/api/workbench/user/ucenter/login')
        return `基站登录${denied ? '被拒绝' : '失败'} ${code}${detail ? `：${detail}` : denied ? '，请核对账号密码或服务设置' : '，请稍后重试'}`;
    if (path === '/api/meeting/user/refreshToken')
        return denied ? `登录已过期 ${code}${detail ? `：${detail}` : '，请重新登录'}`
            : `登录状态刷新失败 ${code}${detail ? `：${detail}` : '，请稍后重试'}`;
    const stage = path === '/api/meeting/oauth/appid' ? '获取授权应用'
        : path === '/api/meeting/authorize' ? '获取授权码'
        : path === '/api/meeting/token' ? '换取工作凭据' : '读取用户身份';
    return `${stage}${denied ? '被拒绝' : '失败'} ${code}${detail ? `：${detail}` : denied ? '，请检查账号权限或服务设置' : '，请稍后重试'}`;
}

function parseEnvelope(raw: string): Record<string, unknown> {
    // V4 的 64 位企业/用户 ID 不能先转为 JS Number 再补字符串。
    return record(parse(raw, undefined, { parseNumber: (value) => isSafeNumber(value) ? Number(value) : value }));
}

export class EnterpriseAuth {
    private session: Session | null = null;
    private epoch = 0;
    private refreshing: Promise<Session> | null = null;
    readonly config: ServerConfig;

    constructor(config: ServerConfig, private readonly request: Fetcher = fetch, private readonly now: () => number = () => Date.now(),
        private readonly store?: SessionStore) {
        this.config = { ...config, origin: validateOrigin(config.origin) };
        this.session = store?.load() ?? null;
    }

    current(): Session | null { return this.session; }
    clear(persist = true): void {
        this.epoch++; this.session = null; this.refreshing = null;
        if (persist) this.store?.save(null);
    }

    private async api(path: string, body?: Record<string, unknown>, session?: Session): Promise<unknown> {
        const headers: Record<string, string> = {
            'User-Client': '2', oem: this.config.oem, 'device-brand': 'Obeing', 'device-model': 'PixelBox',
            'device-code': this.config.deviceId, 'device-os': 'ESP32-S3', 'Accept-Language': 'zh-CN',
            Accept: 'application/json', 'Content-Type': 'application/json',
        };
        if (session) { headers.Authorization = `Bearer ${session.token}`; if (session.tenantId) headers['X-Tenant-Id'] = session.tenantId; }
        let response: PxResponse;
        try {
            response = await this.request(this.config.origin + path, { method: body ? 'POST' : 'GET', headers,
                body: body ? JSON.stringify(body) : undefined, timeoutMs: 15000, redirect: 'error' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('NETWORK_WORKER_ALLOC_FAILED'))
                throw new AuthError(0, '网络线程内存不足，请更新固件后重启');
            if (/TLS_ALLOC_FAILED|(?:-0x7f00|mbedtls=-32512)\b/i.test(message))
                throw new AuthError(0, '设备 TLS 内存不足，请更新固件');
            throw new AuthError(0, '服务连接失败，请检查 Wi-Fi 和服务地址');
        }
        if (response.url && !isSameServiceOrigin(response.url, this.config.origin)) throw new AuthError(0, '服务返回了其他地址');
        // 反向代理可能用 HTML/空正文返回鉴权失败，HTTP 状态始终优先于正文读取及解析错误。
        if (response.status === 401 || response.status === 403) {
            let detail = '';
            try {
                const raw = await response.text();
                if (raw.length <= 65536) detail = failureDetail(parseEnvelope(raw));
            } catch { /* 保留 HTTP 身份状态及通用提示。 */ }
            throw new AuthError(response.status, requestFailure(path, response.status, detail));
        }
        const raw = await response.text();
        if (raw.length > 65536) throw new AuthError(0, '服务响应过大');
        let envelope: Record<string, unknown>;
        try {
            envelope = parseEnvelope(raw);
        } catch { throw new AuthError(0, '服务响应格式错误'); }
        const code = Number(envelope.code ?? response.status);
        if (!response.ok || envelope.success === false || !Number.isFinite(code) || code < 200 || code >= 300) {
            const failureCode = Number.isFinite(code) ? code : response.status;
            throw new AuthError(failureCode, requestFailure(path, failureCode, failureDetail(envelope)));
        }
        return envelope.data;
    }

    async login(tenantRaw: string, userRaw: string, password: string): Promise<Session> {
        this.clear();
        const epoch = this.epoch;
        const tenant = tenantRaw.trim().toUpperCase();
        const user = userRaw.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(tenant) || !/^[A-Z0-9]{6}$/.test(user)) throw new AuthError(400, '企业 ID 和账号须为 6 位字母或数字');
        if (!password || password.length > 128) throw new AuthError(400, '请输入有效密码');
        const active = () => { if (epoch !== this.epoch) throw new AuthError(0, '登录已取消'); };
        // 对齐手机 V4：基站登录 -> OAuth appid -> authorize -> 工作 token -> user/info。
        const base = parseSession(await this.api('/basestation/api/workbench/user/ucenter/login',
            { tenantCode: tenant, userCode: user, password, domain: this.config.domain }), tenant, user, this.now());
        active();
        const appid = string(record(await this.api('/api/meeting/oauth/appid', undefined, base)).appid);
        active();
        if (!appid) throw new AuthError(0, '服务未下发 OAuth 应用');
        const code = string(record(await this.api('/api/meeting/authorize', { appid, state: `${this.config.deviceId}-${this.now()}` }, base)).code);
        active();
        if (!code) throw new AuthError(0, '服务未下发授权码');
        const work = parseSession(await this.api('/api/meeting/token', { code }), tenant, user, this.now(), base);
        active();
        let selected = work;
        let info: unknown;
        try { info = await this.api('/api/meeting/user/info', undefined, work); }
        catch (error) {
            active();
            if (!(error instanceof AuthError) || ![401, 403, 20401].includes(error.code)) throw error;
            selected = base;
            info = await this.api('/api/meeting/user/info', undefined, base);
        }
        active();
        const profile = record(info);
        selected = { ...selected, userId: identity(profile.userId) || selected.userId,
            tenantId: identity(profile.tenantId) || selected.tenantId,
            nickname: string(profile.nickname) || string(profile.name) || selected.nickname };
        if (!selected.userId || !selected.tenantId) throw new AuthError(0, '登录身份不完整');
        this.store?.save(selected);
        this.session = selected;
        return selected;
    }

    async valid(rejectedToken = ''): Promise<Session> {
        const current = this.session;
        if (!current) throw new AuthError(401, '请先登录企业账号');
        const age = this.now() - current.issuedAt;
        if (current.refreshTokenExpiresIn > 0 && age >= current.refreshTokenExpiresIn * 1000) { this.clear(); throw new AuthError(401, '登录已过期，请重新登录'); }
        if (age >= 0 && (!rejectedToken || rejectedToken !== current.token) && (current.expiresIn === 0 || age < Math.max(0, current.expiresIn - 60) * 1000)) return current;
        if (this.refreshing) return this.refreshing;
        const epoch = this.epoch;
        const refresh = (async () => {
            try {
                const next = parseSession(await this.api('/api/meeting/user/refreshToken', { refresh_token: current.refreshToken }),
                    current.tenantCode, current.userCode, this.now(), current);
                if (epoch !== this.epoch) throw new AuthError(401, '登录已退出');
                if (next.tenantId !== current.tenantId || next.userId !== current.userId) { this.clear(); throw new AuthError(401, '登录身份发生变化'); }
                this.store?.save(next);
                this.session = next;
                return next;
            } catch (error) {
                if (error instanceof AuthError && [401, 403, 20401].includes(error.code) && epoch === this.epoch) this.clear();
                throw error;
            } finally { if (epoch === this.epoch) this.refreshing = null; }
        })();
        this.refreshing = refresh;
        return refresh;
    }
}
