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

export function validateOrigin(raw: string): string {
    const origin = raw.trim().replace(/\/+$/, '');
    // 仅配置 HTTPS 源，不接受用户信息、路径、查询串或不可见字符。
    if (!/^https:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d{1,5})?$/.test(origin))
        throw new AuthError(0, '服务地址须为 HTTPS 域名');
    return origin;
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

export class EnterpriseAuth {
    private session: Session | null = null;
    private epoch = 0;
    private refreshing: Promise<Session> | null = null;
    readonly config: ServerConfig;

    constructor(config: ServerConfig, private readonly request: Fetcher = fetch, private readonly now: () => number = () => Date.now()) {
        this.config = { ...config, origin: validateOrigin(config.origin) };
    }

    current(): Session | null { return this.session; }
    clear(): void { this.epoch++; this.session = null; this.refreshing = null; }

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
        } catch { throw new AuthError(0, '服务连接失败，请检查 Wi-Fi 和服务地址'); }
        if (response.url && !response.url.startsWith(this.config.origin + '/')) throw new AuthError(0, '服务返回了其他地址');
        // 反向代理可能用 HTML/空正文返回鉴权失败，HTTP 身份状态不能被 JSON 解析错误覆盖。
        if (response.status === 401 || response.status === 403) throw new AuthError(response.status, '登录已过期，请重新登录');
        const raw = await response.text();
        if (raw.length > 65536) throw new AuthError(0, '服务响应过大');
        let envelope: Record<string, unknown>;
        try {
            // V4 的 64 位企业/用户 ID 不能先转为 JS Number 再补字符串。
            envelope = record(parse(raw, undefined, { parseNumber: (value) => isSafeNumber(value) ? Number(value) : value }));
        } catch { throw new AuthError(0, '服务响应格式错误'); }
        const code = Number(envelope.code ?? response.status);
        if (!response.ok || envelope.success === false || code < 200 || code >= 300)
            throw new AuthError(code, code === 401 || code === 20401 ? '登录已过期，请重新登录' : '企业认证失败，请检查账号和密码');
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
        this.session = selected;
        return selected;
    }

    async valid(rejectedToken = ''): Promise<Session> {
        const current = this.session;
        if (!current) throw new AuthError(401, '请先登录企业账号');
        const age = this.now() - current.issuedAt;
        if (current.refreshTokenExpiresIn > 0 && age >= current.refreshTokenExpiresIn * 1000) { this.clear(); throw new AuthError(401, '登录已过期，请重新登录'); }
        if ((!rejectedToken || rejectedToken !== current.token) && (current.expiresIn === 0 || age < Math.max(0, current.expiresIn - 60) * 1000)) return current;
        if (this.refreshing) return this.refreshing;
        const epoch = this.epoch;
        const refresh = (async () => {
            try {
                const next = parseSession(await this.api('/api/meeting/user/refreshToken', { refresh_token: current.refreshToken }),
                    current.tenantCode, current.userCode, this.now(), current);
                if (epoch !== this.epoch) throw new AuthError(401, '登录已退出');
                if (next.tenantId !== current.tenantId || next.userId !== current.userId) { this.clear(); throw new AuthError(401, '登录身份发生变化'); }
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
