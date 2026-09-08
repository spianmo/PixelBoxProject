export interface WakewordConfig { phrase: string; pinyin: string; threshold: number }

/** 业务应用注册的唤醒配置；改词或调门限只需重新下发应用 JS。 */
export const WAKEWORD_CONFIG: Readonly<WakewordConfig> = {
    phrase: '你好小川',
    pinyin: 'ni hao xiao chuan',
    threshold: 0.30,
};
