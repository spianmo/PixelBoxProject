import { record, validateOrigin, type ServerConfig, type Session, type SessionStore } from './auth';

type Kv = Pick<PxStorage['kv'], 'get' | 'set'>;

export class LocalAuthStore implements SessionStore {
    private readonly scope: string;
    constructor(private readonly kv: Kv, config: ServerConfig) {
        this.scope = JSON.stringify([validateOrigin(config.origin), config.oem, config.domain, config.deviceId]);
    }

    private read(key: string): Record<string, unknown> {
        try {
            const raw = this.kv.get(key);
            if (!raw || raw.length > 32768) return {};
            const value = record(JSON.parse(raw));
            return value.version === 1 && value.scope === this.scope ? value : {};
        } catch { return {}; }
    }

    load(): Session | null {
        const value = record(this.read('h.session').session);
        const fields = ['token', 'refreshToken', 'userId', 'tenantId', 'tenantCode', 'userCode', 'nickname'];
        if (fields.some(key => typeof value[key] !== 'string')) return null;
        if (!value.token || !value.refreshToken || String(value.token).length > 12000 || String(value.refreshToken).length > 12000) return null;
        if (['userId', 'tenantId'].some(key => !/^\d{1,20}$/.test(String(value[key])) || /^0+$/.test(String(value[key])))) return null;
        if (!/^[A-Z0-9]{6}$/.test(String(value.tenantCode)) || !/^[A-Z0-9]{6}$/.test(String(value.userCode))) return null;
        for (const key of ['expiresIn', 'refreshTokenExpiresIn', 'issuedAt']) {
            if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Number(value[key]) < 0) return null;
        }
        return value as unknown as Session;
    }

    save(session: Session | null): void {
        this.kv.set('h.session', JSON.stringify({ version: 1, scope: this.scope, session }));
    }

    password(tenant: string, account: string): string {
        const value = this.read('h.credentials');
        return value.tenant === tenant.trim().toUpperCase() && value.account === account.trim().toUpperCase()
            && typeof value.password === 'string' && value.password.length <= 128 ? value.password : '';
    }

    remember(tenant: string, account: string, password: string): void {
        tenant = tenant.trim().toUpperCase(); account = account.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(tenant) || !/^[A-Z0-9]{6}$/.test(account) || !password || password.length > 128) return;
        this.kv.set('h.credentials', JSON.stringify({ version: 1, scope: this.scope, tenant, account, password }));
        this.kv.set('h.tenant', tenant);
        this.kv.set('h.account', account);
    }
}
