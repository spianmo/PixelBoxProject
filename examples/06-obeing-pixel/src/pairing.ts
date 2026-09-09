export interface SavedPairing { phoneId: string; pairKey: string }
const KEY = 'ob.pairing';

export function parsePairing(value: unknown): SavedPairing | null {
    if (!value || typeof value !== 'object') return null;
    const pair = value as Record<string, unknown>;
    return typeof pair.phoneId === 'string' && /^[0-9a-f-]{36}$/.test(pair.phoneId)
        && typeof pair.pairKey === 'string' && /^[0-9a-f]{64}$/.test(pair.pairKey)
        ? { phoneId: pair.phoneId, pairKey: pair.pairKey } : null;
}

export function loadPairing(): SavedPairing | null {
    try { return parsePairing(JSON.parse(String(px.storage.kv.get(KEY) || 'null'))); }
    catch { return null; }
}

export function savePairing(pair: SavedPairing | null): void {
    // 只保存设备恢复密钥；企业账号、口令和云端 token 始终留在手机。
    if (pair) px.storage.kv.set(KEY, JSON.stringify(pair));
    else px.storage.kv.remove(KEY);
}
